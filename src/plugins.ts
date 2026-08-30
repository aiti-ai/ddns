/** Plugin system — third-party providers without touching this repo.
 *
 *  Three ways a provider can be added:
 *   1. discoverPlugins()  — scan node_modules for packages named
 *      `ddns-provider-*` (and `@scope/ddns-provider-*`); the package's
 *      default export (or named `plugin`) is a DdnsPlugin. Callers just
 *      `npm install ddns-provider-foo` and it works.
 *   2. registerProvider(name, factory) — direct programmatic registration.
 *   3. registerPlugin(plugin) — register a whole plugin object (used by
 *      hosts that bundle plugins themselves).
 *
 *  Plugin contract (what a third-party package must export):
 *
 *    export default {
 *      providers: ["example", { name: "example2", style: "zone" }],
 *      createProvider(cfg) { return new MyProvider(cfg); },
 *      createMock(opts) { return { url, state, stop }; },   // optional
 *    };
 *
 *  createProvider(cfg) receives the flat ProviderConfig (token/secret/…)
 *  and must return a ZoneProvider or PushProvider (see types.ts).
 */

import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DnsProvider, ProviderConfig } from "./types.ts";

export interface PluginProviderSpec {
  name: string;
  style: "zone" | "push";
  recordTypes?: string[];
  needsZone?: boolean;
  authFields?: string[];
}

export interface DdnsPlugin {
  /** Plugin display name (logging). */
  name?: string;
  /** Provider names (or specs) this plugin provides. */
  providers: Array<string | PluginProviderSpec>;
  /** Build a provider from the flat config. */
  createProvider(cfg: ProviderConfig): DnsProvider;
  /** Optional: a mock handle ({url, state, stop}) for startMockProvider. */
  createMock?(opts: { zone?: string; cred?: string; port?: number }): unknown;
}

export type ProviderFactory = (cfg: ProviderConfig) => DnsProvider;
export type MockFactory = (opts: { zone?: string; cred?: string; port?: number }) => unknown;

/** Prefix that marks a package as a ddns provider plugin. */
export const PLUGIN_PREFIX = "ddns-provider-";

class PluginRegistry {
  readonly #factories = new Map<string, ProviderFactory>();
  readonly #mocks = new Map<string, MockFactory>();
  readonly #loaded = new Set<string>();

  registerProvider(name: string, factory: ProviderFactory): void {
    this.#factories.set(name, factory);
  }

  registerPlugin(plugin: DdnsPlugin): void {
    for (const p of plugin.providers) {
      const spec = typeof p === "string" ? { name: p } : p;
      this.#factories.set(spec.name, plugin.createProvider);
      if (plugin.createMock) this.#mocks.set(spec.name, plugin.createMock as MockFactory);
    }
  }

  getFactory(name: string): ProviderFactory | undefined {
    return this.#factories.get(name);
  }

  getMock(name: string): MockFactory | undefined {
    return this.#mocks.get(name);
  }

  /** Provider names currently registered by plugins. */
  list(): string[] {
    return [...this.#factories.keys()];
  }

  /** Scan node_modules (cwd upward) for ddns-provider-* packages and load
   *  them. Safe to call repeatedly; each package loads once. */
  discover(cwd = process.cwd()): string[] {
    const found: string[] = [];
    for (const pkg of findPluginPackages(cwd)) {
      if (this.#loaded.has(pkg)) continue;
      this.#loaded.add(pkg);
      try {
        const mod = loadPlugin(pkg, cwd);
        if (mod) {
          this.registerPlugin(mod);
          found.push(pkg);
        }
      } catch (err) {
        // A broken plugin must never break the host — log and continue.
        console.error(`[ddns] plugin '${pkg}' failed to load: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return found;
  }
}

/** Global registry (library default). Hosts can also build their own. */
export const registry = new PluginRegistry();

export function registerProvider(name: string, factory: ProviderFactory): void {
  registry.registerProvider(name, factory);
}

export function registerPlugin(plugin: DdnsPlugin): void {
  registry.registerPlugin(plugin);
}

/** Discover installed ddns-provider-* packages (idempotent). Returns the
 *  package names that were loaded. */
export function discoverPlugins(cwd?: string): string[] {
  return registry.discover(cwd);
}

/** Find ddns-provider-* packages in node_modules dirs from cwd upward. */
function findPluginPackages(cwd: string): string[] {
  const names = new Set<string>();
  for (const nm of nodeModulesDirs(cwd)) {
    try {
      for (const entry of readdirSync(nm)) {
        if (entry.startsWith(PLUGIN_PREFIX)) names.add(entry);
      }
      // scoped packages: @scope/ddns-provider-*
      for (const entry of readdirSync(nm)) {
        if (!entry.startsWith("@")) continue;
        const scopeDir = join(nm, entry);
        if (!existsSync(scopeDir)) continue;
        for (const inner of readdirSync(scopeDir)) {
          if (inner.startsWith(PLUGIN_PREFIX)) names.add(`${entry}/${inner}`);
        }
      }
    } catch {
      // unreadable node_modules — skip
    }
  }
  return [...names];
}

/** node_modules dirs from cwd up to the filesystem root. */
function nodeModulesDirs(start: string): string[] {
  const dirs: string[] = [];
  let cur = resolve(start);
  for (;;) {
    const nm = join(cur, "node_modules");
    if (existsSync(nm)) dirs.push(nm);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

/** Load a plugin package by name. Works for CJS and ESM exports. */
function loadPlugin(pkg: string, cwd: string): DdnsPlugin | null {
  const req = createRequire(join(resolve(cwd), "__ddns_plugin_loader__.cjs"));
  let mod: unknown;
  try {
    mod = req(pkg);
  } catch {
    // try ESM dynamic import as a fallback (works from CJS contexts)
    return null;
  }
  const resolved = (mod as { default?: unknown; plugin?: unknown }) ?? {};
  const plugin = (resolved.default ?? resolved.plugin ?? resolved) as DdnsPlugin | undefined;
  if (!plugin || typeof plugin.createProvider !== "function" || !Array.isArray(plugin.providers)) {
    console.error(`[ddns] plugin '${pkg}' has no valid DdnsPlugin export (need providers[] + createProvider)`);
    return null;
  }
  return plugin;
}
