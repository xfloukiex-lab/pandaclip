import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pandaHome, serverDataDir } from "../src/paths.js";
import { openDb } from "../src/db.js";
import { loadConfig } from "../src/config.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "panda-core-test-"));
  process.env.PANDA_HOME = tmp;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("paths", () => {
  it("honors PANDA_HOME and creates server dirs", () => {
    expect(pandaHome()).toBe(tmp);
    const dir = serverDataDir("cache");
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe("openDb", () => {
  it("applies migrations once and tracks user_version", () => {
    const migrations = [{ version: 1, sql: `CREATE TABLE t (id TEXT PRIMARY KEY);` }];
    const db = openDb("cache", "test.db", migrations);
    db.prepare(`INSERT INTO t (id) VALUES ('x')`).run();
    db.close();
    const db2 = openDb("cache", "test.db", migrations); // re-open: must not re-run CREATE
    expect((db2.prepare(`SELECT COUNT(*) AS n FROM t`).get() as { n: number }).n).toBe(1);
    db2.close();
  });
});

describe("loadConfig", () => {
  it("returns {} when missing and parses when present", () => {
    expect(loadConfig()).toEqual({});
    fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ customSource: { enabled: false } }));
    expect(loadConfig()).toEqual({ customSource: { enabled: false } });
  });

  it("returns {} on invalid JSON", () => {
    fs.writeFileSync(path.join(tmp, "config.json"), "not json");
    expect(loadConfig()).toEqual({});
  });
});
