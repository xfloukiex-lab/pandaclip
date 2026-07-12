import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GardenStore } from "../src/store/gardenStore.js";

let tmp: string;
let g: GardenStore;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "panda-garden-test-"));
  process.env.PANDA_HOME = tmp;
  g = new GardenStore("test");
});

afterEach(() => {
  g.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("GardenStore", () => {
  it("plants a seed with sources and records history v1", () => {
    const n = g.plant({ title: "MCP", content: "Model Context Protocol", sources: [{ kind: "url", ref: "https://modelcontextprotocol.io" }] });
    expect(n.stage).toBe("seed");
    const hist = g.history(n.id) as Array<{ version: number; change_note: string }>;
    expect(hist).toHaveLength(1);
    expect(hist[0].change_note).toBe("planted");
  });

  it("grow updates fields and appends history versions", () => {
    const n = g.plant({ title: "idea" });
    g.grow(n.id, { content: "fleshed out", stage: "shoot", changeNote: "developed" });
    const updated = g.grow(n.id, { stage: "bamboo" });
    expect(updated.stage).toBe("bamboo");
    expect(updated.content).toBe("fleshed out");
    expect(g.history(n.id)).toHaveLength(3);
  });

  it("grow rejects pruned or missing nodes", () => {
    const n = g.plant({ title: "gone" });
    g.prune({ nodeId: n.id, reason: "stale" });
    expect(() => g.grow(n.id, { title: "zombie" })).toThrow(/no live node/);
    expect(() => g.grow("nope", {})).toThrow(/no live node/);
  });

  it("connect + neighbors with rel and direction filters", () => {
    const a = g.plant({ title: "A" });
    const b = g.plant({ title: "B" });
    const c = g.plant({ title: "C" });
    g.connect(a.id, b.id, "depends_on");
    g.connect(c.id, a.id, "part_of");
    expect(g.neighbors(a.id)).toHaveLength(2);
    expect(g.neighbors(a.id, { direction: "out" })).toHaveLength(1);
    expect(g.neighbors(a.id, { rel: "part_of" })[0].node.title).toBe("C");
    expect(() => g.connect(a.id, "ghost", "x")).toThrow(/no live node/);
  });

  it("pruning a node prunes its edges and hides it from search", () => {
    const a = g.plant({ title: "kept" });
    const b = g.plant({ title: "doomed concept" });
    g.connect(a.id, b.id, "related_to");
    const res = g.prune({ nodeId: b.id, reason: "wrong" });
    expect(res.edges_pruned).toBe(1);
    expect(g.neighbors(a.id)).toHaveLength(0);
    expect(g.search("doomed")).toHaveLength(0);
    expect(g.search("kept")).toHaveLength(1);
  });

  it("traverse returns a bounded BFS subgraph", () => {
    const a = g.plant({ title: "A" });
    const b = g.plant({ title: "B" });
    const c = g.plant({ title: "C" });
    const d = g.plant({ title: "D" });
    g.connect(a.id, b.id, "r");
    g.connect(b.id, c.id, "r");
    g.connect(c.id, d.id, "r");
    const depth1 = g.traverse(a.id, { depth: 1 });
    expect(depth1.nodes.map((n) => n.title).sort()).toEqual(["A", "B"]);
    const depth3 = g.traverse(a.id, { depth: 3 });
    expect(depth3.nodes).toHaveLength(4);
    expect(depth3.edges).toHaveLength(3);
  });

  it("search filters by stage and type", () => {
    const n1 = g.plant({ title: "caching strategy", type: "decision" });
    g.plant({ title: "caching notes", type: "note" });
    g.grow(n1.id, { stage: "bamboo" });
    expect(g.search("caching")).toHaveLength(2);
    expect(g.search("caching", { type: "decision" })).toHaveLength(1);
    expect(g.search("caching", { stage: "bamboo" })[0].id).toBe(n1.id);
  });

  it("stats reports stages, orphans, edges", () => {
    const a = g.plant({ title: "connected1" });
    const b = g.plant({ title: "connected2" });
    g.plant({ title: "lonely" });
    g.connect(a.id, b.id, "r");
    const s = g.stats() as { orphan_nodes: { n: number }; live_edges: { n: number } };
    expect(s.orphan_nodes.n).toBe(1);
    expect(s.live_edges.n).toBe(1);
  });

  it("disconnect prunes only the matching edge", () => {
    const a = g.plant({ title: "A" });
    const b = g.plant({ title: "B" });
    g.connect(a.id, b.id, "r1");
    g.connect(a.id, b.id, "r2");
    expect(g.disconnect(a.id, b.id, "r1")).toBe(1);
    expect(g.neighbors(a.id)).toHaveLength(1);
  });
});
