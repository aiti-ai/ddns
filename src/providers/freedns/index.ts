/** freedns (afraid.org) — push-style updater, Go ddns-updater logic:
 *  GET https://sync.afraid.org/u/<token>/ (v6.sync.afraid.org for IPv6);
 *  the IP is detected by the server from the connection. Response text
 *  decides success: "" → error, "no ip change detected" / "updated " prefix
 *  → ok, anything else → unknown-response error. */

import type { FetchLike, ProviderConfig, PushProvider } from "../../types.ts";
import { ProviderError } from "../common.ts";

const OFFICIAL_V4 = "https://sync.afraid.org";
const OFFICIAL_V6 = "https://v6.sync.afraid.org";

export interface FreednsOptions {
  /** Record token (the long hex string in the afraid.org update URL). */
  token: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export class FreednsProvider implements PushProvider {
  readonly meta = {
    name: "freedns",
    style: "push",
    recordTypes: ["A", "AAAA"],
    needsZone: false,
    authFields: ["token (record update token)"],
    params: [],
  } as const;

  readonly #token: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: FreednsOptions) {
    if (!opts.token) throw new ProviderError("freedns requires a token (record update token)", "freedns");
    this.#token = opts.token;
    this.#base = opts.baseUrl ?? OFFICIAL_V4;
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async pushValue(rec: { name: string; type: "A" | "AAAA"; value: string }): Promise<void> {
    // Go uses the v6 host when updating an IPv6 record
    const base = rec.type === "AAAA" && !this.#base.includes("127.0.0.1") && !this.#base.includes("localhost")
      ? OFFICIAL_V6
      : this.#base;
    const res = await this.#fetch(`${base}/u/${this.#token}/`);
    const s = (await res.text()).trim();
    if (res.status !== 200) {
      throw new ProviderError(`freedns update failed: HTTP ${res.status}: ${s.slice(0, 120)}`, "freedns", res.status);
    }
    if (s === "") {
      throw new ProviderError("freedns update failed: empty response", "freedns");
    }
    if (s.startsWith("no ip change detected") || s.startsWith("updated ")) return;
    throw new ProviderError(`freedns update failed: ${s.slice(0, 120)}`, "freedns");
  }
}

const defaultFetchImpl: FetchLike = (url, init) =>
  fetch(url, init as RequestInit).then((r) => ({
    ok: r.ok,
    status: r.status,
    text: () => r.text(),
    json: () => r.json(),
  }));

/** Create a freedns provider from a flat ProviderConfig. */
export function createFreedns(cfg: ProviderConfig): FreednsProvider {
  const token = cfg.token ?? process.env.DDNS_FREEDNS_TOKEN;
  if (!token) throw new ProviderError("freedns requires cfg.token or DDNS_FREEDNS_TOKEN", "freedns");
  return new FreednsProvider({ token, baseUrl: cfg.baseUrl });
}
