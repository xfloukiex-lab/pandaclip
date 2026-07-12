import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BambooStore } from "../src/store/bambooStore.js";

let tmp: string;
let root: string;
let store: BambooStore;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "panda-bamboo-test-"));
  process.env.PANDA_HOME = path.join(tmp, "home");
  root = path.join(tmp, "proj");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "junk"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# hi");
  fs.writeFileSync(path.join(root, "src", "main.ts"), "export {}");
  store = new BambooStore();
});

afterEach(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("BambooStore", () => {
  it("creates a workspace and rejects a bad root", () => {
    const ws = store.createWorkspace("proj", root, "test project");
    expect(ws.root_path).toBe(path.resolve(root));
    expect(() => store.createWorkspace("bad", path.join(tmp, "nope"))).toThrow(/not an existing directory/);
  });

  it("scan discovers files, skips node_modules, flags missing on rescan", () => {
    store.createWorkspace("proj", root);
    const first = store.scan("proj");
    expect(first.discovered).toBe(3); // README.md, src, src/main.ts — no node_modules
    fs.rmSync(path.join(root, "README.md"));
    const second = store.scan("proj");
    expect(second.missing).toBe(1);
    expect(second.refreshed).toBe(2);
  });

  it("tags, notes, meta round-trip and FTS find works", () => {
    store.createWorkspace("proj", root);
    store.scan("proj");
    store.tag("proj", "src/main.ts", ["entrypoint", "typescript"]);
    store.annotate("proj", "src/main.ts", "the main entry module");
    store.setMeta("proj", "src/main.ts", "owner", "agent-a");
    const byTag = store.find("proj", { tag: "entrypoint" });
    expect(byTag).toHaveLength(1);
    expect(byTag[0].meta?.owner).toBe("agent-a");
    expect(store.find("proj", { query: "entry" })).toHaveLength(1); // notes hit
    expect(store.find("proj", { query: "typescript" })).toHaveLength(1); // tag hit
  });

  it("find requires query or tag", () => {
    store.createWorkspace("proj", root);
    expect(() => store.find("proj", {})).toThrow(/query or tag/);
  });

  it("errors on unknown workspace and unknown entry", () => {
    expect(() => store.scan("ghost")).toThrow(/no workspace/);
    store.createWorkspace("proj", root);
    expect(() => store.tag("proj", "nope.txt", ["x"])).toThrow(/no entry/);
  });

  it("workspace_open shows outline, pinned, counts", () => {
    store.createWorkspace("proj", root);
    store.scan("proj");
    store.setPinned("proj", "README.md", true);
    const view = store.open("proj") as { outline: string[]; pinned: Array<{ rel_path: string }>; counts: { total: number } };
    expect(view.outline).toEqual(["src"]);
    expect(view.pinned[0].rel_path).toBe("README.md");
    expect(view.counts.total).toBe(3);
  });

  it("stalks collect entries across directories", () => {
    store.createWorkspace("proj", root);
    store.scan("proj");
    store.createStalk("proj", "docs", "documentation set");
    expect(store.assignToStalk("proj", "docs", ["README.md", "src/main.ts"])).toBe(2);
    expect(store.listStalk("proj", "docs")).toHaveLength(2);
    expect(() => store.assignToStalk("proj", "ghost", ["README.md"])).toThrow(/no stalk/);
  });
});
