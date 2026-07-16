#!/usr/bin/env bun
/**
 * Asteroid Drift integrity check (ZOU-707).
 *
 * Pure + offline. Reads asteroid-drift/index.html and asserts:
 *   1. the game stays self-contained (no external script/style/font/image
 *      URLs — only the relative back-to-hub link is allowed),
 *   2. the ZOU-707 bootstrap regression stays fixed: the `stars` binding is
 *      declared before the first top-level `resize()` call that reaches
 *      generateStars(),
 *   3. the inline script parses as valid JavaScript,
 *   4. required UI elements, touch-input safety (`touchcancel`), and
 *      accessibility attributes are present.
 *
 * Exit codes: 0 — all checks pass; 1 — one or more checks fail.
 *
 * Usage: bun scripts/validate-asteroid-drift.ts [--file <path>]
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const fileFlag = args.indexOf("--file");
const target =
  fileFlag !== -1 && args[fileFlag + 1]
    ? resolve(args[fileFlag + 1])
    : resolve(SCRIPT_DIR, "..", "asteroid-drift", "index.html");

const failures: string[] = [];
function check(ok: boolean, message: string): void {
  if (!ok) failures.push(message);
}

let html = "";
try {
  html = readFileSync(target, "utf-8");
} catch {
  console.error(`FAIL: cannot read ${target}`);
  process.exit(1);
}

/* 1 — self-contained: no external runtime dependencies */
check(!/<script[^>]+src=/i.test(html), "external <script src> found — game must stay self-contained");
check(!/<link[^>]+href=/i.test(html), "external <link href> found — game must stay self-contained");
check(!/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, "")), "absolute http(s) URL found — no external assets allowed");

/* 2 — bootstrap order: `stars` binding initialized before the first resize() call */
const starsDecl = html.indexOf("let stars");
const resizeCall = html.search(/^resize\(\);/m);
check(starsDecl !== -1, "`let stars` declaration missing");
check(resizeCall !== -1, "top-level `resize();` bootstrap call missing");
check(
  starsDecl !== -1 && resizeCall !== -1 && starsDecl < resizeCall,
  "`let stars` must be declared before the top-level `resize();` call (ZOU-707 TDZ regression)"
);

/* 3 — inline script parses as valid JavaScript */
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
check(scriptMatch !== null, "inline <script> block missing");
if (scriptMatch) {
  try {
    // Parse-only: Function constructor compiles without executing the body.
    new Function(scriptMatch[1]);
  } catch (err) {
    check(false, `inline script has a syntax error: ${err}`);
  }
}

/* 4 — required elements, touch-input safety, accessibility */
for (const id of [
  "c", "startScreen", "pauseScreen", "overScreen", "playBtn", "againBtn",
  "resumeBtn", "quitBtn", "menuBtn", "muteBtn", "fxBtn",
  "joy", "tFire", "tHyper", "tThrust", "shieldFill", "effectsRow", "livesRow",
]) {
  check(html.includes(`id="${id}"`), `required element #${id} missing`);
}
check(html.includes("touchcancel"), "touchcancel handling missing — held touch input could stick");
check(/id="muteBtn"[^>]*aria-label=/.test(html), "mute button needs an accessible name (aria-label)");
for (const id of ["tFire", "tHyper", "tThrust"]) {
  check(new RegExp(`id="${id}"[^>]*aria-label=`).test(html),
    `touch control #${id} needs an accessible name (aria-label)`);
}
check(html.includes("astdrift_best"), "high-score persistence key astdrift_best missing (backward compatibility)");
check(html.includes(":focus-visible"), "visible focus styles (:focus-visible) missing");

if (failures.length > 0) {
  console.error(`Asteroid Drift integrity check FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("Asteroid Drift integrity check passed ✓");
