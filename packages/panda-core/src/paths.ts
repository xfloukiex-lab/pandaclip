import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** Root data dir for the whole suite. Override with PANDA_HOME (used by tests). */
export function pandaHome(): string {
  return process.env.PANDA_HOME ?? path.join(os.homedir(), ".panda");
}

/** Per-server data dir, created on demand. */
export function serverDataDir(server: string): string {
  const dir = path.join(pandaHome(), server);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
