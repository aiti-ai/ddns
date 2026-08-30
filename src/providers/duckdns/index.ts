/** duckdns — token-based update-only endpoint (Go ddns-updater's duckdns +
 *  lexicon's duckdns: both GET /v3/update?domains=&token=&ip=, response
 *  "OK"/"KO"). Style: push — records are managed on the duckdns website. */

import type { FetchLike, ProviderConfig, PushProvider } from "../../types.ts";
import { ProviderError, baseUrl } from "../common.ts";

const OFFICIAL = "https://www.duckdns.org";

export interface DuckdnsOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export class DuckdnsProvider implements PushProvider {
  readonly meta = {
    name: "duckdns",
    style: "push",
    recordTypes: ["A", "AAAA"],
    needsZone: false,
    authFields: ["token (duckdns token)"],
  } as const;

  readonly #token: string;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(opts: DuckdnsOptions) {
    if (!opts.token) throw new ProviderError("duckdns requires a token", "duckdns");
    this.#token = opts.token;
    this.#base = baseUrl({ provider: "duckdns", token: opts.token, baseUrl: opts.baseUrl }, OFFICIAL);
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async pushValue(rec: { name: string; type: "A" | "AAAA"; value: string }): Promise<void> {
    const p = new URLSearchParams({ domains: rec.name, token: this.#token });
    if (rec.type === "A") p.set("ip", rec.value);
    else p.set("ipv6", rec.value);
    const res = await this.#fetch(`${this.#base}/v3/update?${p.toString()}`);
    const out = (await res.text()).trim().toUpperCase();
    if (out !== "OK") {
      throw new ProviderError(`duckdns update failed: ${out || `HTTP ${res.status}`}`, "duckdns", res.status);
    }
  }
}

const defaultFetchImpl: FetchLike = (url, init) =>
  fetch(url, init as RequestInit).then((r) => ({
    ok: r.ok,
    status: r.status,
    text: () => r.text(),
    json: () => r.json(),
  }));

/** Create a duckdns provider from a flat ProviderConfig. */
export function createDuckdns(cfg: ProviderConfig): DuckdnsProvider {
  const token = cfg.token ?? process.env.DDNS_DUCKDNS_TOKEN;
  if (!token) throw new ProviderError("duckdns requires cfg.token or DDNS_DUCKDNS_TOKEN", "duckdns");
  return new DuckdnsProvider({ token, baseUrl: cfg.baseUrl });
}
