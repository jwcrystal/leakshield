/**
 * Minimal ambient typings for node:sqlite — stable in Node ≥ 24 (runtime here
 * is Node 26; Bun also implements the node:sqlite interface), but the repo's
 * @types/node 20 predates them. Only the surface used by
 * src/decision/mapping-store.ts is declared. DELETE this file when
 * @types/node is bumped to a version shipping its own node:sqlite types
 * (duplicate declarations would then conflict).
 */
declare module "node:sqlite" {
  interface StatementSync {
    run(...anonymousParameters: unknown[]): { changes: number; lastInsertRowid?: number | bigint };
    get(...anonymousParameters: unknown[]): unknown;
    all(...anonymousParameters: unknown[]): unknown[];
    iterate(...anonymousParameters: unknown[]): IterableIterator<unknown>;
  }

  class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean; enableForeignKeyConstraints?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
