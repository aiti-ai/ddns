/** Generic dyndns2-protocol provider — the update-only service family
 *  (Go ddns-updater implements ~28 of these with near-identical code:
 *  GET https://<host>/<path>?hostname=<record>&myip=<ip> with basic auth;
 *  response body decides success). One config per service below. */

import type { FetchLike, ParamSpec, ProviderConfig, PushProvider } from "../types.ts";
import { ProviderError } from "./common.ts";

export interface DyndnsSpec {
  name: string;
  /** Official endpoint, e.g. "https://dynupdate.no-ip.com/nic/update". */
  url: string;
  /** Username from config field ("username" / "user" / token). */
  userField?: "username" | "user" | "token";
  /** IPv6 host variant (prefix "v6."), like freedns. */
  v6Host?: string;
  /** Whether the endpoint is reachable with empty username (token-only). */
  tokenOnly?: boolean;
  /** Success detection: body prefixes that mean success. */
  successPrefixes: string[];
  /** Body prefixes that mean "no change" (still success, Go treats as ok). */
  noChangePrefixes?: string[];
  /** Status body prefixes that mean hard error. */
  errorPrefixes?: string[];
}

/** Standard dyndns2 "good"/"nochg" responses (most services). */
export const DYNDNS2_SPEC: Omit<DyndnsSpec, "name" | "url" | "userField"> = {
  successPrefixes: ["good", "nochg"],
  noChangePrefixes: ["nochg"],
  errorPrefixes: ["badauth", "notfqdn", "nohost", "abuse", "911", "badagent", "!donator", "blocked"],
};

export class DyndnsProvider implements PushProvider {
  readonly meta: { name: string; style: "push"; recordTypes: ["A", "AAAA"]; needsZone: false; authFields: string[]; params: readonly ParamSpec[] };

  readonly #spec: DyndnsSpec;
  readonly #username: string;
  readonly #password: string;
  readonly #base: string;
  readonly #official: boolean;
  readonly #fetch: FetchLike;

  constructor(spec: DyndnsSpec, opts: { username: string; password: string; baseUrl?: string; fetchImpl?: FetchLike }) {
    if (spec.tokenOnly ? !opts.password : !opts.username) {
      throw new ProviderError(`dyndns provider '${spec.name}' requires credentials`, spec.name);
    }
    this.#spec = spec;
    this.#username = opts.username;
    this.#password = opts.password;
    this.#base = opts.baseUrl ?? spec.url;
    this.#official = !opts.baseUrl;
    this.#fetch = opts.fetchImpl ?? defaultFetchImpl;
    this.meta = {
      name: spec.name,
      style: "push",
      recordTypes: ["A", "AAAA"],
      needsZone: false,
      authFields: spec.tokenOnly ? ["token"] : ["username", "password"],
      params: [],
    };
  }

  async pushValue(rec: { name: string; type: "A" | "AAAA"; value: string }): Promise<void> {
    const u = new URL(this.#base);
    if (this.#spec.v6Host && rec.type === "AAAA" && this.#official) {
      const base = new URL(this.#base);
      base.hostname = this.#spec.v6Host;
      // keep any explicit port
      const parsed = new URL(this.#base);
      if (parsed.port) base.port = parsed.port;
      u.hostname = base.hostname;
      u.port = base.port;
    }
    u.searchParams.set("hostname", rec.name);
    u.searchParams.set("myip", rec.value);

    const headers: Record<string, string> = { "user-agent": "ddns/0.1 (https://github.com/local/ddns)" };
    if (this.#username) {
      headers.authorization = "Basic " + Buffer.from(`${this.#username}:${this.#password}`).toString("base64");
    }
    const res = await this.#fetch(u.toString(), { headers });
    const body = (await res.text()).trim();
    const lower = body.toLowerCase();

    if (this.#spec.errorPrefixes?.some((p) => lower.startsWith(p))) {
      throw new ProviderError(`dyndns '${this.#spec.name}' rejected: ${body.slice(0, 120)}`, this.#spec.name, res.status);
    }
    if (this.#spec.successPrefixes.some((p) => lower.startsWith(p))) return;
    if (this.#spec.noChangePrefixes?.some((p) => lower.startsWith(p))) return;
    if (res.status >= 400) {
      throw new ProviderError(`dyndns '${this.#spec.name}' HTTP ${res.status}: ${body.slice(0, 120)}`, this.#spec.name, res.status);
    }
    throw new ProviderError(`dyndns '${this.#spec.name}' unknown response: ${body.slice(0, 120)}`, this.#spec.name, res.status);
  }
}

const defaultFetchImpl: FetchLike = (url, init) =>
  fetch(url, init as RequestInit).then((r) => ({
    ok: r.ok,
    status: r.status,
    text: () => r.text(),
    json: () => r.json(),
  }));

/** Create a dyndns provider from a flat config (username/password or token). */
export function createDyndns(spec: DyndnsSpec, cfg: ProviderConfig): DyndnsProvider {
  const username = cfg.username ?? (spec.userField === "token" ? "" : process.env[`DDNS_${spec.name.toUpperCase()}_USERNAME`] ?? "");
  const password = cfg.password ?? process.env[`DDNS_${spec.name.toUpperCase()}_PASSWORD`] ?? cfg.token ?? "";
  return new DyndnsProvider(spec, { username, password, baseUrl: cfg.baseUrl });
}
