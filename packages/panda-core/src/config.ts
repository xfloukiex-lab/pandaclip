import fs from "node:fs";
import path from "node:path";
import { pandaHome } from "./paths.js";

/** Load ~/.panda/config.json (missing or invalid file -> {}). */
export function loadConfig(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(path.join(pandaHome(), "config.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
