import Database from "better-sqlite3";
import path from "node:path";
import { serverDataDir } from "./paths.js";

export type DB = Database.Database;

export interface Migration {
  version: number;
  sql: string;
}

/** Open (creating if needed) a server's SQLite DB in WAL mode and apply pending migrations. */
export function openDb(server: string, filename: string, migrations: Migration[]): DB {
  const db = new Database(path.join(serverDataDir(server), filename));
  db.pragma("journal_mode = WAL");
  // Checkpoint after every commit: external read-only viewers (e.g. the
  // clipboard UI) read the main db file bytes and cannot see WAL content.
  db.pragma("wal_autocheckpoint = 1");
  db.pragma("foreign_keys = ON");
  const current = db.pragma("user_version", { simple: true }) as number;
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version > current) {
      db.transaction(() => {
        db.exec(m.sql);
        db.pragma(`user_version = ${m.version}`);
      })();
    }
  }
  return db;
}
