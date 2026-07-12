import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CacheStore, hashKey } from "../src/store/cacheStore.js";

let tmp: string;
let store: CacheStore;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "panda-cache-test-"));
  process.env.PANDA_HOME = tmp;
  store = new CacheStore();
});

afterEach(() => {
  store.close();
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("CacheStore", () => {
  it("round-trips a value and counts hits", () => {
    store.set("llm", "k1", "hello");
    const hit = store.get("llm", "k1");
    expect(hit?.value).toBe("hello");
    expect(hit?.hits).toBe(1);
    expect(store.get("llm", "k1")?.hits).toBe(2);
  });

  it("misses on unknown key", () => {
    expect(store.get("llm", "nope")).toBeNull();
  });

  it("expires entries after TTL and sweeps them", () => {
    vi.useFakeTimers();
    store.set("web", "k", "v", { ttlSeconds: 10 });
    expect(store.get("web", "k")?.value).toBe("v");
    vi.advanceTimersByTime(11_000);
    expect(store.get("web", "k")).toBeNull();
    expect(store.sweep()).toBe(1);
  });

  it("applies namespace default TTL", () => {
    vi.useFakeTimers();
    store.configureNamespace("web", { defaultTtlSeconds: 5 });
    store.set("web", "k", "v");
    vi.advanceTimersByTime(6_000);
    expect(store.get("web", "k")).toBeNull();
  });

  it("invalidates by key and by prefix", () => {
    store.set("t", "a:1", "x");
    store.set("t", "a:2", "y");
    store.set("t", "b:1", "z");
    expect(store.invalidate("t", { key: "b:1" })).toBe(1);
    expect(store.invalidate("t", { prefix: "a:" })).toBe(2);
    expect(store.stats("t")).toEqual([]);
  });

  it("rejects invalidate without key or prefix", () => {
    expect(() => store.invalidate("t", {})).toThrow(/key or prefix/);
  });

  it("flushes only the given namespace", () => {
    store.set("a", "k", "v");
    store.set("b", "k", "v");
    expect(store.flush("a")).toBe(1);
    expect(store.get("b", "k")?.value).toBe("v");
  });
});

describe("hashKey", () => {
  it("is order-insensitive for object keys", () => {
    expect(hashKey({ a: 1, b: [2, 3] })).toBe(hashKey({ b: [2, 3], a: 1 }));
  });

  it("distinguishes different payloads", () => {
    expect(hashKey({ a: 1 })).not.toBe(hashKey({ a: 2 }));
  });
});
