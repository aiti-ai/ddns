/** custom — generic webhook updater (Go ddns-updater's custom provider:
 *  a URL carrying everything except the IP, plus ipv4key/ipv6key query keys
 *  and a success regex against the response body). Style: push. */

import type { FetchLike, ProviderConfig, PushProvider } from "../../types.ts";
import { ProviderError } from "../common.ts";

export interface CustomOptions {
  url: string;
  /** Query key for the IPv4 value ("" = don't send). Default "ipv4". */
  ipv4key?: string;
  /** Query key for the IPv6 value ("" = don't send). Default "ipv6". */
  ipv6key?: string;
  /** Regex against the response body deciding success. Default "good". */
  successRegex?: string;
  fetchImpl?: FetchLike;
}

export class CustomProvider implements PushProvider {
  readonly meta = {
    name: "custom",
    style: "push",
    recordTypes: ["A", "AAAA"],
    needsZone: false,
    authFields: ["url (update endpoint)", "ipv4key", "ipv6key", "successRegex"],
  } as const;

  readonly #url: string;
  readonly #ipv4key: string;
  readonly #ipv6key: string;
  readonly #successRegex: RegExp;
  readonly #fetch: FetchLike;

  constructor(opts: CustomOptions) {
    if (!opts.url) throw new ProviderError("custom requires url (update endpoint)", "custom");
    this.#url = opts.url;
    this.#ipv4key = opts.ipv4key ?? "ipv4";
    this.#ipv6key = opts.ipv6key ?? "ipv6";
    this.#successRegex = new RegExp(opts.successRegex ?? "good");
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
  }

  async pushValue(rec: { name: string; type: "A" | "AAAA"; value: string }): Promise<void> {
    const u = new URL(this.#url);
    const key = rec.type === "A" ? this.#ipv4key : this.#ipv6key;
    if (key) u.searchParams.set(key, rec.value);
    const res = await this.#fetch(u.toString());
    const body = (await res.text()).trim();
    if (!this.#successRegex.test(body)) {
      throw new ProviderError(
        `custom update failed: response '${body.slice(0, 120)}' does not match successRegex '${this.#successRegex.source}'`,
        "custom",
        res.status,
      );
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

/** Create a custom provider from a flat ProviderConfig. */
export function createCustom(cfg: ProviderConfig): CustomProvider {
  const url = cfg.url ?? process.env.DDNS_CUSTOM_URL;
  if (!url) throw new ProviderError("custom requires cfg.url (update endpoint) or DDNS_CUSTOM_URL", "custom");
  return new CustomProvider({
    url,
    ipv4key: cfg.ipv4key,
    ipv6key: cfg.ipv6key,
    successRegex: cfg.successRegex,
  });
}
