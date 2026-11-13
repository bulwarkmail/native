// An account's Inbox metadata as Stalwart 1.1.0 keeps it, for the settings
// sync tests. The rules were read off a live server (2026-11-13):
// - `metadata` is shared with the Inbox, `privateMetadata` is the user's own,
//   and each has its own limits;
// - a namespace value must be an object;
// - `metadata/<namespace>/<member>` patches one member, and is refused with
//   invalidPatch when the namespace doesn't exist;
// - a namespace holds at most 8192 bytes, an object's metadata 65536 bytes
//   (its private metadata 16384) and 128 namespaces, each refused with invalidProperties and a
//   description that says "exceeds the maximum";
// - an update is applied whole or not at all.

type Call = [string, Record<string, unknown>, string];

const METADATA = 'urn:ietf:params:jmap:metadata';
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export class FakeMetadataServer {
  /** The Inbox's private metadata, where the settings are, by full namespace. */
  metadata: Record<string, Record<string, unknown>> = {};
  /** Its shared metadata (templates, tags). */
  shared: Record<string, Record<string, unknown>> = {};
  /** Every Mailbox/set patch received, in order. */
  patches: Array<Record<string, unknown>> = [];
  requests = 0;
  /** Without it the account advertises no metadata (Stalwart 0.16). */
  supported = true;
  /** Without it the server keeps shared metadata only. */
  privateSupported = true;
  /** Runs before each request; throwing fails it. */
  beforeRequest: null | ((calls: Call[]) => void | Promise<void>) = null;

  constructor(readonly accountId = 'acct', readonly inboxId = 'inbox') {}

  session() {
    const vendor = { supportsVendorNamespaces: true, supportsPrivate: true, namespaces: [], maxDepth: 8 };
    return {
      capabilities: {},
      primaryAccounts: { 'urn:ietf:params:jmap:mail': this.accountId },
      accounts: {
        [this.accountId]: {
          accountCapabilities: {
            'urn:ietf:params:jmap:mail': {},
            ...(this.supported ? { [METADATA]: { dataTypes: { Mailbox: { ...vendor, supportsPrivate: this.privateSupported } } } } : {}),
          },
        },
      },
    };
  }

  /** A Bulwark entry, by its key (`settings.shard.3`). */
  entry(key: string): Record<string, unknown> | undefined {
    return this.metadata[`org.bulwarkmail.${key}`];
  }

  /** Store a Bulwark entry as another device would. */
  put(key: string, value: Record<string, unknown> | null): void {
    if (value === null) delete this.metadata[`org.bulwarkmail.${key}`];
    else this.metadata[`org.bulwarkmail.${key}`] = structuredClone(value);
  }

  async request(calls: Call[]): Promise<{ methodResponses: Call[] }> {
    this.requests += 1;
    await this.beforeRequest?.(calls);
    const methodResponses = calls.map(([name, args, id]): Call => {
      if (name === 'Mailbox/query') return [name, { accountId: args.accountId, ids: [this.inboxId] }, id];
      if (name === 'Mailbox/get') {
        const wanted = (args.properties as string[] | undefined) ?? [];
        return [name, {
          accountId: args.accountId,
          list: [{
            id: this.inboxId,
            ...(wanted.includes('metadata') ? { metadata: structuredClone(this.shared) } : {}),
            ...(wanted.includes('privateMetadata') ? { privateMetadata: structuredClone(this.metadata) } : {}),
          }],
        }, id];
      }
      if (name === 'Mailbox/set') return [name, this.set(args), id];
      return ['error', { type: 'unknownMethod' }, id];
    });
    return { methodResponses };
  }

  private set(args: Record<string, unknown>): Record<string, unknown> {
    const patch = (args.update as Record<string, Record<string, unknown>>)[this.inboxId];
    this.patches.push(structuredClone(patch));
    const next = structuredClone(this.metadata);
    const refuse = (type: string, description: string) => ({ notUpdated: { [this.inboxId]: { type, description } } });
    for (const [path, value] of Object.entries(patch)) {
      const [property, namespace, ...rest] = path.split('/');
      if (property !== 'privateMetadata') return refuse('invalidProperties', `The settings belong in privateMetadata, not ${property}.`);
      if (rest.length === 0) {
        if (value === null) delete next[namespace];
        else if (typeof value !== 'object' || Array.isArray(value)) return refuse('invalidProperties', 'Namespace values must be objects.');
        else next[namespace] = structuredClone(value) as Record<string, unknown>;
        continue;
      }
      if (!next[namespace]) return refuse('invalidPatch', 'The namespace does not exist.');
      const member = rest.join('/').replace(/~1/g, '/').replace(/~0/g, '~');
      if (value === null) delete next[namespace][member];
      else next[namespace][member] = structuredClone(value);
    }
    for (const value of Object.values(next)) {
      const size = bytes(value);
      if (size > 8192) {
        return refuse('invalidProperties', `Metadata value size ${size} exceeds the maximum of 8192 bytes.`);
      }
    }
    const count = Object.keys(next).length;
    if (count > 128) return refuse('invalidProperties', `Metadata entry count ${count} exceeds the maximum of 128.`);
    const total = bytes(next);
    if (total > 16384) return refuse('invalidProperties', `Metadata size ${total} exceeds the maximum of 16384 bytes.`);
    this.metadata = next;
    return { updated: { [this.inboxId]: null } };
  }
}

/** What settings sync uses of a JMAPClient, served by a FakeMetadataServer per registry account. */
export class FakeSyncClient {
  private server: FakeMetadataServer | null = null;
  /** Registry ids loaded, in order, over every instance. */
  static loads: string[] = [];
  /** Set to make loadAccount fail (offline, refused sign-in). */
  static loadError: Error | null = null;
  static servers: Record<string, FakeMetadataServer> = {};

  static reset(): void {
    FakeSyncClient.loads = [];
    FakeSyncClient.loadError = null;
    FakeSyncClient.servers = {};
  }

  async loadAccount(registryId: string): Promise<boolean> {
    FakeSyncClient.loads.push(registryId);
    if (FakeSyncClient.loadError) throw FakeSyncClient.loadError;
    this.server = FakeSyncClient.servers[registryId] ?? null;
    return this.server !== null;
  }

  get isConnected(): boolean {
    return this.server !== null;
  }

  get accountId(): string {
    return this.server!.accountId;
  }

  get currentSession() {
    return this.server?.session() ?? null;
  }

  get serverUrl(): string {
    return `https://${this.server?.accountId}.example.org`;
  }

  get username(): string {
    return 'user';
  }

  request(calls: Call[]) {
    return this.server!.request(calls);
  }
}
