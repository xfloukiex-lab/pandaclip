import { openDb, type DB, newId } from "@panda-mcp/core";

const MAX_ENTRY_BYTES = 1_000_000;

const TTL_MS: Record<string, number | null> = {
  ephemeral: 24 * 3600 * 1000,
  session: 7 * 24 * 3600 * 1000,
  pinned: null,
};

// Screen obvious credential material before it lands in history.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{20,}\b/, // provider-style API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\b/, // JWT
  /\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{8,}/i,
];

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text/plain',
        label TEXT,
        source TEXT,
        channel TEXT,
        snippet_name TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        pinned INTEGER NOT NULL DEFAULT 0,
        consumed_at INTEGER
      );
      CREATE INDEX idx_entries_channel ON entries(channel) WHERE channel IS NOT NULL;
      CREATE TABLE tags (
        entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (entry_id, tag)
      );
    `,
  },
];

export interface ClipEntry {
  id: string;
  content: string;
  content_type: string;
  label: string | null;
  source: string | null;
  channel: string | null;
  snippet_name: string | null;
  created_at: number;
  expires_at: number | null;
  pinned: number;
  tags?: string[];
}

export class ClipStore {
  private db: DB;

  constructor(dbFile = "clip.db") {
    this.db = openDb("clipboard", dbFile, MIGRATIONS);
  }

  sweep(now = Date.now()): number {
    const stale = this.db
      .prepare(`SELECT id FROM entries WHERE expires_at IS NOT NULL AND expires_at <= ? AND pinned = 0`)
      .all(now) as Array<{ id: string }>;
    for (const { id } of stale) this.deleteById(id);
    return stale.length;
  }

  /** Returns matched secret-pattern indexes (empty = clean). */
  screenSecrets(content: string): number[] {
    return SECRET_PATTERNS.flatMap((p, i) => (p.test(content) ? [i] : []));
  }

  push(opts: {
    content: string;
    contentType?: string;
    label?: string;
    source?: string;
    channel?: string;
    ttlClass?: "ephemeral" | "session" | "pinned";
    tags?: string[];
    snippetName?: string;
  }): ClipEntry {
    if (Buffer.byteLength(opts.content) > MAX_ENTRY_BYTES) {
      throw new Error(`entry exceeds ${MAX_ENTRY_BYTES} bytes`);
    }
    if (this.screenSecrets(opts.content).length > 0) {
      throw new Error("content looks like credential material (key/token/password pattern) — refused");
    }
    const now = Date.now();
    this.sweep(now);
    const ttlClass = opts.snippetName ? "pinned" : (opts.ttlClass ?? "ephemeral");
    const ttl = TTL_MS[ttlClass];
    if (ttl === undefined) throw new Error(`unknown ttl_class: ${ttlClass}`);
    const id = newId();
    if (opts.snippetName) {
      const prev = this.db
        .prepare(`SELECT id FROM entries WHERE snippet_name = ?`)
        .get(opts.snippetName) as { id: string } | undefined;
      if (prev) this.deleteById(prev.id);
    }
    this.db
      .prepare(
        `INSERT INTO entries (id, content, content_type, label, source, channel, snippet_name, created_at, expires_at, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.content,
        opts.contentType ?? "text/plain",
        opts.label ?? null,
        opts.source ?? null,
        opts.channel ?? null,
        opts.snippetName ?? null,
        now,
        ttl == null ? null : now + ttl,
        ttlClass === "pinned" ? 1 : 0,
      );
    for (const tag of opts.tags ?? []) {
      this.db.prepare(`INSERT OR IGNORE INTO tags (entry_id, tag) VALUES (?, ?)`).run(id, tag);
    }
    return this.get(id)!;
  }

  get(id: string): ClipEntry | null {
    const row = this.db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id) as ClipEntry | undefined;
    if (!row) return null;
    row.tags = (this.db.prepare(`SELECT tag FROM tags WHERE entry_id = ?`).all(id) as Array<{ tag: string }>).map(
      (t) => t.tag,
    );
    return row;
  }

  getSnippet(name: string): ClipEntry | null {
    const row = this.db.prepare(`SELECT id FROM entries WHERE snippet_name = ?`).get(name) as
      | { id: string }
      | undefined;
    return row ? this.get(row.id) : null;
  }

  listSnippets(): Array<{ snippet_name: string; label: string | null; created_at: number }> {
    return this.db
      .prepare(`SELECT snippet_name, label, created_at FROM entries WHERE snippet_name IS NOT NULL ORDER BY snippet_name`)
      .all() as Array<{ snippet_name: string; label: string | null; created_at: number }>;
  }

  history(opts: { channel?: string; tag?: string; contains?: string; limit?: number; offset?: number } = {}): ClipEntry[] {
    this.sweep();
    const limit = Math.min(opts.limit ?? 20, 200);
    const clauses: string[] = ["e.snippet_name IS NULL", "e.consumed_at IS NULL"];
    const args: unknown[] = [];
    if (opts.channel != null) {
      clauses.push("e.channel = ?");
      args.push(opts.channel);
    }
    if (opts.tag != null) {
      clauses.push("EXISTS (SELECT 1 FROM tags t WHERE t.entry_id = e.id AND t.tag = ?)");
      args.push(opts.tag);
    }
    if (opts.contains != null) {
      clauses.push("(e.content LIKE ? ESCAPE '\\' OR e.label LIKE ? ESCAPE '\\')");
      const pat = "%" + opts.contains.replace(/[\\%_]/g, "\\$&") + "%";
      args.push(pat, pat);
    }
    const rows = this.db
      .prepare(
        `SELECT e.id FROM entries e WHERE ${clauses.join(" AND ")}
         ORDER BY e.created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, opts.offset ?? 0) as Array<{ id: string }>;
    return rows.map((r) => this.get(r.id)!);
  }

  pin(id: string): boolean {
    return (
      this.db.prepare(`UPDATE entries SET pinned = 1, expires_at = NULL WHERE id = ?`).run(id).changes > 0
    );
  }

  deleteById(id: string): boolean {
    return this.db.prepare(`DELETE FROM entries WHERE id = ?`).run(id).changes > 0;
  }

  /** Channel handoff: peek = read without consuming; take = read + mark consumed. */
  channelPeek(channel: string, limit = 10): ClipEntry[] {
    return this.history({ channel, limit });
  }

  channelTake(channel: string): ClipEntry | null {
    this.sweep();
    const row = this.db
      .prepare(
        `SELECT id FROM entries WHERE channel = ? AND consumed_at IS NULL AND snippet_name IS NULL
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(channel) as { id: string } | undefined;
    if (!row) return null;
    const entry = this.get(row.id);
    this.db.prepare(`UPDATE entries SET consumed_at = ? WHERE id = ?`).run(Date.now(), row.id);
    return entry;
  }

  close(): void {
    this.db.close();
  }
}
