import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClipStore } from "../src/store/clipStore.js";

let tmp: string;
let store: ClipStore;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "panda-clip-test-"));
  process.env.PANDA_HOME = tmp;
  store = new ClipStore();
});

afterEach(() => {
  store.close();
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ClipStore", () => {
  it("push + history round-trip with tags", () => {
    const e = store.push({ content: "hello world", label: "greeting", tags: ["demo"] });
    expect(e.id).toBeTruthy();
    const hist = store.history({ tag: "demo" });
    expect(hist).toHaveLength(1);
    expect(hist[0].content).toBe("hello world");
  });

  it("refuses credential-looking content", () => {
    expect(() => store.push({ content: "api_key = supersecretvalue123" })).toThrow(/credential/);
    expect(() => store.push({ content: "ghp_" + "a".repeat(30) })).toThrow(/credential/);
  });

  it("refuses oversized entries", () => {
    expect(() => store.push({ content: "x".repeat(1_000_001) })).toThrow(/exceeds/);
  });

  it("expires ephemeral entries after 24h, keeps pinned", () => {
    vi.useFakeTimers();
    const e = store.push({ content: "fleeting" });
    const p = store.push({ content: "keeper", ttlClass: "pinned" });
    vi.advanceTimersByTime(25 * 3600 * 1000);
    expect(store.history()).toHaveLength(1);
    expect(store.get(e.id)).toBeNull();
    expect(store.get(p.id)?.content).toBe("keeper");
  });

  it("pin lifts expiry", () => {
    vi.useFakeTimers();
    const e = store.push({ content: "save me" });
    store.pin(e.id);
    vi.advanceTimersByTime(48 * 3600 * 1000);
    expect(store.get(e.id)?.content).toBe("save me");
  });

  it("history contains filter matches content/label, escapes wildcards, excludes deleted", () => {
    const e = store.push({ content: "the quick brown fox" });
    store.push({ content: "unrelated", label: "fox notes" });
    store.push({ content: "100% done" });
    expect(store.history({ contains: "fox" })).toHaveLength(2);
    expect(store.history({ contains: "100%" })).toHaveLength(1);
    expect(store.history({ contains: "0%" })).toHaveLength(1); // literal %, not wildcard
    store.deleteById(e.id);
    expect(store.history({ contains: "quick" })).toHaveLength(0);
  });

  it("snippets: save, overwrite by name, list, never expire", () => {
    store.push({ content: "v1", snippetName: "sig" });
    store.push({ content: "v2", snippetName: "sig" });
    expect(store.getSnippet("sig")?.content).toBe("v2");
    expect(store.listSnippets()).toHaveLength(1);
    expect(store.history()).toHaveLength(0); // snippets don't pollute history
  });

  it("channel take consumes FIFO; peek does not", () => {
    store.push({ content: "first", channel: "review", ttlClass: "session" });
    store.push({ content: "second", channel: "review", ttlClass: "session" });
    expect(store.channelPeek("review")).toHaveLength(2);
    expect(store.channelTake("review")?.content).toBe("first");
    expect(store.channelTake("review")?.content).toBe("second");
    expect(store.channelTake("review")).toBeNull();
  });
});
