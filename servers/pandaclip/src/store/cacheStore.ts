import { openDb, type DB, newId } from "@vektorgeist/panda-core";
import { createHash } from "node:crypto";

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE entries (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text/plain',
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        hits INTEGER NOT NULL DEFAULT 0,
        last_hit INTEGER,
        size INTEGER NOT NULL,
        PRIMARY KEY (namespace, key)
      );
      CREATE INDEX idx_entries_expiry ON entries(expires_at) WHERE expires_at IS NOT NULL;
      CREATE TABLE namespaces (
        name TEXT PRIMARY KEY,
        default_ttl INTEGER,
        max_bytes INTEGER
      );
    `,
  },
];

export interface CacheHit {
  value: string;
  contentType: string;
  createdAt: number;
  expiresAt: number | null;
  hits: number;
}

export class CacheStore {
  private db: DB;

  constructor(dbFile = "cache.db") {
    this.db = openDb("cache", dbFile, MIGRATIONS);
  }

  /** Delete expired rows. Called lazily on writes. */
  sweep(now = Date.now()): number {
    return this.db
      .prepare(`DELETE FROM entries WHERE expires_at IS NOT NULL AND expires_at <= ?`)
      .run(now).changes;
  }

  set(
    namespace: string,
    key: string,
    value: string,
    opts: { ttlSeconds?: number; contentType?: string } = {},
  ): void {
    const now = Date.now();
    this.sweep(now);
    const ns = this.db
      .prepare(`SELECT default_ttl FROM namespaces WHERE name = ?`)
      .get(namespace) as { default_ttl: number | null } | undefined;
    const ttl = opts.ttlSeconds ?? ns?.default_ttl ?? null;
    const expiresAt = ttl == null ? null : now + ttl * 1000;
    this.db
      .prepare(
        `INSERT INTO entries (namespace, key, value, content_type, created_at, expires_at, size)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(namespace, key) DO UPDATE SET
           value = excluded.value, content_type = excluded.content_type,
           created_at = excluded.created_at, expires_at = excluded.expires_at,
           size = excluded.size, hits = 0, last_hit = NULL`,
      )
      .run(namespace, key, value, opts.contentType ?? "text/plain", now, expiresAt, Buffer.byteLength(value));
  }

  get(namespace: string, key: string): CacheHit | null {
    const now = Date.now();
    const row = this.db
      .prepare(
        `SELECT value, content_type, created_at, expires_at, hits FROM entries
         WHERE namespace = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(namespace, key, now) as
      | { value: string; content_type: string; created_at: number; expires_at: number | null; hits: number }
      | undefined;
    if (!row) return null;
    this.db
      .prepare(`UPDATE entries SET hits = hits + 1, last_hit = ? WHERE namespace = ? AND key = ?`)
      .run(now, namespace, key);
    return {
      value: row.value,
      contentType: row.content_type,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      hits: row.hits + 1,
    };
  }

  /** Invalidate by exact key or key prefix. Returns rows removed. */
  invalidate(namespace: string, opts: { key?: string; prefix?: string }): number {
    if (opts.key != null) {
      return this.db
        .prepare(`DELETE FROM entries WHERE namespace = ? AND key = ?`)
        .run(namespace, opts.key).changes;
    }
    if (opts.prefix != null) {
      return this.db
        .prepare(`DELETE FROM entries WHERE namespace = ? AND key GLOB ?`)
        .run(namespace, opts.prefix.replace(/[[\]*?]/g, "[$&]") + "*").changes;
    }
    throw new Error("invalidate requires key or prefix");
  }

  flush(namespace: string): number {
    return this.db.prepare(`DELETE FROM entries WHERE namespace = ?`).run(namespace).changes;
  }

  configureNamespace(name: string, opts: { defaultTtlSeconds?: number | null; maxBytes?: number | null }): void {
    this.db
      .prepare(
        `INSERT INTO namespaces (name, default_ttl, max_bytes) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET default_ttl = excluded.default_ttl, max_bytes = excluded.max_bytes`,
      )
      .run(name, opts.defaultTtlSeconds ?? null, opts.maxBytes ?? null);
  }

  stats(namespace?: string): unknown {
    this.sweep();
    const where = namespace ? `WHERE namespace = ?` : ``;
    const args = namespace ? [namespace] : [];
    return this.db
      .prepare(
        `SELECT namespace, COUNT(*) AS entries, SUM(size) AS bytes, SUM(hits) AS total_hits
         FROM entries ${where} GROUP BY namespace ORDER BY namespace`,
      )
      .all(...args);
  }

  close(): void {
    this.db.close();
  }
}

/** Canonical cache key from arbitrary JSON: sorted-key SHA-256. */
export function hashKey(payload: unknown): string {
  const canon = JSON.stringify(payload, (_k, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
  return createHash("sha256").update(canon).digest("hex");
}

export { newId };
