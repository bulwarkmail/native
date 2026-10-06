// Whether the mail server answered the last round trip, relayed from the
// transport (api/jmap-client, blob uploads, the event stream) to the network
// store. The store registers itself as the sink; this module imports neither,
// so the store never imports the client and there is no import cycle.
//
// "Answered" means any HTTP response, whatever its status. "Unreachable" means
// a transport failure: `NetworkError`, a fetch `TypeError` or
// `RequestTimeoutError`. A caller's own abort says nothing about the server.

export interface ServerReachabilitySink {
  response(): void;
  unreachable(): void;
}

let sink: ServerReachabilitySink | null = null;

export function setServerReachabilitySink(next: ServerReachabilitySink | null): void {
  sink = next;
}

export function reportServerResponse(): void {
  sink?.response();
}

export function reportServerUnreachable(): void {
  sink?.unreachable();
}

const TRANSPORT_FAILURES = new Set(['NetworkError', 'TypeError', 'RequestTimeoutError']);

/** True for an error that means the request never got a response. */
export function isTransportFailure(err: unknown): boolean {
  return err instanceof Error && TRANSPORT_FAILURES.has(err.name);
}

/**
 * Report how a fetch to the mail server settled, then pass its result or error
 * through unchanged. `signal` is the caller's own abort signal, if any.
 * `stillCurrent` says whether the connection the fetch was made on is still
 * the app's active one; a superseded connection's fetch reports nothing.
 */
export async function observeServerFetch<T>(
  request: Promise<T>,
  signal?: AbortSignal | null,
  stillCurrent: () => boolean = () => true,
): Promise<T> {
  try {
    const response = await request;
    if (stillCurrent()) reportServerResponse();
    return response;
  } catch (err) {
    if (!signal?.aborted && isTransportFailure(err) && stillCurrent()) reportServerUnreachable();
    throw err;
  }
}
