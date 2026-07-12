import { openDb, type DB, newId } from "@panda-mcp/core";

export const STAGES = ["seed", "shoot", "bamboo"] as const;
export type Stage = (typeof STAGES)[number];

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'concept',
        title TEXT NOT NULL,
        content TEXT,
        stage TEXT NOT NULL DEFAULT 'seed',
        importance INTEGER NOT NULL DEFAULT 3,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        pruned_at INTEGER
      );
      CREATE TABLE edges (
        id TEXT PRIMARY KEY,
        src TEXT NOT NULL REFERENCES nodes(id),
        dst TEXT NOT NULL REFERENCES nodes(id),
        rel TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        note TEXT,
        created_at INTEGER NOT NULL,
        pruned_at INTEGER,
        UNIQUE (src, dst, rel)
      );
      CREATE TABLE node_history (
        node_id TEXT NOT NULL REFERENCES nodes(id),
        version INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT,
        stage TEXT NOT NULL,
        changed_at INTEGER NOT NULL,
        change_note TEXT,
        PRIMARY KEY (node_id, version)
      );
      CREATE TABLE sources (
        node_id TEXT NOT NULL REFERENCES nodes(id),
        kind TEXT NOT NULL,
        ref TEXT NOT NULL,
        PRIMARY KEY (node_id, kind, ref)
      );
      CREATE VIRTUAL TABLE nodes_fts USING fts5(title, content);
    `,
  },
];

export interface GNode {
  id: string;
  type: string;
  title: string;
  content: string | null;
  stage: Stage;
  importance: number;
  created_at: number;
  updated_at: number;
  pruned_at: number | null;
}

export interface GEdge {
  id: string;
  src: string;
  dst: string;
  rel: string;
  weight: number;
  note: string | null;
  created_at: number;
  pruned_at: number | null;
}

export class GardenStore {
  private db: DB;

  constructor(garden = "default") {
    this.db = openDb("garden", `${garden}.db`, MIGRATIONS);
  }

  private recordHistory(node: GNode, changeNote?: string): void {
    const v = (
      this.db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM node_history WHERE node_id = ?`).get(node.id) as {
        v: number;
      }
    ).v;
    this.db
      .prepare(
        `INSERT INTO node_history (node_id, version, title, content, stage, changed_at, change_note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(node.id, v + 1, node.title, node.content, node.stage, Date.now(), changeNote ?? null);
  }

  private reindexFts(node: GNode): void {
    const row = this.db.prepare(`SELECT rowid FROM nodes WHERE id = ?`).get(node.id) as { rowid: number };
    this.db.prepare(`DELETE FROM nodes_fts WHERE rowid = ?`).run(row.rowid);
    if (node.pruned_at == null) {
      this.db
        .prepare(`INSERT INTO nodes_fts (rowid, title, content) VALUES (?, ?, ?)`)
        .run(row.rowid, node.title, node.content ?? "");
    }
  }

  plant(opts: { title: string; content?: string; type?: string; importance?: number; sources?: Array<{ kind: string; ref: string }> }): GNode {
    const now = Date.now();
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO nodes (id, type, title, content, stage, importance, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'seed', ?, ?, ?)`,
      )
      .run(id, opts.type ?? "concept", opts.title, opts.content ?? null, opts.importance ?? 3, now, now);
    for (const s of opts.sources ?? []) {
      this.db.prepare(`INSERT OR IGNORE INTO sources (node_id, kind, ref) VALUES (?, ?, ?)`).run(id, s.kind, s.ref);
    }
    const node = this.getNode(id)!;
    this.recordHistory(node, "planted");
    this.reindexFts(node);
    return node;
  }

  getNode(id: string): GNode | null {
    return (this.db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(id) as GNode | undefined) ?? null;
  }

  grow(
    id: string,
    opts: { title?: string; content?: string; stage?: Stage; importance?: number; changeNote?: string },
  ): GNode {
    const node = this.getNode(id);
    if (!node || node.pruned_at != null) throw new Error(`no live node ${id}`);
    if (opts.stage && !STAGES.includes(opts.stage)) throw new Error(`invalid stage: ${opts.stage}`);
    this.db
      .prepare(`UPDATE nodes SET title = ?, content = ?, stage = ?, importance = ?, updated_at = ? WHERE id = ?`)
      .run(
        opts.title ?? node.title,
        opts.content ?? node.content,
        opts.stage ?? node.stage,
        opts.importance ?? node.importance,
        Date.now(),
        id,
      );
    const updated = this.getNode(id)!;
    this.recordHistory(updated, opts.changeNote);
    this.reindexFts(updated);
    return updated;
  }

  /** Soft-delete a node (and its live edges) or a single edge. */
  prune(opts: { nodeId?: string; edgeId?: string; reason?: string }): { pruned: string; edges_pruned?: number } {
    const now = Date.now();
    if (opts.nodeId) {
      const node = this.getNode(opts.nodeId);
      if (!node || node.pruned_at != null) throw new Error(`no live node ${opts.nodeId}`);
      this.db.prepare(`UPDATE nodes SET pruned_at = ?, updated_at = ? WHERE id = ?`).run(now, now, opts.nodeId);
      const edges = this.db
        .prepare(`UPDATE edges SET pruned_at = ? WHERE (src = ? OR dst = ?) AND pruned_at IS NULL`)
        .run(now, opts.nodeId, opts.nodeId).changes;
      const pruned = this.getNode(opts.nodeId)!;
      this.recordHistory(pruned, `pruned: ${opts.reason ?? "no reason given"}`);
      this.reindexFts(pruned);
      return { pruned: opts.nodeId, edges_pruned: edges };
    }
    if (opts.edgeId) {
      const n = this.db.prepare(`UPDATE edges SET pruned_at = ? WHERE id = ? AND pruned_at IS NULL`).run(now, opts.edgeId).changes;
      if (n === 0) throw new Error(`no live edge ${opts.edgeId}`);
      return { pruned: opts.edgeId };
    }
    throw new Error("prune requires nodeId or edgeId");
  }

  connect(src: string, dst: string, rel: string, opts: { weight?: number; note?: string } = {}): GEdge {
    for (const id of [src, dst]) {
      const n = this.getNode(id);
      if (!n || n.pruned_at != null) throw new Error(`no live node ${id}`);
    }
    const id = newId();
    this.db
      .prepare(`INSERT INTO edges (id, src, dst, rel, weight, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, src, dst, rel, opts.weight ?? 1.0, opts.note ?? null, Date.now());
    return this.db.prepare(`SELECT * FROM edges WHERE id = ?`).get(id) as GEdge;
  }

  disconnect(src: string, dst: string, rel: string): number {
    return this.db
      .prepare(`UPDATE edges SET pruned_at = ? WHERE src = ? AND dst = ? AND rel = ? AND pruned_at IS NULL`)
      .run(Date.now(), src, dst, rel).changes;
  }

  neighbors(id: string, opts: { rel?: string; direction?: "out" | "in" | "both" } = {}): Array<{ edge: GEdge; node: GNode }> {
    const dir = opts.direction ?? "both";
    const out: Array<{ edge: GEdge; node: GNode }> = [];
    const collect = (sql: string, other: (e: GEdge) => string) => {
      const rows = this.db.prepare(sql).all(id) as GEdge[];
      for (const e of rows) {
        if (opts.rel && e.rel !== opts.rel) continue;
        const n = this.getNode(other(e));
        if (n && n.pruned_at == null) out.push({ edge: e, node: n });
      }
    };
    if (dir !== "in") collect(`SELECT * FROM edges WHERE src = ? AND pruned_at IS NULL`, (e) => e.dst);
    if (dir !== "out") collect(`SELECT * FROM edges WHERE dst = ? AND pruned_at IS NULL`, (e) => e.src);
    return out;
  }

  /** BFS subgraph to depth N. */
  traverse(startId: string, opts: { depth?: number; rel?: string } = {}): { nodes: GNode[]; edges: GEdge[] } {
    const start = this.getNode(startId);
    if (!start || start.pruned_at != null) throw new Error(`no live node ${startId}`);
    const maxDepth = Math.min(opts.depth ?? 2, 6);
    const seenNodes = new Map<string, GNode>([[startId, start]]);
    const seenEdges = new Map<string, GEdge>();
    let frontier = [startId];
    for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const { edge, node } of this.neighbors(id, { rel: opts.rel })) {
          seenEdges.set(edge.id, edge);
          if (!seenNodes.has(node.id)) {
            seenNodes.set(node.id, node);
            next.push(node.id);
          }
        }
      }
      frontier = next;
    }
    return { nodes: [...seenNodes.values()], edges: [...seenEdges.values()] };
  }

  search(query: string, opts: { type?: string; stage?: Stage; limit?: number } = {}): GNode[] {
    const rows = this.db
      .prepare(
        `SELECT n.id FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid
         WHERE nodes_fts MATCH ? AND n.pruned_at IS NULL ORDER BY rank LIMIT ?`,
      )
      .all(query, Math.min(opts.limit ?? 20, 100)) as Array<{ id: string }>;
    return rows
      .map((r) => this.getNode(r.id)!)
      .filter((n) => (!opts.type || n.type === opts.type) && (!opts.stage || n.stage === opts.stage));
  }

  history(nodeId: string): unknown[] {
    return this.db
      .prepare(`SELECT version, title, content, stage, changed_at, change_note FROM node_history WHERE node_id = ? ORDER BY version`)
      .all(nodeId);
  }

  stats(): unknown {
    const byStage = this.db
      .prepare(`SELECT stage, COUNT(*) AS n FROM nodes WHERE pruned_at IS NULL GROUP BY stage`)
      .all();
    const byType = this.db
      .prepare(`SELECT type, COUNT(*) AS n FROM nodes WHERE pruned_at IS NULL GROUP BY type`)
      .all();
    const orphans = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM nodes n WHERE n.pruned_at IS NULL AND NOT EXISTS
         (SELECT 1 FROM edges e WHERE (e.src = n.id OR e.dst = n.id) AND e.pruned_at IS NULL)`,
      )
      .get();
    const staleSeeds = this.db
      .prepare(`SELECT COUNT(*) AS n FROM nodes WHERE pruned_at IS NULL AND stage = 'seed' AND updated_at < ?`)
      .get(Date.now() - 30 * 24 * 3600 * 1000);
    const edges = this.db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE pruned_at IS NULL`).get();
    return { by_stage: byStage, by_type: byType, live_edges: edges, orphan_nodes: orphans, stale_seeds_30d: staleSeeds };
  }

  close(): void {
    this.db.close();
  }
}
