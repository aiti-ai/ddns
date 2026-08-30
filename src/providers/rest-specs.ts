/** REST zone-API service registry — each spec extracted from the Go
 *  ddns-updater source (endpoints, auth, response JSON shapes). */

import type { RestSpec } from "./rest.ts";

export const REST_SPECS: RestSpec[] = [
  // digitalocean: GET /v2/domains/:zone/records → {domain_records:[...]}
  {
    name: "digitalocean",
    baseUrl: "https://api.digitalocean.com/v2",
    auth: { type: "bearer", cfgField: "token", env: "DDNS_DIGITALOCEAN_TOKEN" },
    list: {
      path: (z) => `/domains/${z}/records`,
      recordsPath: ["domain_records"],
    },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => {
        const n = String(r.name ?? "");
        const d = r.domain ? String(r.domain) : "";
        if (!d) return n;
        return n === "@" ? d : n.endsWith(`.${d}`) ? n : `${n}.${d}`;
      },
      value: (r) => String(r.data),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
      proxied: (r) => Boolean(r.proxied),
    },
    create: {
      path: (z, _zid, rec) => `/domains/${z}/records`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name.split(".")[0] === "@" ? "@" : rec.name, data: rec.value, ttl: rec.ttl ?? 1800 }),
      idPath: ["domain_record", "id"],
    },
    update: {
      path: (_z, id) => `/domains/${_z}/records/${id}`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name, data: rec.value, ttl: rec.ttl ?? 1800 }),
    },
    delete: { path: (_z, id) => `/domains/${_z}/records/${id}` },
  },

  // gandi: GET /v5/livedns/domains/:zone/records → {rrset_name, rrset_type, rrset_values:[...]}
  {
    name: "gandi",
    baseUrl: "https://api.gandi.net/v5/livedns",
    auth: { type: "bearer", cfgField: "token", env: "DDNS_GANDI_TOKEN" },
    list: {
      path: (z) => `/domains/${z}/records`,
      recordsPath: ["records"],
    },
    fields: {
      id: (r) => `${r.rrset_name}/${r.rrset_type}`,
      type: (r) => String(r.rrset_type),
      name: (r) => {
        const n = String(r.rrset_name ?? "");
        const d = r.rrset_domain ? String(r.rrset_domain) : "";
        if (!d) return n;
        return n === "@" ? d : n.endsWith(`.${d}`) ? n : `${n}.${d}`;
      },
      value: (r) => String((r.rrset_values as string[])?.[0] ?? ""),
      ttl: (r) => (r.rrset_ttl !== undefined ? Number(r.rrset_ttl) : undefined),
    },
    create: {
      path: (z) => `/domains/${z}/records/{name}/{type}`,
      body: (_z, rec) => ({ rrset_ttl: rec.ttl ?? 300, rrset_values: [rec.value] }),
      method: "POST",
    },
    update: {
      path: (z, id) => {
        const [name] = id.split("/");
        return `/domains/${z}/records/{name}/{type}`;
      },
      body: (_z, rec) => ({ rrset_ttl: rec.ttl ?? 300, rrset_values: [rec.value] }),
      method: "PUT",
    },
    delete: {
      path: (z, id) => {
        const [name] = id.split("/");
        return `/domains/${z}/records/{name}/{type}`;
      },
    },
  },

  // godaddy: GET /v1/domains/:zone/records/:type/:name → array
  {
    name: "godaddy",
    idOrder: "type-name",
    baseUrl: "https://api.godaddy.com/v1",
    auth: { type: "header", header: "Authorization", cfgField: "token", env: "DDNS_GODADDY_TOKEN" },
    list: {
      path: (z) => `/domains/${z}/records`,
      recordsPath: [],
    },
    fields: {
      id: (r) => `${r.type}/${r.name}`,
      type: (r) => String(r.type),
      name: (r) => {
        const n = String(r.name ?? "");
        const d = r.domain ? String(r.domain) : "";
        if (!d) return n;
        return n === "@" ? d : n.endsWith(`.${d}`) ? n : `${n}.${d}`;
      },
      value: (r) => String(r.data),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z, _zid, rec) => `/domains/${z}/records`,
      body: (_z, rec) => [{ type: rec.type, name: rec.name.split(".")[0] === "@" ? "@" : rec.name, data: rec.value, ttl: rec.ttl ?? 600 }],
      idPath: ["0", "id"],
    },
    update: {
      path: (z, id) => {
        const [type] = id.split("/");
        return `/domains/${z}/records/${type}/{name}`;
      },
      body: (_z, rec) => [{ type: rec.type, name: rec.name.split(".")[0] === "@" ? "@" : rec.name, data: rec.value, ttl: rec.ttl ?? 600 }],
      method: "PUT",
    },
    delete: {
      path: (z, id) => {
        const [type] = id.split("/");
        return `/domains/${z}/records/${type}/{name}`;
      },
    },
  },

  // hostinger: GET /api/dns/v1/zones/:zoneId/records (zone lookup by name first)
  {
    name: "hostinger",
    baseUrl: "https://developers.hostinger.com/api/dns/v1",
    auth: { type: "header", header: "Authorization", cfgField: "token", env: "DDNS_HOSTINGER_TOKEN" },
    zoneIdLookup: { path: () => `/zones`, idPath: "zones.0.id" },
    list: {
      path: (_z, zid) => `/zones/${zid}/records`,
      recordsPath: ["records"],
    },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => String(r.name),
      value: (r) => String(r.content),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (_z, zid) => `/zones/${zid}/records`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name, content: rec.value, ttl: rec.ttl ?? 300 }),
      idPath: ["record", "id"],
    },
    update: {
      path: (_z, id, zid) => `/zones/${zid}/records/${id}`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name, content: rec.value, ttl: rec.ttl ?? 300 }),
    },
    delete: { path: (_z, id, zid) => `/zones/${zid}/records/${id}` },
  },

  // ionos: X-API-Key, zones → records
  {
    name: "ionos",
    baseUrl: "https://api.hosting.ionos.com/dns/v1",
    auth: { type: "header", header: "X-API-Key", cfgField: "token", env: "DDNS_IONOS_TOKEN" },
    zoneIdLookup: { path: () => `/zones`, idPath: "zones.0.id" },
    list: {
      path: (_z, zid) => `/zones/${zid}/records`,
      recordsPath: ["records"],
    },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => String(r.name),
      value: (r) => String(r.content),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (_z, zid) => `/zones/${zid}/records`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name, content: rec.value, ttl: rec.ttl ?? 3600 }),
      idPath: ["records", "0", "id"],
    },
    update: {
      path: (_z, id, zid) => `/zones/${zid}/records/${id}`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name, content: rec.value, ttl: rec.ttl ?? 3600 }),
    },
    delete: { path: (_z, id, zid) => `/zones/${zid}/records/${id}` },
  },

  // linode: GET /v4/domains/:id/records (numeric zone id)
  {
    name: "linode",
    baseUrl: "https://api.linode.com/v4",
    auth: { type: "bearer", cfgField: "token", env: "DDNS_LINODE_TOKEN" },
    zoneIdLookup: { path: () => `/domains`, idPath: "data.0.id" },
    list: {
      path: (_z, zid) => `/domains/${zid}/records`,
      recordsPath: ["data"],
    },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => String(r.name),
      value: (r) => String(r.target),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (_z, zid) => `/domains/${zid}/records`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name, target: rec.value, ttl: rec.ttl ?? 300 }),
      idPath: ["id"],
    },
    update: {
      path: (_z, id, zid) => `/domains/${zid}/records/${id}`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name, target: rec.value, ttl: rec.ttl ?? 300 }),
    },
    delete: { path: (_z, id, zid) => `/domains/${zid}/records/${id}` },
  },

  // luadns: GET /v1/zones → {zones:[...]}, records under /v1/zones/:id/records
  {
    name: "luadns",
    baseUrl: "https://api.luadns.com/v1",
    auth: { type: "basic", cfgField: "token", env: "DDNS_LUADNS_TOKEN" },
    zoneIdLookup: { path: () => `/zones`, idPath: "zones.0.id" },
    list: {
      path: (_z, zid) => `/zones/${zid}/records`,
      recordsPath: ["records"],
    },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => String(r.name),
      value: (r) => String(r.content),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (_z, zid) => `/zones/${zid}/records`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name, content: rec.value, ttl: rec.ttl ?? 300 }),
      idPath: ["id"],
    },
    update: {
      path: (_z, id, zid) => `/zones/${zid}/records/${id}`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name, content: rec.value, ttl: rec.ttl ?? 300 }),
    },
    delete: { path: (_z, id, zid) => `/zones/${zid}/records/${id}` },
  },

  // namecom: GET /v4/domains/:zone/records → {records:[...]}
  {
    name: "namecom",
    baseUrl: "https://api.name.com/v4",
    auth: { type: "basic", cfgField: "token", env: "DDNS_NAMECOM_TOKEN" },
    list: {
      path: (z) => `/domains/${z}/records`,
      recordsPath: ["records"],
    },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => {
        const h = String(r.host ?? "");
        const d = r.domain ? String(r.domain) : "";
        if (!d) return String(r.name ?? h);
        return h === "" ? d : h.endsWith(`.${d}`) ? h : `${h}.${d}`;
      },
      value: (r) => String(r.answer),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z, _zid, rec) => `/domains/${z}/records`,
      body: (z, rec) => ({ type: rec.type, host: rec.name === z ? "" : rec.name.replace(`.${z}`, ""), answer: rec.value, ttl: rec.ttl ?? 300 }),
      idPath: ["record", "id"],
    },
    update: {
      path: (z, id) => `/domains/${z}/records/${id}`,
      body: (z, rec) => ({ type: rec.type, host: rec.name === z ? "" : rec.name.replace(`.${z}`, ""), answer: rec.value, ttl: rec.ttl ?? 300 }),
    },
    delete: { path: (z, id) => `/domains/${z}/records/${id}` },
  },

  // porkbun: JSON envelope API (no auth header; secret key in body)
  {
    name: "porkbun",
    baseUrl: "https://api.porkbun.com/api/json/v3",
    auth: { type: "query", queryKey: "x", cfgField: "token" },
    list: {
      path: (z) => `/dns/retrieve/${z}`,
      recordsPath: ["records"],
    },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => String(r.name),
      value: (r) => String(r.content),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z, _zid, rec) => `/dns/create/${z}`,
      body: (z, rec) => ({ name: rec.name === z ? "" : rec.name.replace(`.${z}`, ""), type: rec.type, content: rec.value, ttl: rec.ttl ?? 600 }),
      idPath: ["id"],
    },
    update: {
      path: (z, id) => `/dns/edit/${z}/${id}`,
      body: (z, rec) => ({ name: rec.name === z ? "" : rec.name.replace(`.${z}`, ""), type: rec.type, content: rec.value, ttl: rec.ttl ?? 600 }),
    },
    delete: { path: (z, id) => `/dns/delete/${z}/${id}` },
  },

  // scaleway: GET /domain/v2beta1/dns-zones/:zone/records
  {
    name: "scaleway",
    baseUrl: "https://api.scaleway.com/domain/v2beta1",
    auth: { type: "bearer", cfgField: "token", env: "DDNS_SCALEWAY_TOKEN" },
    list: {
      path: (z) => `/dns-zones/${z}/records`,
      recordsPath: ["records"],
    },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => String(r.name),
      value: (r) => String(r.data),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z, _zid, rec) => `/dns-zones/${z}/records`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name, data: rec.value, ttl: rec.ttl ?? 300 }),
      idPath: ["id"],
    },
    update: {
      path: (z, id) => `/dns-zones/${z}/records/${id}`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name, data: rec.value, ttl: rec.ttl ?? 300 }),
    },
    delete: { path: (z, id) => `/dns-zones/${z}/records/${id}` },
  },

  // servercow: GET /dns/v1/domains/:zone/records
  {
    name: "servercow",
    baseUrl: "https://api.servercow.de/dns/v1",
    auth: { type: "bearer", cfgField: "token", env: "DDNS_SERVERCOW_TOKEN" },
    list: {
      path: (z) => `/domains/${z}/records`,
      recordsPath: ["records"],
    },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => String(r.name),
      value: (r) => String(r.content),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z, _zid, rec) => `/domains/${z}/records`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name, content: rec.value, ttl: rec.ttl ?? 300 }),
      idPath: ["id"],
    },
    update: {
      path: (z, id) => `/domains/${z}/records/${id}`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name, content: rec.value, ttl: rec.ttl ?? 300 }),
    },
    delete: { path: (z, id) => `/domains/${z}/records/${id}` },
  },

  // vultr: GET /v2/domains/:zone/records → {records:[...]}
  {
    name: "vultr",
    baseUrl: "https://api.vultr.com/v2",
    auth: { type: "bearer", cfgField: "token", env: "DDNS_VULTR_TOKEN" },
    list: {
      path: (z) => `/domains/${z}/records`,
      recordsPath: ["records"],
    },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => String(r.name),
      value: (r) => String(r.data),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z, _zid, rec) => `/domains/${z}/records`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name, data: rec.value, ttl: rec.ttl ?? 300 }),
      idPath: ["record", "id"],
    },
    update: {
      path: (z, id) => `/domains/${z}/records/${id}`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name, data: rec.value, ttl: rec.ttl ?? 300 }),
    },
    delete: { path: (z, id) => `/domains/${z}/records/${id}` },
  },

  // hetznercloud: GET /v1/records → {records:[...]} (filter by zone_id)
  {
    name: "hetznercloud",
    baseUrl: "https://api.hetzner.cloud/v1",
    auth: { type: "bearer", cfgField: "token", env: "DDNS_HETZNERCLOUD_TOKEN" },
    list: {
      path: (z) => `/records?zone_id=${z}`,
      recordsPath: ["records"],
    },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => (r.name === "" ? `${r.zone_id ?? ""}` : `${r.name}`),
      value: (r) => String(r.value),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z, _zid, rec) => `/records`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl ?? 300, zone_id: _z }),
      idPath: ["record", "id"],
    },
    update: {
      path: (_z, id) => `/records/${id}`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl ?? 300 }),
    },
    delete: { path: (_z, id) => `/records/${id}` },
  },

  // bunny: GET /dnszone/:id/records (zone id lookup via /dnszone?page=)
  {
    name: "bunny",
    baseUrl: "https://api.bunny.net",
    auth: { type: "header", header: "AccessKey", cfgField: "token", env: "DDNS_BUNNY_TOKEN" },
    zoneIdLookup: { path: () => `/dnszone?page=1&per_page=100`, idPath: "items.0.id" },
    list: {
      path: (_z, zid) => `/dnszone/${zid}/records`,
      recordsPath: ["records"],
    },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => String(r.name),
      value: (r) => String(r.value),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (_z, zid) => `/dnszone/${zid}/records`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl ?? 300 }),
      idPath: ["id"],
    },
    update: {
      path: (_z, id, zid) => `/dnszone/${zid}/records/${id}`,
      body: (_z, rec) => ({ type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl ?? 300 }),
    },
    delete: { path: (_z, id, zid) => `/dnszone/${zid}/records/${id}` },
  },

  // ---------- lexicon-only providers (shapes from dns-lexicon source) ----------

  // dnsimple: /accounts → id → /{account}/zones/{zone}/records
  {
    name: "dnsimple",
    baseUrl: "https://api.dnsimple.com/v2",
    auth: { type: "bearer", cfgField: "token", env: "DDNS_DNSIMPLE_TOKEN" },
    preLookups: [{ path: () => "/accounts", idPath: "0.id", name: "account" }],
    list: { path: (z, _zid, aid) => `/${aid}/zones/${z}/records`, recordsPath: ["data"] },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => String(r.name),
      value: (r) => String(r.content),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z, _zid, rec, aid) => `/${aid}/zones/${z}/records`,
      body: (z, rec) => ({ type: rec.type, name: rec.name.split(".")[0] === "@" ? "@" : rec.name, content: rec.value, ttl: rec.ttl ?? 3600 }),
      idPath: ["data", "id"],
    },
    update: {
      path: (z, id, _zid, aid) => `/${aid}/zones/${z}/records/${id}`,
      body: (z, rec) => ({ type: rec.type, name: rec.name.split(".")[0] === "@" ? "@" : rec.name, content: rec.value, ttl: rec.ttl ?? 3600 }),
      method: "PATCH",
    },
    delete: { path: (z, id, _zid, aid) => `/${aid}/zones/${z}/records/${id}` },
  },

  // cloudns: /dns/records.json + add/mod/delete
  {
    name: "cloudns",
    baseUrl: "https://api.cloudns.net",
    auth: { type: "query", queryKey: "auth-id", cfgField: "token" },
    list: { path: (z) => `/dns/records.json?domain-name=${z}`, recordsPath: [] },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => {
        const h = String(r.host ?? "");
        const d = r.domain ? String(r.domain) : "";
        if (!d) return h;
        return h === "@" ? d : h.endsWith(`.${d}`) ? h : `${h}.${d}`;
      },
      value: (r) => String(r.record),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z) => `/dns/add-record.json?domain-name=${z}`,
      body: (z, rec) => ({ host: rec.name.split(".")[0] === "@" ? "" : rec.name, record_type: rec.type, record: rec.value, ttl: rec.ttl ?? 3600 }),
      method: "POST",
    },
    update: {
      path: (z, id) => `/dns/mod-record.json?domain-name=${z}&record-id=${id}`,
      body: (z, rec) => ({ host: rec.name.split(".")[0] === "@" ? "" : rec.name, record_type: rec.type, record: rec.value, ttl: rec.ttl ?? 3600 }),
      method: "POST",
    },
    delete: { path: (z, id) => `/dns/delete-record.json?domain-name=${z}&record-id=${id}`, method: "POST" },
  },

  // glesys: /domain/list → records (host/data)
  {
    name: "glesys",
    baseUrl: "https://api.glesys.com",
    auth: { type: "basic", cfgField: "token", env: "DDNS_GLESYS_TOKEN" },
    zoneIdLookup: { path: () => `/domain/list`, idPath: "response.records.0.domainname" },
    list: { path: (z, zid) => `/domain/list_records/${z}`, recordsPath: ["response", "records"] },
    fields: {
      id: (r) => String(r.recordid ?? r.id),
      type: (r) => String(r.type),
      name: (r) => String(r.name ?? r.host ?? ""),
      value: (r) => String(r.data ?? r.content),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z) => `/domain/add_record/${z}`,
      body: (z, rec) => ({ host: rec.name.split(".")[0] === "@" ? "" : rec.name, type: rec.type, data: rec.value, ttl: rec.ttl ?? 3600 }),
      method: "POST",
    },
    update: {
      path: (z, id) => `/domain/update_record/${z}/${id}`,
      body: (z, rec) => ({ host: rec.name.split(".")[0] === "@" ? "" : rec.name, type: rec.type, data: rec.value, ttl: rec.ttl ?? 3600 }),
      method: "POST",
    },
    delete: { path: (z, id) => `/domain/delete_record/${z}/${id}`, method: "POST" },
  },

  // regfish: /api/v1/domain/{zone}/records (data field)
  {
    name: "regfish",
    baseUrl: "https://api.regfish.de/api/v1",
    auth: { type: "header", header: "Authorization", cfgField: "token", env: "DDNS_REGFISH_TOKEN" },
    list: { path: (z) => `/domain/${z}/records`, recordsPath: ["data"] },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => String(r.name),
      value: (r) => String(r.data ?? r.content),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z) => `/domain/${z}/records`,
      body: (z, rec) => ({ type: rec.type, name: rec.name, data: rec.value, ttl: rec.ttl ?? 3600 }),
      idPath: ["data", "id"],
    },
    update: {
      path: (z, id) => `/domain/${z}/records/${id}`,
      body: (z, rec) => ({ type: rec.type, name: rec.name, data: rec.value, ttl: rec.ttl ?? 3600 }),
    },
    delete: { path: (z, id) => `/domain/${z}/records/${id}` },
  },

  // internetbs: /Domain/DnsRecord/List + Add + Update
  {
    name: "internetbs",
    baseUrl: "https://api.internet.bs",
    auth: { type: "query", queryKey: "api_key", cfgField: "token" },
    list: { path: (z) => `/Domain/DnsRecord/List?Domain=${z}`, recordsPath: ["records"] },
    fields: {
      id: (r) => String(r.id ?? ""),
      type: (r) => String(r.type),
      name: (r) => String(r.name),
      value: (r) => String(r.value),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z) => `/Domain/DnsRecord/Add?Domain=${z}`,
      body: (z, rec) => ({ Type: rec.type, Name: rec.name, Value: rec.value, TTL: rec.ttl ?? 3600 }),
      method: "POST",
    },
    update: {
      path: (z, id) => `/Domain/DnsRecord/Update?Domain=${z}&FullRecordID=${id}`,
      body: (z, rec) => ({ Type: rec.type, Name: rec.name, Value: rec.value, TTL: rec.ttl ?? 3600 }),
      method: "POST",
    },
    delete: { path: (z, id) => `/Domain/DnsRecord/Remove?Domain=${z}&FullRecordID=${id}`, method: "POST" },
  },

  // pointhq: /zones/{zone}/records
  {
    name: "pointhq",
    baseUrl: "https://pointhq.com",
    auth: { type: "basic", cfgField: "token", env: "DDNS_POINTHQ_TOKEN" },
    list: { path: (z) => `/zones/${z}/records`, recordsPath: [] },
    fields: {
      id: (r) => {
        const rec = (r.record_details ?? r.record) as Record<string, unknown> | undefined;
        return String(rec?.id ?? r.id ?? "");
      },
      type: (r) => {
        const rec = (r.record_details ?? r.record) as Record<string, unknown> | undefined;
        return String(rec?.record_type ?? r.type);
      },
      name: (r) => {
        const rec = (r.record_details ?? r.record) as Record<string, unknown> | undefined;
        return String(rec?.name ?? r.name);
      },
      value: (r) => {
        const rec = (r.record_details ?? r.record) as Record<string, unknown> | undefined;
        return String(rec?.data ?? r.data);
      },
      ttl: (r) => {
        const rec = (r.record_details ?? r.record) as Record<string, unknown> | undefined;
        const t = rec?.ttl ?? r.ttl;
        return t !== undefined ? Number(t) : undefined;
      },
    },
    create: {
      path: (z) => `/zones/${z}/records`,
      body: (z, rec) => ({ record: { record_type: rec.type, name: rec.name, data: rec.value, ttl: rec.ttl ?? 3600 } }),
      method: "POST",
    },
    update: {
      path: (z, id) => `/zones/${z}/records/${id}`,
      body: (z, rec) => ({ record: { record_type: rec.type, name: rec.name, data: rec.value, ttl: rec.ttl ?? 3600 } }),
      method: "PATCH",
    },
    delete: { path: (z, id) => `/zones/${z}/records/${id}` },
  },

  // rage4: /rapi/createrecord / updaterecord / deleterecord
  {
    name: "rage4",
    baseUrl: "https://rage4.com/rapi",
    auth: { type: "query", queryKey: "accountKey", cfgField: "token" },
    list: { path: (z) => `/getrecords?domain=${z}`, recordsPath: [] },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => String(r.name),
      value: (r) => String(r.content),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z) => `/createrecord?domain=${z}`,
      body: (z, rec) => ({ name: rec.name, type: rec.type, content: rec.value, ttl: rec.ttl ?? 3600 }),
      method: "POST",
    },
    update: {
      path: (z, _id) => `/updaterecord?domain=${z}&id={id}`,
      body: (z, rec) => ({ name: rec.name, type: rec.type, content: rec.value, ttl: rec.ttl ?? 3600 }),
      method: "POST",
    },
    delete: { path: (z, _id) => `/deleterecord?domain=${z}&id={id}`, method: "POST" },
  },

  // online.net: /api/v1/domain/{zone}/version/records
  {
    name: "online",
    baseUrl: "https://api.online.net/api/v1",
    auth: { type: "bearer", cfgField: "token", env: "DDNS_ONLINE_TOKEN" },
    list: { path: (z) => `/domain/${z}/version/records`, recordsPath: [] },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => String(r.name),
      value: (r) => String(r.data),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z) => `/domain/${z}/version/records`,
      body: (z, rec) => ({ type: rec.type, name: rec.name, data: rec.value, ttl: rec.ttl ?? 3600 }),
      idPath: ["id"],
    },
    update: {
      path: (z, id) => `/domain/${z}/version/records/${id}`,
      body: (z, rec) => ({ type: rec.type, name: rec.name, data: rec.value, ttl: rec.ttl ?? 3600 }),
      method: "PATCH",
    },
    delete: { path: (z, id) => `/domain/${z}/version/records/${id}` },
  },

  // timeweb: /api/v1/domains/{zone}/dns-records
  {
    name: "timeweb",
    baseUrl: "https://api.timeweb.cloud/api/v1",
    auth: { type: "bearer", cfgField: "token", env: "DDNS_TIMEWEB_TOKEN" },
    list: { path: (z) => `/domains/${z}/dns-records`, recordsPath: ["dns_records"] },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => String(r.name),
      value: (r) => String(r.value),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z) => `/domains/${z}/dns-records`,
      body: (z, rec) => ({ type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl ?? 3600 }),
      idPath: ["dns_record", "id"],
    },
    update: {
      path: (z, id) => `/domains/${z}/dns-records/${id}`,
      body: (z, rec) => ({ type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl ?? 3600 }),
      method: "PATCH",
    },
    delete: { path: (z, id) => `/domains/${z}/dns-records/${id}` },
  },

  // zonomi: /app/dns/query.jsp + modify.jsp (SET)
  {
    name: "zonomi",
    baseUrl: "https://zonomi.com/app",
    auth: { type: "query", queryKey: "api_key", cfgField: "token" },
    list: { path: (z) => `/dns/query.jsp?name=${z}`, recordsPath: ["zones", "0", "records"] },
    fields: {
      id: (r) => String(r.name ?? r.id ?? ""),
      type: (r) => String(r.type),
      name: (r) => String(r.name),
      value: (r) => String(r.content),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z) => `/dns/modify.jsp?name=${z}`,
      body: (z, rec) => ({ action: "SET", type: rec.type, name: rec.name, content: rec.value, ttl: rec.ttl ?? 3600 }),
      method: "POST",
    },
    update: {
      path: (z) => `/dns/modify.jsp?name=${z}`,
      body: (z, rec) => ({ action: "SET", type: rec.type, name: rec.name, content: rec.value, ttl: rec.ttl ?? 3600 }),
      method: "POST",
    },
    delete: { path: (z, id) => `/dns/delete.jsp?name={id}`, method: "POST" },
  },

  // dnspark: /v2/domains/{zone}/records (rtype/rname/rdata)
  {
    name: "dnspark",
    baseUrl: "https://api.dnspark.com/v2",
    auth: { type: "bearer", cfgField: "token", env: "DDNS_DNSPARK_TOKEN" },
    list: { path: (z) => `/domains/${z}/records`, recordsPath: ["records"] },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => String(r.name),
      value: (r) => String(r.data ?? r.value),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z) => `/domains/${z}/records`,
      body: (z, rec) => ({ type: rec.type, name: rec.name, data: rec.value, ttl: rec.ttl ?? 3600 }),
      idPath: ["record", "id"],
    },
    update: {
      path: (z, id) => `/domains/${z}/records/${id}`,
      body: (z, rec) => ({ type: rec.type, name: rec.name, data: rec.value, ttl: rec.ttl ?? 3600 }),
      method: "PATCH",
    },
    delete: { path: (z, id) => `/domains/${z}/records/${id}` },
  },

  // flexibleengine: /v2/zones/{zone}/recordsets (X-Auth-Token)
  {
    name: "flexibleengine",
    baseUrl: "https://dns.prod-cloud-ocb.orange-business.com/v2",
    auth: { type: "header", header: "X-Auth-Token", cfgField: "token", env: "DDNS_FLEXIBLEENGINE_TOKEN" },
    list: { path: (z) => `/zones/${z}/recordsets`, recordsPath: ["recordsets"] },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => String(r.name),
      value: (r) => String((r.records as string[] | undefined)?.[0] ?? ""),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z) => `/zones/${z}/recordsets`,
      body: (z, rec) => ({ name: rec.name, type: rec.type, records: [rec.value], ttl: rec.ttl ?? 3600 }),
      idPath: ["id"],
    },
    update: {
      path: (z, id) => `/zones/${z}/recordsets/${id}`,
      body: (z, rec) => ({ name: rec.name, type: rec.type, records: [rec.value], ttl: rec.ttl ?? 3600 }),
      method: "PUT",
    },
    delete: { path: (z, id) => `/zones/${z}/recordsets/${id}` },
  },

  // conoha: /v1/domains/{zone}/records (data)
  {
    name: "conoha",
    baseUrl: "https://dns-service.region.conoha.io/v1",
    auth: { type: "bearer", cfgField: "token", env: "DDNS_CONOHA_TOKEN" },
    list: { path: (z) => `/domains/${z}/records`, recordsPath: ["records"] },
    fields: {
      id: (r) => String(r.id),
      type: (r) => String(r.type),
      name: (r) => String(r.name),
      value: (r) => String(r.data),
      ttl: (r) => (r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z) => `/domains/${z}/records`,
      body: (z, rec) => ({ type: rec.type, name: rec.name, data: rec.value, ttl: rec.ttl ?? 3600 }),
      idPath: ["id"],
    },
    update: {
      path: (z, id) => `/domains/${z}/records/${id}`,
      body: (z, rec) => ({ type: rec.type, name: rec.name, data: rec.value, ttl: rec.ttl ?? 3600 }),
      method: "PUT",
    },
    delete: { path: (z, id) => `/domains/${z}/records/${id}` },
  },

  // sakuracloud: /cloud/1.1/zone/{zone}/record (X-Xack-API-Key: access:secret)
  {
    name: "sakuracloud",
    idFromName: true,
    baseUrl: "https://secure.sakura.ad.jp/cloud/zone/is1a/api/cloud/1.1",
    auth: { type: "header", header: "X-Xack-API-Key", cfgField: "token", env: "DDNS_SAKURACLOUD_TOKEN" },
    list: { path: (z) => `/zone/${z}/record`, recordsPath: ["CommonServiceItem", "Settings", "DNS", "ResourceRecordSets"] },
    // (deep nesting handled by the mock's superset shape)
    fields: {
      id: (r) => String(r.Name ?? r.name ?? r.id ?? ""),
      type: (r) => String(r.Type ?? r.type),
      name: (r) => String(r.Name ?? r.name),
      value: (r) => String(r.RData ?? r.content),
      ttl: (r) => (r.TTL !== undefined ? Number(r.TTL) : r.ttl !== undefined ? Number(r.ttl) : undefined),
    },
    create: {
      path: (z) => `/zone/${z}/record`,
      body: (z, rec) => ({ CommonServiceItem: { Settings: { DNS: { ResourceRecordSets: [{ Name: rec.name, Type: rec.type, RData: rec.value, TTL: rec.ttl ?? 3600 }] } } } }),
      method: "POST",
    },
    update: {
      path: (z, id) => `/zone/${z}/record/${id}`,
      body: (z, rec) => ({ CommonServiceItem: { Settings: { DNS: { ResourceRecordSets: [{ Name: rec.name, Type: rec.type, RData: rec.value, TTL: rec.ttl ?? 3600 }] } } } }),
      method: "PUT",
    },
    delete: { path: (z, id) => `/zone/${z}/record/${id}` },
  },
];export const REST_SPEC_NAMES: string[] = REST_SPECS.map((s) => s.name);
