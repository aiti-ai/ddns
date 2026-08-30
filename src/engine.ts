/** DDNS engine — Go ddns-updater semantics: resolve the public IP, compare
 *  against the current record, push only on change (or create when missing).
 *  Push-style providers (duckdns/custom) always push (they have no readback).
 */

import type { FetchLike, ProviderName } from "./types.ts";
import { resolvePublicIp } from "./ip.ts";
import { createProvider, isPushProvider, type ProviderLike } from "./client.ts";

export interface DdnsEntry {
  /** Local label (config key). */
  name: string;
  provider: ProviderName;
  /** FQDN to keep updated (duckdns: bare label). */
  record: string;
  /** Root zone (required for zone-style providers). */
  zone?: string;
  /** Record type; default "A". */
  type?: "A" | "AAAA";
  ttl?: number;
  /** cloudflare: orange-cloud. */
  proxied?: boolean;
  /** Loop interval seconds (default 300). */
  intervalSec?: number;
  enabled?: boolean;
  /** Pin the IP instead of detecting (offline/testing/static NAT). */
  ip?: string;
  // -- credentials (flat, provider-dependent) --
  token?: string;
  secret?: string;
  accessKeyId?: string;
  zoneId?: string;
  /** custom webhook: update URL. */
  url?: string;
  ipv4key?: string;
  ipv6key?: string;
  successRegex?: string;
  /** Base URL override (tests point providers at their mocks). */
  baseUrl?: string;
}

export interface DdnsResult {
  name: string;
  provider: ProviderName;
  record: string;
  type: "A" | "AAAA";
  ip: string | null;
  changed: boolean;
  skipped?: "disabled" | "no-ip" | "unchanged";
  error?: string;
}

export interface DdnsDeps {
  fetchImpl?: FetchLike;
  /** IP detector override (default: resolvePublicIp). */
  detectIp?: typeof resolvePublicIp;
  log?: (line: string) => void;
}

/** One update cycle for one entry. Never throws — errors land on the result. */
export async function updateEntry(entry: DdnsEntry, deps: DdnsDeps = {}): Promise<DdnsResult> {
  const fetchImpl = deps.fetchImpl;
  const detectIp = deps.detectIp ?? resolvePublicIp;
  const type: "A" | "AAAA" = entry.type ?? "A";
  const base: DdnsResult = {
    name: entry.name,
    provider: entry.provider,
    record: entry.record,
    type,
    ip: null,
    changed: false,
  };
  if (entry.enabled === false) return { ...base, skipped: "disabled" };

  const ip = entry.ip ?? (type === "AAAA" ? await detectIp(6, fetchImpl) : await detectIp(4, fetchImpl));
  if (!ip) return { ...base, skipped: "no-ip" };
  base.ip = ip;

  try {
    const provider = createProvider(entry);
    if (isPushProvider(provider)) {
      // duckdns / custom webhook: no readback, push unconditionally
      await provider.pushValue({ name: entry.record, type, value: ip });
      return { ...base, changed: true };
    }
    const zone = entry.zone;
    if (!zone) throw new Error(`provider '${entry.provider}' is zone-style — entry '${entry.name}' needs zone`);
    const existing = await provider.listRecords(zone, { type, name: entry.record });
    const match = existing.find((r) => r.type === type && r.name === entry.record);
    if (match && match.value === ip) return { ...base, skipped: "unchanged" }; // Go: up-to-date
    if (match) {
      await provider.updateRecord(zone, { type, name: entry.record, value: ip, ttl: entry.ttl, proxied: entry.proxied }, match.id!);
    } else {
      await provider.createRecord(zone, { type, name: entry.record, value: ip, ttl: entry.ttl, proxied: entry.proxied });
    }
    return { ...base, changed: true };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Update every enabled entry once. */
export async function runOnce(entries: DdnsEntry[], deps: DdnsDeps = {}): Promise<DdnsResult[]> {
  return Promise.all(entries.map((e) => updateEntry(e, deps)));
}

export interface DdnsLoopHandle {
  stop(): void;
  /** Run all updates immediately (also used by tests). */
  runOnce(): Promise<DdnsResult[]>;
}

/** Long-running loop: update all entries immediately, then every
 *  min(intervalSec) seconds. The interval timer is unref'd (keeps the daemon
 *  alive only through active work). */
export function startLoop(entries: DdnsEntry[], deps: DdnsDeps = {}): DdnsLoopHandle {
  const log = deps.log ?? (() => {});
  const interval = Math.max(30, Math.min(...entries.map((e) => e.intervalSec ?? 300), Number.MAX_SAFE_INTEGER)) * 1000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const tick = async (): Promise<DdnsResult[]> => {
    if (running) return [];
    running = true;
    try {
      const results = await runOnce(entries, deps);
      for (const r of results) {
        if (r.error) log(`[ddns] ${r.name}: ERROR ${r.error}`);
        else if (r.changed) log(`[ddns] ${r.name}: ${r.record} → ${r.ip} (${r.type})`);
        else if (r.skipped === "no-ip") log(`[ddns] ${r.name}: no public ${r.type === "A" ? "IPv4" : "IPv6"} detected`);
        else log(`[ddns] ${r.name}: unchanged`);
      }
      return results;
    } finally {
      running = false;
    }
  };

  void tick();
  timer = setInterval(() => void tick(), interval);
  timer.unref?.();

  return {
    runOnce: tick,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
