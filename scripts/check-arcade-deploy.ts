#!/usr/bin/env bun
/**
 * Arcade deploy-freshness check.
 *
 * The cabinet the public sees is NOT this repo. The `zouroboros-arcade` service
 * serves a separate git clone, so a merged registry.json proves only that a game
 * is catalogued — not that it is playable. OpenFlight Sim was merged in #11 and
 * stayed invisible on the hub for hours because that clone sat four commits back.
 *
 * This asserts the deployed surface matches the repo:
 *   - every catalogued game the repo knows about is served by the live registry
 *   - each served game's entrypoint and thumbnail actually resolve over HTTP
 *   - the local deploy clone, when present, is at the same commit as origin/main
 *
 * Needs network. Deliberately NOT part of validate-*.ts, which are pure + offline.
 *
 * Usage: bun scripts/check-arcade-deploy.ts [--base <url>] [--deploy-dir <path>]
 * Exit 0 on pass, 1 on any drift.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE = "https://zouroboros-arcade-marlandoj.zocomputer.io";
const DEFAULT_DEPLOY_DIR = "/home/workspace/.runtime/zouroboros-arcade";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const BASE = arg("base", DEFAULT_BASE).replace(/\/$/, "");
const DEPLOY_DIR = arg("deploy-dir", DEFAULT_DEPLOY_DIR);

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`  ✗ ${msg}`); failures++; }
  else console.log(`  ✓ ${msg}`);
}

interface GameEntry { id: string; title: string; path: string; thumbnail?: string; status: string }
interface Registry { version: number; updated?: string; games: GameEntry[] }

const local = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8")) as Registry;

async function fetchJson(url: string): Promise<Registry> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as Registry;
}

async function head(url: string): Promise<number> {
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(30_000) });
    return res.status;
  } catch { return 0; }
}

// ── 1. The live registry serves every game this repo catalogues ──────────────
console.log(`[1] Live registry at ${BASE}`);
let live: Registry;
try {
  live = await fetchJson(`${BASE}/registry.json`);
  console.log(`  ✓ registry.json served (${live.games.length} games, updated ${live.updated})`);
} catch (err) {
  console.error(`  ✗ could not read live registry: ${(err as Error).message}`);
  console.log(`\n❌ arcade deploy: 1 CHECK(S) FAILED`);
  process.exit(1);
}

const liveIds = new Set(live.games.map((g) => g.id));
for (const g of local.games) {
  assert(liveIds.has(g.id), `"${g.id}" is served by the live hub`);
}

const extra = live.games.filter((g) => !local.games.some((l) => l.id === g.id));
assert(extra.length === 0, `the live hub serves no game absent from this repo${extra.length ? ` (extra: ${extra.map((g) => g.id).join(", ")})` : ""}`);

// ── 2. Each served game's assets actually resolve over HTTP ──────────────────
console.log(`\n[2] Served assets`);
for (const g of live.games) {
  const paths = [g.path, g.thumbnail].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const p of paths) {
    const url = `${BASE}/${p.replace(/^\.\//, "")}`;
    const code = await head(url);
    assert(code === 200, `${g.id}: ${p} -> HTTP ${code || "no response"}`);
  }
}

// ── 3. The deploy clone, when reachable, is at origin/main ───────────────────
console.log(`\n[3] Deploy clone`);
if (!existsSync(join(DEPLOY_DIR, ".git"))) {
  console.log(`  – skipped: no git clone at ${DEPLOY_DIR} (not running on the host)`);
} else {
  const { spawnSync } = await import("node:child_process");
  const git = (args: string[], cwd: string) =>
    spawnSync("git", args, { cwd, encoding: "utf8" }).stdout?.trim() ?? "";

  git(["fetch", "--quiet", "origin", "main"], DEPLOY_DIR);
  const deployed = git(["rev-parse", "HEAD"], DEPLOY_DIR);
  const target = git(["rev-parse", "origin/main"], DEPLOY_DIR);
  assert(
    deployed.length > 0 && deployed === target,
    `deploy clone is at origin/main (deployed ${deployed.slice(0, 7) || "?"}, main ${target.slice(0, 7) || "?"})`,
  );
  if (deployed && target && deployed !== target) {
    const behind = spawnSync("git", ["log", "--oneline", `${deployed}..${target}`], { cwd: DEPLOY_DIR, encoding: "utf8" }).stdout?.trim();
    if (behind) console.error(`    missing commits:\n${behind.split("\n").map((l) => `      ${l}`).join("\n")}`);
  }
}

console.log(failures === 0
  ? "\n✅ arcade deploy: ALL CHECKS PASSED"
  : `\n❌ arcade deploy: ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
