#!/usr/bin/env bun
/**
 * OpenFlight Sim — arcade release / catalog focused test (OFS-006).
 *
 * Pure + offline. Asserts the T6 acceptance criteria that do not need a browser:
 * the registry entry is complete and well-formed, the game and its thumbnail are
 * really on disk, the hub's rendering contract is satisfiable from the entry, and
 * the README game table lists the cabinet.
 *
 * The remaining T6 criteria — the card renders and launches, the simulator reaches
 * flight, the instrument panel animates, no console errors — need a real GL
 * context and are covered by the headless browser check.
 *
 * Exit 0 on pass, 1 on any failure.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GAME_ID = "openflight-sim";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`  ✗ ${msg}`); failures++; }
  else console.log(`  ✓ ${msg}`);
}

interface GameEntry {
  id: string;
  title: string;
  subtitle?: string;
  description: string;
  path: string;
  thumbnail?: string;
  icon?: string;
  accent?: string;
  tags?: string[];
  controls?: string[];
  status: string;
  featured?: boolean;
  added?: string;
}

const registry = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8")) as {
  version: number;
  updated?: string;
  games: GameEntry[];
};

// ── 1. The catalog entry exists and carries every field the ticket names ─────
console.log("[1] registry.json entry");
const entry = registry.games.find((g) => g.id === GAME_ID);
assert(!!entry, `registry.json has an "${GAME_ID}" entry`);
if (!entry) {
  console.log(`\n❌ openflight-sim release: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}

for (const field of ["id", "title", "subtitle", "description", "path", "thumbnail", "icon", "accent", "status", "added"] as const) {
  const v = entry[field];
  assert(typeof v === "string" && v.length > 0, `entry has a non-empty "${field}"`);
}
for (const field of ["tags", "controls"] as const) {
  const v = entry[field];
  assert(Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.length > 0),
    `entry has a non-empty string array "${field}"`);
}

assert(entry.title === "OPENFLIGHT SIM", `catalog title is "OPENFLIGHT SIM" (got "${entry.title}")`);
assert(entry.status === "live", `status is "live" so the hub renders the cabinet (got "${entry.status}")`);
assert(/^\d{4}-\d{2}-\d{2}$/.test(entry.added ?? ""), `"added" is an ISO date (got "${entry.added}")`);
assert(/^#[0-9a-fA-F]{3,8}$/.test(entry.accent ?? ""), `"accent" is a hex colour (got "${entry.accent}")`);
assert(typeof entry.featured === "boolean", `"featured" is a boolean (got ${typeof entry.featured})`);

// ── 2. Paths resolve to real files inside the repo ───────────────────────────
console.log("\n[2] Assets on disk");
{
  assert(entry.path.startsWith("./"), `path is repo-relative (got "${entry.path}")`);
  const gamePath = resolve(ROOT, entry.path);
  assert(existsSync(gamePath) && statSync(gamePath).isFile(), `game entrypoint exists at ${entry.path}`);

  const thumbRel = entry.thumbnail ?? "";
  assert(thumbRel === `./thumbnails/${GAME_ID}.png`, `thumbnail points at ./thumbnails/${GAME_ID}.png (got "${thumbRel}")`);
  const thumbPath = resolve(ROOT, thumbRel);
  const thumbOk = existsSync(thumbPath) && statSync(thumbPath).isFile();
  assert(thumbOk, `thumbnail exists at ${thumbRel}`);
  if (thumbOk) {
    // PNG signature + IHDR width/height, so a stub text file cannot pass.
    const buf = readFileSync(thumbPath);
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert(buf.subarray(0, 8).equals(sig), "thumbnail is a real PNG (file signature)");
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    assert(w >= 512 && h >= 512, `thumbnail is at least 512x512 (got ${w}x${h})`);
    assert(w === h, `thumbnail is square, as the hub's small cabinet crops 1:1 (got ${w}x${h})`);
  }

  // The sim is a shell that loads ES modules by relative path — they must ship too.
  const src = join(dirname(resolve(ROOT, entry.path)), "src", "main.js");
  assert(existsSync(src), "the module entrypoint openflight-sim/src/main.js ships alongside index.html");
}

// ── 3. Hub rendering contract ────────────────────────────────────────────────
// index.html builds each cabinet from icon/title/subtitle/description/controls/
// tags and links to `path`. Nothing may be undefined at render time, and ids stay
// unique so the two flight sims cannot collide in the catalog.
console.log("\n[3] Hub cabinet contract");
{
  const ids = registry.games.map((g) => g.id);
  assert(new Set(ids).size === ids.length, "every registry id is unique");
  assert(ids.includes("opus5-flight-sim"), "the sibling opus5-flight-sim cabinet is still catalogued");

  const featured = registry.games.filter((g) => g.featured && g.status === "live");
  assert(featured.length >= 1, "the hub still has a featured hero cabinet");
  assert(!entry.featured, "openflight-sim ships as a queue cabinet, leaving the existing hero in place");

  const hub = readFileSync(join(ROOT, "index.html"), "utf8");
  assert(hub.includes("./registry.json"), "the hub reads registry.json as its source of truth");
}

// ── 4. README game table ─────────────────────────────────────────────────────
console.log("\n[4] README");
{
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const row = readme.split("\n").find((l) => l.includes(`\`${GAME_ID}\``) && l.trimStart().startsWith("|"));
  assert(!!row, "the README game table has an openflight-sim row");
  assert(!!row && /OpenFlight Sim/i.test(row), "the README row names OpenFlight Sim");
}

console.log(failures === 0
  ? "\n✅ openflight-sim release: ALL CHECKS PASSED"
  : `\n❌ openflight-sim release: ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
