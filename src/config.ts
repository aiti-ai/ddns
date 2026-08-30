/** Config file — <configDir>/ddns.json (0600, holds API tokens). The file is
 *  a JSON array of DdnsEntry (Go ddns-updater settings list semantics). */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DdnsEntry } from "./engine.ts";

export function configPath(configDir: string): string {
  return join(configDir, "ddns.json");
}

export function readConfig(configDir: string): DdnsEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(configPath(configDir), "utf8"));
    const list: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : [];
    return list.filter(
      (c): c is DdnsEntry => typeof c === "object" && c !== null && typeof (c as DdnsEntry).name === "string" && typeof (c as DdnsEntry).provider === "string",
    );
  } catch {
    return [];
  }
}

export function writeConfig(configDir: string, entries: DdnsEntry[]): void {
  const file = configPath(configDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n", "utf8");
  chmodSync(tmp, 0o600); // holds API tokens
  renameSync(tmp, file);
}
