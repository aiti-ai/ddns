#!/usr/bin/env node
/** Extract RestSpec data from downloaded lexicon provider sources.
 *  Run: node scripts/lexicon-specs.mjs  (reads /tmp/lex-src/*.py) */
import { readdirSync, readFileSync } from "node:fs";

const DIR = "/tmp/lex-src";
const files = readdirSync(DIR).filter((f) => f.endsWith(".py"));

for (const f of files.sort()) {
  const name = f.replace(/\.py$/, "");
  const src = readFileSync(`${DIR}/${f}`, "utf8");

  const endpoint =
    /api_endpoint\s*=\s*\(?[\s\S]{0,40}?"(https?:\/\/[^"]+)/.exec(src)?.[1] ??
    /api_endpoint\s*=\s*"([^"]+)"/.exec(src)?.[1] ??
    /API_BASE_URL\s*=\s*"([^"]+)"/.exec(src)?.[1] ??
    "?";

  // auth mechanism hints
  const authHints = [];
  if (/auth_token|Authorization|Bearer|X-Auth/.test(src)) authHints.push("token/bearer");
  if (/auth_username|auth_password|basic/.test(src)) authHints.push("user/pass");
  if (/api_key|apikey|X-Api|key=/.test(src)) authHints.push("api-key");
  if (/signature|hmac|oauth|secret/.test(src)) authHints.push("signed/oauth");

  // record fields referenced
  const fields = [...new Set([...src.matchAll(/record\["([a-z_]+)"\]/g)].map((m) => m[1]))];

  // endpoint paths
  const gets = [...new Set([...src.matchAll(/self\._get\("([^"]+)"/g)].map((m) => m[1]))];
  const posts = [...new Set([...src.matchAll(/self\._post\("([^"]+)"/g)].map((m) => m[1]))];
  const puts = [...new Set([...src.matchAll(/self\._put\("([^"]+)"/g)].map((m) => m[1]))];
  const deletes = [...new Set([...src.matchAll(/self\._delete\("([^"]+)"/g)].map((m) => m[1]))];

  console.log(`## ${name}`);
  console.log(`endpoint: ${endpoint}`);
  console.log(`auth: ${authHints.join(", ") || "?"}`);
  console.log(`record fields: ${fields.join(", ")}`);
  if (gets.length) console.log(`GET: ${gets.join(" | ")}`);
  if (posts.length) console.log(`POST: ${posts.join(" | ")}`);
  if (puts.length) console.log(`PUT: ${puts.join(" | ")}`);
  if (deletes.length) console.log(`DELETE: ${deletes.join(" | ")}`);
  console.log("");
}
