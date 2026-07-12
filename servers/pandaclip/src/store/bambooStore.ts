import fs from "node:fs";
import path from "node:path";
import { openDb, type DB, newId } from "@panda-mcp/core";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "__pycache__", ".venv", "venv"]);
const MAX_SCAN_ENTRIES = 20_000;

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        root_path TEXT NOT NULL,
        description TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        rel_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        notes TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        missing INTEGER NOT NULL DEFAULT 0,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        UNIQUE (workspace_id, rel_path)
      );
      CREATE TABLE tags (
        entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (entry_id, tag)
      );
      CREATE TABLE meta (
        entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (entry_id, key)
      );
      CREATE TABLE stalks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        UNIQUE (workspace_id, name)
      );
      CREATE TABLE stalk_members (
        stalk_id TEXT NOT NULL REFERENCES stalks(id) ON DELETE CASCADE,
        entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        PRIMARY KEY (stalk_id, entry_id)
      );
      CREATE VIRTUAL TABLE entries_fts USING fts5(rel_path, notes, tags);
    `,
  },
];

export interface Workspace {
  id: string;
  name: string;
  root_path: string;
  description: string | null;
  created_at: number;
}

export interface Entry {
  id: string;
  workspace_id: string;
  rel_path: string;
  kind: string;
  notes: string | null;
  pinned: number;
  missing: number;
  first_seen: number;
  last_seen: number;
  tags?: string[];
  meta?: Record<string, string>;
}

export class BambooStore {
  private db: DB;

  constructor(dbFile = "bamboo.db") {
    this.db = openDb("bamboo", dbFile, MIGRATIONS);
  }

  createWorkspace(name: string, rootPath: string, description?: string): Workspace {
    const abs = path.resolve(rootPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new Error(`root_path is not an existing directory: ${abs}`);
    }
    const id = newId();
    this.db
      .prepare(`INSERT INTO workspaces (id, name, root_path, description, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, name, abs, description ?? null, Date.now());
    return this.getWorkspace(name)!;
  }

  getWorkspace(name: string): Workspace | null {
    return (this.db.prepare(`SELECT * FROM workspaces WHERE name = ?`).get(name) as Workspace | undefined) ?? null;
  }

  listWorkspaces(): Workspace[] {
    return this.db.prepare(`SELECT * FROM workspaces ORDER BY name`).all() as Workspace[];
  }

  /** Reconcile DB against disk: discover new files/dirs, refresh last_seen, flag missing. */
  scan(workspaceName: string, opts: { maxDepth?: number } = {}): { discovered: number; refreshed: number; missing: number } {
    const ws = this.getWorkspace(workspaceName);
    if (!ws) throw new Error(`no workspace '${workspaceName}'`);
    const now = Date.now();
    const seen = new Set<string>();
    const maxDepth = opts.maxDepth ?? 8;
    let discovered = 0;
    let refreshed = 0;

    const walk = (dir: string, depth: number) => {
      if (depth > maxDepth || seen.size >= MAX_SCAN_ENTRIES) return;
      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // unreadable dir — skip, not fatal
      }
      for (const item of items) {
        if (seen.size >= MAX_SCAN_ENTRIES) return;
        if (item.isDirectory() && (SKIP_DIRS.has(item.name) || item.name.startsWith("."))) continue;
        const abs = path.join(dir, item.name);
        const rel = path.relative(ws.root_path, abs).split(path.sep).join("/");
        seen.add(rel);
        const kind = item.isDirectory() ? "dir" : "file";
        const existing = this.db
          .prepare(`SELECT id FROM entries WHERE workspace_id = ? AND rel_path = ?`)
          .get(ws.id, rel) as { id: string } | undefined;
        if (existing) {
          this.db.prepare(`UPDATE entries SET last_seen = ?, missing = 0, kind = ? WHERE id = ?`).run(now, kind, existing.id);
          refreshed++;
        } else {
          const id = newId();
          this.db
            .prepare(
              `INSERT INTO entries (id, workspace_id, rel_path, kind, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(id, ws.id, rel, kind, now, now);
          this.reindexFts(id, rel, null, []);
          discovered++;
        }
        if (item.isDirectory()) walk(abs, depth + 1);
      }
    };
    walk(ws.root_path, 0);

    const missing = this.db
      .prepare(`UPDATE entries SET missing = 1 WHERE workspace_id = ? AND last_seen < ?`)
      .run(ws.id, now).changes;
    return { discovered, refreshed, missing };
  }

  private reindexFts(entryId: string, relPath: string, notes: string | null, tags: string[]): void {
    const row = this.db.prepare(`SELECT rowid FROM entries WHERE id = ?`).get(entryId) as { rowid: number };
    this.db.prepare(`DELETE FROM entries_fts WHERE rowid = ?`).run(row.rowid);
    this.db
      .prepare(`INSERT INTO entries_fts (rowid, rel_path, notes, tags) VALUES (?, ?, ?, ?)`)
      .run(row.rowid, relPath, notes ?? "", tags.join(" "));
  }

  private entryByPath(workspaceName: string, relPath: string): Entry {
    const ws = this.getWorkspace(workspaceName);
    if (!ws) throw new Error(`no workspace '${workspaceName}'`);
    const e = this.db
      .prepare(`SELECT * FROM entries WHERE workspace_id = ? AND rel_path = ?`)
      .get(ws.id, relPath.split(path.sep).join("/")) as Entry | undefined;
    if (!e) throw new Error(`no entry '${relPath}' in workspace '${workspaceName}' (run organize_scan first?)`);
    return e;
  }

  hydrate(e: Entry): Entry {
    e.tags = (this.db.prepare(`SELECT tag FROM tags WHERE entry_id = ?`).all(e.id) as Array<{ tag: string }>).map(
      (t) => t.tag,
    );
    e.meta = Object.fromEntries(
      (this.db.prepare(`SELECT key, value FROM meta WHERE entry_id = ?`).all(e.id) as Array<{ key: string; value: string }>).map(
        (m) => [m.key, m.value],
      ),
    );
    return e;
  }

  private refreshEntryFts(e: Entry): void {
    const h = this.hydrate(e);
    this.reindexFts(e.id, e.rel_path, e.notes, h.tags ?? []);
  }

  tag(workspaceName: string, relPath: string, tags: string[]): Entry {
    const e = this.entryByPath(workspaceName, relPath);
    for (const t of tags) this.db.prepare(`INSERT OR IGNORE INTO tags (entry_id, tag) VALUES (?, ?)`).run(e.id, t);
    this.refreshEntryFts(e);
    return this.hydrate(this.entryByPath(workspaceName, relPath));
  }

  annotate(workspaceName: string, relPath: string, notes: string): Entry {
    const e = this.entryByPath(workspaceName, relPath);
    this.db.prepare(`UPDATE entries SET notes = ? WHERE id = ?`).run(notes, e.id);
    e.notes = notes;
    this.refreshEntryFts(e);
    return this.hydrate(this.entryByPath(workspaceName, relPath));
  }

  setMeta(workspaceName: string, relPath: string, key: string, value: string): Entry {
    const e = this.entryByPath(workspaceName, relPath);
    this.db
      .prepare(`INSERT INTO meta (entry_id, key, value) VALUES (?, ?, ?) ON CONFLICT(entry_id, key) DO UPDATE SET value = excluded.value`)
      .run(e.id, key, value);
    return this.hydrate(e);
  }

  setPinned(workspaceName: string, relPath: string, pinned: boolean): Entry {
    const e = this.entryByPath(workspaceName, relPath);
    this.db.prepare(`UPDATE entries SET pinned = ? WHERE id = ?`).run(pinned ? 1 : 0, e.id);
    return this.hydrate(this.entryByPath(workspaceName, relPath));
  }

  find(workspaceName: string, opts: { query?: string; tag?: string; limit?: number }): Entry[] {
    const ws = this.getWorkspace(workspaceName);
    if (!ws) throw new Error(`no workspace '${workspaceName}'`);
    const limit = Math.min(opts.limit ?? 25, 200);
    let rows: Array<{ id: string }>;
    if (opts.query) {
      rows = this.db
        .prepare(
          `SELECT e.id FROM entries_fts f JOIN entries e ON e.rowid = f.rowid
           WHERE entries_fts MATCH ? AND e.workspace_id = ? ORDER BY rank LIMIT ?`,
        )
        .all(opts.query, ws.id, limit) as Array<{ id: string }>;
    } else if (opts.tag) {
      rows = this.db
        .prepare(
          `SELECT e.id FROM entries e JOIN tags t ON t.entry_id = e.id
           WHERE e.workspace_id = ? AND t.tag = ? ORDER BY e.rel_path LIMIT ?`,
        )
        .all(ws.id, opts.tag, limit) as Array<{ id: string }>;
    } else {
      throw new Error("find requires query or tag");
    }
    return rows.map((r) => this.hydrate(this.db.prepare(`SELECT * FROM entries WHERE id = ?`).get(r.id) as Entry));
  }

  /** Outline + pinned + recently seen — the "open this workspace" context view. */
  open(workspaceName: string): unknown {
    const ws = this.getWorkspace(workspaceName);
    if (!ws) throw new Error(`no workspace '${workspaceName}'`);
    const topDirs = this.db
      .prepare(
        `SELECT rel_path FROM entries WHERE workspace_id = ? AND kind = 'dir' AND missing = 0
         AND rel_path NOT LIKE '%/%' ORDER BY rel_path`,
      )
      .all(ws.id) as Array<{ rel_path: string }>;
    const pinned = this.db
      .prepare(`SELECT id FROM entries WHERE workspace_id = ? AND pinned = 1 ORDER BY rel_path`)
      .all(ws.id) as Array<{ id: string }>;
    const recent = this.db
      .prepare(
        `SELECT rel_path, kind FROM entries WHERE workspace_id = ? AND missing = 0
         ORDER BY last_seen DESC, rel_path LIMIT 15`,
      )
      .all(ws.id);
    const counts = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(missing) AS missing FROM entries WHERE workspace_id = ?`,
      )
      .get(ws.id);
    const stalks = this.db
      .prepare(`SELECT name, description FROM stalks WHERE workspace_id = ? ORDER BY name`)
      .all(ws.id);
    return {
      workspace: ws,
      outline: topDirs.map((d) => d.rel_path),
      pinned: pinned.map((p) => this.hydrate(this.db.prepare(`SELECT * FROM entries WHERE id = ?`).get(p.id) as Entry)),
      recent,
      stalks,
      counts,
    };
  }

  createStalk(workspaceName: string, name: string, description?: string): { id: string; name: string } {
    const ws = this.getWorkspace(workspaceName);
    if (!ws) throw new Error(`no workspace '${workspaceName}'`);
    const id = newId();
    this.db
      .prepare(`INSERT INTO stalks (id, workspace_id, name, description) VALUES (?, ?, ?, ?)`)
      .run(id, ws.id, name, description ?? null);
    return { id, name };
  }

  assignToStalk(workspaceName: string, stalkName: string, relPaths: string[]): number {
    const ws = this.getWorkspace(workspaceName);
    if (!ws) throw new Error(`no workspace '${workspaceName}'`);
    const stalk = this.db
      .prepare(`SELECT id FROM stalks WHERE workspace_id = ? AND name = ?`)
      .get(ws.id, stalkName) as { id: string } | undefined;
    if (!stalk) throw new Error(`no stalk '${stalkName}' in workspace '${workspaceName}'`);
    let assigned = 0;
    for (const rel of relPaths) {
      const e = this.entryByPath(workspaceName, rel);
      assigned += this.db
        .prepare(`INSERT OR IGNORE INTO stalk_members (stalk_id, entry_id) VALUES (?, ?)`)
        .run(stalk.id, e.id).changes;
    }
    return assigned;
  }

  listStalk(workspaceName: string, stalkName: string): Entry[] {
    const ws = this.getWorkspace(workspaceName);
    if (!ws) throw new Error(`no workspace '${workspaceName}'`);
    const rows = this.db
      .prepare(
        `SELECT e.id FROM stalks s JOIN stalk_members m ON m.stalk_id = s.id JOIN entries e ON e.id = m.entry_id
         WHERE s.workspace_id = ? AND s.name = ? ORDER BY e.rel_path`,
      )
      .all(ws.id, stalkName) as Array<{ id: string }>;
    return rows.map((r) => this.hydrate(this.db.prepare(`SELECT * FROM entries WHERE id = ?`).get(r.id) as Entry));
  }

  close(): void {
    this.db.close();
  }
}
