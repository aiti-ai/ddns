/** dyndns2 service registry — every update-only service Go ddns-updater
 *  implements, declared as data. Each entry maps 1:1 to the Go provider's
 *  URL + response semantics (verified against the Go source). */

import type { DyndnsSpec } from "./dyndns.ts";

export const DYNDNS_SERVICES: DyndnsSpec[] = [
  // -- dyndns2 standard (basic auth, good/nochg) --
  { name: "allinkl", url: "https://dyndns.kasserver.com/", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "changeip", url: "https://nic.changeip.com/nic/update", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "dd24", url: "https://dynamicdns.key-systems.net/update.php", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "ddnss", url: "https://www.ddnss.de/upd.php", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "dnsomatic", url: "https://updates.dnsomatic.com/nic/update", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "dyn", url: "https://members.dyndns.org/v3/update", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "dynu", url: "https://api.dynu.com/nic/update", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "dynv6", url: "https://dynv6.com/api/update", userField: "token", tokenOnly: true, successPrefixes: ["addresses updated"], noChangePrefixes: ["addresses unchanged"] },
  { name: "easydns", url: "https://api.cp.easydns.com/dyn/generic.php", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "gigahostno", url: "https://api.gigahost.no/api/v0/dns/dyndns", userField: "username", successPrefixes: ["good"], noChangePrefixes: ["nochg"] },
  { name: "goip", url: "https://www.goip.de/setip", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "he", url: "https://dyn.dns.he.net/nic/update", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "infomaniak", url: "https://infomaniak.com/nic/update", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "inwx", url: "https://dyndns.inwx.com/nic/update", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "ipv64", url: "https://ipv64.net/nic/update", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "loopia", url: "https://dyndns.loopia.se/", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "myaddr", url: "https://myaddr.tools/update", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "njalla", url: "https://njal.la/update/", userField: "token", tokenOnly: true, successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "noip", url: "https://dynupdate.no-ip.com/nic/update", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "nowdns", url: "https://now-dns.com/update", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "opendns", url: "https://updates.opendns.com/nic/update", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "ovh", url: "https://www.ovh.com/nic/update", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "selfhostde", url: "https://carol.selfhost.de/nic/update", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "spdyn", url: "https://update.spdyn.de/nic/update", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "strato", url: "https://dyndns.strato.com/nic/update", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "variomedia", url: "https://variomedia.de/nic/update", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "zoneedit", url: "https://api.cp.zoneedit.com/dyn/generic.php", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "desec", url: "https://update.dedyn.io/", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
  { name: "domeneshop", url: "https://api.domeneshop.no/v0/dyndns/update", userField: "username", successPrefixes: ["good", "nochg"], noChangePrefixes: ["nochg"] },
];

/** All dyndns2 service names (for registry/CLI listing). */
export const DYNDNS_SERVICE_NAMES: string[] = DYNDNS_SERVICES.map((s) => s.name);
