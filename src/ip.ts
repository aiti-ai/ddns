/** Public IP detection — Go ddns-updater's `publicip` package semantics:
 *  try each source until a valid address of the requested family is found. */

import type { FetchLike } from "./types.ts";

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-f:]+$/i;

/** IPv4 sources, in preference order (ddns-updater external-IP pool:
 *  ipify first, icanhazip fallback). */
export const IPV4_SOURCES = ["https://api.ipify.org", "https://ipv4.icanhazip.com"];
export const IPV6_SOURCES = ["https://api6.ipify.org", "https://ipv6.icanhazip.com"];

const defaultFetch: FetchLike = (url, init) =>
  fetch(url, init as RequestInit).then((r) => ({
    ok: r.ok,
    status: r.status,
    text: () => r.text(),
    json: () => r.json(),
  }));

export function isValidIp(ip: string, family: 4 | 6): boolean {
  return family === 4 ? IPV4_RE.test(ip) : IPV6_RE.test(ip) && ip.includes(":");
}

/** Detect the current public IP of a family. Returns null when every source
 *  fails or returns an invalid address (offline / no IPv6 connectivity). */
export async function resolvePublicIp(family: 4 | 6, fetchImpl: FetchLike = defaultFetch): Promise<string | null> {
  for (const url of family === 4 ? IPV4_SOURCES : IPV6_SOURCES) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) continue;
      const ip = (await res.text()).trim();
      if (isValidIp(ip, family)) return ip;
    } catch {
      // next source
    }
  }
  return null;
}
