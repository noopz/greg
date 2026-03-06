/**
 * Local Config Loader
 *
 * Pure data loader — reads local/config.json at module load time.
 * No project imports = leaf node, zero circular dependency risk.
 *
 * On the public branch (no local/config.json), all getters return empty arrays.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

interface LocalConfig {
  tools?: { public?: string[]; creator?: string[] };
  paths?: { read?: string[]; write?: string[] };
}

let config: LocalConfig = {};
try {
  const raw = readFileSync(path.join(process.cwd(), "local", "config.json"), "utf-8");
  config = JSON.parse(raw);
} catch {
  // local/config.json doesn't exist — running on public branch or fresh clone
}

export function getLocalToolNames(access: "public" | "creator"): string[] {
  if (access === "creator") {
    return [...(config.tools?.public ?? []), ...(config.tools?.creator ?? [])];
  }
  return config.tools?.public ?? [];
}

export function getLocalPaths(): { read: string[]; write: string[] } {
  return {
    read: config.paths?.read ?? [],
    write: config.paths?.write ?? [],
  };
}
