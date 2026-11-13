import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { checkEntries, checkIndex, checkPackage, MAX_PACKAGE_BYTES } from "../scripts/check-index.mjs";

/** One tar entry: a ustar header and its data. */
function tarEntry(name, body = "", type = "0") {
  const data = Buffer.from(body);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(0x20, 148, 156);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

const tarGz = (...entries) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const manifest = {
  id: "k8s-tools.kubernetes",
  name: "Kubernetes",
  version: "0.3.1",
  panel: "panel.html",
  permissions: { run: ["kubectl"], panes: true },
};

function entryFor(pkg, changes = {}) {
  return {
    id: "k8s-tools.kubernetes",
    name: "Kubernetes",
    description: "See pods by namespace.",
    repo: "https://github.com/k8s-tools/westerm-k8s",
    version: "0.3.1",
    url: "https://example.test/k8s.tar.gz",
    sha256: sha256(pkg),
    permissions: { run: ["kubectl"], panes: true, background: false },
    ...changes,
  };
}

const goodPackage = () => tarGz(tarEntry("plugin.json", JSON.stringify(manifest)), tarEntry("panel.html", "<p>hi</p>"));
const serve = (pkg) => async () => pkg;

test("an empty list passes", async () => {
  assert.deepEqual(await checkIndex("[]\n"), { problems: [], passed: [] });
});

test("the repository's index.json passes the entry checks", async () => {
  const { problems } = await checkIndex(readFileSync(new URL("../index.json", import.meta.url), "utf8"), { offline: true });
  assert.deepEqual(problems, []);
});

test("a good entry and package pass", async () => {
  const pkg = goodPackage();
  const { problems, passed } = await checkIndex(JSON.stringify([entryFor(pkg)]), { fetchBytes: serve(pkg) });
  assert.deepEqual(problems, []);
  assert.deepEqual(passed, ["k8s-tools.kubernetes 0.3.1"]);
});

test("a package with one folder at the top passes", async () => {
  const pkg = tarGz(tarEntry("k8s/", "", "5"), tarEntry("k8s/plugin.json", JSON.stringify(manifest)), tarEntry("k8s/panel.html", "<p>hi</p>"));
  assert.deepEqual(await checkPackage(entryFor(pkg), serve(pkg)), []);
});

test("a package made by the system tar passes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "westerm-plugins-"));
  try {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "plugin.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "dist", "panel.html"), "<p>hi</p>");
    execFileSync("tar", ["-czf", join(dir, "pkg.tar.gz"), "-C", join(dir, "dist"), "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const pkg = readFileSync(join(dir, "pkg.tar.gz"));
    assert.deepEqual(await checkPackage(entryFor(pkg), serve(pkg)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a package whose SHA-256 differs fails", async () => {
  const pkg = goodPackage();
  const [problem] = await checkPackage(entryFor(pkg, { sha256: "0".repeat(64) }), serve(pkg));
  assert.match(problem, /SHA-256/);
});

test("plugin.json must match the entry", async () => {
  const pkg = tarGz(tarEntry("plugin.json", JSON.stringify({ ...manifest, version: "0.3.2", permissions: { run: ["kubectl", "curl"] } })));
  const problems = await checkPackage(entryFor(pkg), serve(pkg));
  assert.equal(problems.length, 2);
  assert.match(problems[0], /version "0.3.2"/);
  assert.match(problems[1], /other permissions/);
});

test("links, unsafe paths, and missing plugin.json fail", async () => {
  for (const [pkg, pattern] of [
    [tarGz(tarEntry("plugin.json", JSON.stringify(manifest)), tarEntry("link", "", "2")), /link or a special file/],
    [tarGz(tarEntry("../plugin.json", JSON.stringify(manifest))), /unsafe path/],
    [tarGz(tarEntry("panel.html", "<p>hi</p>")), /no plugin.json/],
  ]) {
    const [problem] = await checkPackage(entryFor(pkg), serve(pkg));
    assert.match(problem, pattern);
  }
});

test("a package over the size limit fails", async () => {
  const pkg = Buffer.alloc(MAX_PACKAGE_BYTES + 1);
  const [problem] = await checkPackage(entryFor(pkg), serve(pkg));
  assert.match(problem, /limit/);
});

test("bad entries fail before any download", () => {
  const good = entryFor(goodPackage());
  const cases = [
    [{ ...good, id: "Kubernetes" }, /id must be/],
    [{ ...good, version: "v0.3.1" }, /version/],
    [{ ...good, url: "http://example.test/k8s.tar.gz" }, /https/],
    [{ ...good, sha256: "ABC" }, /sha256/],
    [{ ...good, repo: "https://gitlab.com/a/b" }, /repo/],
    [{ ...good, permissions: { run: ["/bin/sh"] } }, /program names/],
    [{ ...good, extra: true }, /unknown key/],
  ];
  for (const [entry, pattern] of cases) {
    const problems = checkEntries([entry]);
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], pattern);
  }
  assert.match(checkEntries([good, good]).join("\n"), /listed twice/);
  assert.match(checkEntries([{ ...good, id: "zed.b" }, good]).join("\n"), /sorted by id/);
  assert.deepEqual(checkEntries({}), ["index.json must be a JSON array"]);
});
