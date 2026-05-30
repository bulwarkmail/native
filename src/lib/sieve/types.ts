// Sieve filter data model. Ported from the webmail's lib/jmap/sieve-types.ts so
// the generated scripts round-trip byte-for-byte between the two clients (a
// rule authored on the web reads back as a structured rule on mobile and vice
// versa, because both embed the same `@metadata` JSON block).

export interface SieveScript {
  id: string;
  name: string;
  blobId: string;
  isActive: boolean;
}

export interface SieveCapabilities {
  implementation: string;
  maxSizeScript: number;
  sieveExtensions: string[];
  notificationMethods: string[];
  externalLists: string[];
}

export type FilterConditionField = 'from' | 'to' | 'cc' | 'subject' | 'header' | 'size' | 'body';

export type FilterComparator =
  | 'contains' | 'not_contains'
  | 'is' | 'not_is'
  | 'starts_with' | 'ends_with'
  | 'matches'
  | 'greater_than' | 'less_than';

export type FilterActionType =
  | 'move' | 'copy' | 'forward'
  | 'mark_read' | 'star' | 'add_label'
  | 'discard' | 'reject' | 'keep' | 'stop';

export interface FilterCondition {
  field: FilterConditionField;
  comparator: FilterComparator;
  value: string;
  headerName?: string;
}

export interface FilterAction {
  type: FilterActionType;
  value?: string;
}

export type FilterOrigin = 'bulwark' | 'external' | 'opaque';

export interface FilterRule {
  id: string;
  name: string;
  enabled: boolean;
  matchType: 'all' | 'any';
  conditions: FilterCondition[];
  actions: FilterAction[];
  stopProcessing: boolean;
  origin?: FilterOrigin;
  originLabel?: string;
  rawBlock?: string;
}

export interface VacationSieveConfig {
  isEnabled: boolean;
  subject: string;
  textBody: string;
}

export interface FilterMetadata {
  version: 1;
  rules: FilterRule[];
  vacation?: VacationSieveConfig;
}
