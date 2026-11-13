#!/usr/bin/env node
// Checks index.json: each entry, and the package it points to.
//
//   node scripts/check-index.mjs [index.json] [--offline]
//
// westerm leaves out an entry it cannot use. This check fails on it instead,
// so a bad entry never reaches the list. The limits and rules follow westerm's
// own (native/src/server/plugins/external/ in SteelCrab/westerm).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export const MAX_PACKAGE_BYTES = 5 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 10 * 1024 * 1024;
export const MAX_ENTRIES = 300;
const MAX_TAR_BYTES = 11 * 1024 * 1024;
const MAX_NAME = 40;
const MAX_DESCRIPTION = 200;

const ENTRY_KEYS = new Set(["id", "name", "description", "repo", "version", "url", "sha256", "permissions"]);
const PERMISSION_KEYS = new Set(["run", "panes", "background"]);

const idPart = /^[a-z0-9-]{1,32}$/;
export const isId = (id) => typeof id === "string" && id.split(".").length === 2 && id.split(".").every((part) => idPart.test(part));
export const isProgramName = (name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
export const isVersion = (version) => typeof version === "string" && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version);
const chars = (text) => [...text].length;
const hasSpaceOrControl = (text) => /[\s\p{Cc}]/u.test(text);

/** Problems with the entries themselves, without downloading anything. */
export function checkEntries(entries) {
  if (!Array.isArray(entries)) return ["index.json must be a JSON array"];
  const problems = [];
  const seen = new Set();
  let previous = "";
  entries.forEach((entry, i) => {
    const where = `index.json[${i}]${typeof entry?.id === "string" ? ` (${entry.id})` : ""}`;
    const bad = (text) => problems.push(`${where}: ${text}`);
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return bad("must be an object");

    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) bad(`unknown key "${key}"`);
    if (!isId(entry.id)) bad("id must be <author>.<name>, each part 1 to 32 of a-z, 0-9, -");
    if (typeof entry.name !== "string" || entry.name === "" || chars(entry.name) > MAX_NAME) bad(`name must be 1 to ${MAX_NAME} characters`);
    if (entry.description !== undefined && (typeof entry.description !== "string" || chars(entry.description) > MAX_DESCRIPTION)) bad(`description must be at most ${MAX_DESCRIPTION} characters`);
    if (typeof entry.repo !== "string" || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/.test(entry.repo)) bad("repo must be https://github.com/<owner>/<repo>");
    if (!isVersion(entry.version)) bad("version must look like 1.2.3");
    if (typeof entry.url !== "string" || !entry.url.startsWith("https://") || hasSpaceOrControl(entry.url)) bad("url must be an https:// link with no spaces");
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) bad("sha256 must be 64 lowercase hex digits");
    problems.push(...checkPermissions(entry.permissions).map((text) => `${where}: ${text}`));

    if (isId(entry.id)) {
      if (seen.has(entry.id)) bad("the id is listed twice");
      if (entry.id < previous) bad(`the list must be sorted by id ("${entry.id}" comes before "${previous}")`);
      seen.add(entry.id);
      previous = entry.id;
    }
  });
  return problems;
}

function checkPermissions(permissions) {
  if (permissions === undefined) return [];
  if (permissions === null || typeof permissions !== "object" || Array.isArray(permissions)) return ["permissions must be an object"];
  const problems = [];
  for (const key of Object.keys(permissions)) if (!PERMISSION_KEYS.has(key)) problems.push(`permissions: unknown key "${key}"`);
  const { run = [], panes = false, background = false } = permissions;
  if (!Array.isArray(run) || !run.every(isProgramName)) problems.push("permissions.run must be a list of program names, such as kubectl");
  else if (new Set(run).size !== run.length) problems.push("permissions.run lists a program twice");
  if (typeof panes !== "boolean") problems.push("permissions.panes must be true or false");
  if (typeof background !== "boolean") problems.push("permissions.background must be true or false");
  return problems;
}

/** The permissions in one form, for comparing an entry with its plugin.json. */
function normalPermissions(permissions = {}) {
  const { run = [], panes = false, background = false } = permissions ?? {};
  return JSON.stringify({ run: [...run].sort(), panes, background });
}

/** Reads a tar archive into its entries. Throws on what westerm refuses. */
export function readTar(tar) {
  const entries = [];
  let longName = null;
  let paxPath = null;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const stored = parseInt(field(148, 8).trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (stored !== sum) throw new Error("the archive is damaged (a header checksum is wrong)");

    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = field(257, 6).startsWith("ustar") ? field(345, 155) : "";
    let name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === "L") { longName = data.toString("utf8").replace(/\0.*$/s, ""); continue; }
    if (type === "x") { paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"))?.[1] ?? null; continue; }
    if (type === "g") continue;
    name = paxPath ?? longName ?? name;
    paxPath = longName = null;

    const path = name.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (name.startsWith("/") || path.split("/").includes("..")) throw new Error(`the archive has an unsafe path: ${name}`);
    if (type === "5") entries.push({ path, kind: "folder", size: 0 });
    else if (type === "0" || type === "7") entries.push({ path, kind: "file", size, data: path.endsWith("plugin.json") ? Buffer.from(data) : null });
    else throw new Error(`the archive has a link or a special file: ${name}`);
  }
  return entries.filter((entry) => entry.path !== "");
}

/** Problems with the package of one entry. */
export async function checkPackage(entry, fetchBytes = download) {
  let packed;
  try {
    packed = await fetchBytes(entry.url);
  } catch (error) {
    return [`could not download ${entry.url}: ${error.message}`];
  }
  if (packed.length > MAX_PACKAGE_BYTES) return [`the package is ${packed.length} bytes; the limit is ${MAX_PACKAGE_BYTES}`];
  const sum = createHash("sha256").update(packed).digest("hex");
  if (sum !== entry.sha256) return [`the package's SHA-256 is ${sum}, not the sha256 in index.json`];

  let entries;
  try {
    entries = readTar(gunzipSync(packed, { maxOutputLength: MAX_TAR_BYTES }));
  } catch (error) {
    return [`the package is not a .tar.gz westerm can use: ${error.code === "ERR_BUFFER_TOO_LARGE" ? "too big unpacked" : error.message}`];
  }
  const problems = [];
  if (entries.length > MAX_ENTRIES) problems.push(`the package has ${entries.length} entries; the limit is ${MAX_ENTRIES}`);
  const unpacked = entries.reduce((total, item) => total + item.size, 0);
  if (unpacked > MAX_UNPACKED_BYTES) problems.push(`the package is ${unpacked} bytes unpacked; the limit is ${MAX_UNPACKED_BYTES}`);

  // westerm uses the single folder at the top as the package, if there is one.
  const top = new Set(entries.map((item) => item.path.split("/")[0]));
  const single = top.size === 1 && entries.some((item) => item.path === [...top][0] && item.kind === "folder");
  const manifestPath = single ? `${[...top][0]}/plugin.json` : "plugin.json";
  const manifestEntry = entries.find((item) => item.path === manifestPath && item.kind === "file");
  if (!manifestEntry) return [...problems, "the package has no plugin.json at its top"];

  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.data.toString("utf8"));
  } catch {
    return [...problems, "plugin.json is not valid JSON"];
  }
  for (const key of ["id", "name", "version"]) {
    if (manifest[key] !== entry[key]) problems.push(`plugin.json has ${key} ${JSON.stringify(manifest[key])}; index.json has ${JSON.stringify(entry[key])}`);
  }
  if (normalPermissions(manifest.permissions) !== normalPermissions(entry.permissions)) {
    problems.push("plugin.json asks for other permissions than index.json lists");
  }
  return problems;
}

/** Downloads a package over https://, at most MAX_PACKAGE_BYTES + 1 bytes. */
async function download(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (new URL(response.url).protocol !== "https:") throw new Error("a redirect left https://");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    chunks.push(chunk);
    if (total > MAX_PACKAGE_BYTES) break;
  }
  return Buffer.concat(chunks);
}

/** Checks the text of index.json. Returns the problems, and the ids that passed. */
export async function checkIndex(text, { offline = false, fetchBytes = download } = {}) {
  let entries;
  try {
    entries = JSON.parse(text);
  } catch (error) {
    return { problems: [`index.json is not valid JSON: ${error.message}`], passed: [] };
  }
  const problems = checkEntries(entries);
  if (problems.length > 0 || offline) return { problems, passed: problems.length ? [] : entries.map((entry) => entry.id) };
  const passed = [];
  for (const entry of entries) {
    const found = await checkPackage(entry, fetchBytes);
    if (found.length === 0) passed.push(`${entry.id} ${entry.version}`);
    problems.push(...found.map((text) => `${entry.id}: ${text}`));
  }
  return { problems, passed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const file = args.find((arg) => !arg.startsWith("--")) ?? "index.json";
  const { problems, passed } = await checkIndex(await readFile(file, "utf8"), { offline: args.includes("--offline") });
  for (const id of passed) console.log(`ok ${id}`);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log(`${file}: ${passed.length} plugin(s), all good`);
}
