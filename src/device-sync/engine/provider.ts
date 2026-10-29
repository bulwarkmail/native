/**
 * Reads through the provider port as row objects. Every query is scoped to
 * our account by the native side; the SQL stays within the subset the fake
 * provider evaluates (src/device-sync/__tests__/fakes/fake-sql.ts).
 */
import type { ProviderOp, ProviderPort, ProviderTable, Row } from '../types';
import { RunAbort, isPermissionFailure } from './errors';

/** Host parameters per `IN (…)`: well under SQLite's 999. */
const IN_CHUNK = 400;

export class ProviderReader {
  constructor(readonly port: ProviderPort) {}

  async rows(table: ProviderTable, columns: readonly string[], where?: string, args?: Array<string | number>): Promise<Row[]> {
    let result;
    try {
      result = await this.port.query({ table, columns: [...columns], ...(where ? { where, args: args ?? [] } : {}) });
    } catch (error) {
      if (isPermissionFailure(error)) throw new RunAbort('permission', (error as Error).message);
      throw error;
    }
    const { columns: names, rows } = result;
    return rows.map((cells) => {
      const row: Row = {};
      names.forEach((name, i) => {
        row[name] = cells[i] ?? null;
      });
      return row;
    });
  }

  /** Rows whose `column` is one of `values` (in chunks), optionally narrowed by `extra`. */
  async rowsIn(
    table: ProviderTable,
    columns: readonly string[],
    column: string,
    values: ReadonlyArray<string | number>,
    extra?: { where: string; args?: Array<string | number> },
  ): Promise<Row[]> {
    const out: Row[] = [];
    const unique = [...new Set(values)];
    for (let i = 0; i < unique.length; i += IN_CHUNK) {
      const part = unique.slice(i, i + IN_CHUNK);
      const inClause = `${column} IN (${part.map(() => '?').join(', ')})`;
      const where = extra ? `(${inClause}) AND (${extra.where})` : inClause;
      out.push(...(await this.rows(table, columns, where, [...part, ...(extra?.args ?? [])])));
    }
    return out;
  }

  async readSyncState(): Promise<string | null> {
    try {
      return await this.port.readSyncState();
    } catch (error) {
      if (isPermissionFailure(error)) throw new RunAbort('permission', (error as Error).message);
      throw error;
    }
  }
}

export function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

export function flag(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '' && Number(value) !== 0;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : value === null || value === undefined || value === '' ? null : String(value);
}

/** True when an op group writes something (asserts alone change nothing). */
export function hasWrites(ops: readonly ProviderOp[]): boolean {
  return ops.some((op) => op.op !== 'assert');
}
