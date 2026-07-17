#!/usr/bin/env bun
/**
 * Void Blaster integrity check (ZOU-713).
 *
 * Pure + offline. Reads void-blaster/index.html and asserts:
 *   1. the game stays self-contained (no external script/style/font/image
 *      URLs — only the relative back-to-hub link is allowed),
 *   2. the ZOU-713 wave-progression regression stays fixed: the wave-clear
 *      handler must not race two sibling timeouts (the old pattern left the
 *      spawn timeout observing state==='waving' and returning, soft-locking
 *      the game after wave 1),
 *   3. the inline script parses as valid JavaScript,
 *   4. required UI elements, touch-input safety (`touchcancel`), safe
 *      storage wrappers, dt-normalized movement, and accessibility
 *      attributes are present.
 *
 * Exit codes: 0 — all checks pass; 1 — one or more checks fail.
 *
 * Usage: bun scripts/validate-void-blaster.ts [--file <path>]
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
    : resolve(SCRIPT_DIR, "..", "void-blaster", "index.html");

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
check(!/<link[^>]+href=/i.test(html), "external <link href> found — game must stay self-contained (ZOU-713 removed the Google Fonts dependency)");
check(!/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, "")), "absolute http(s) URL found — no external assets allowed");

/* 2 — wave progression: single guarded timeout, no state-race pair */
const waveClear = html.indexOf("state='waving'");
check(waveClear !== -1, "wave-transition hold state ('waving') missing");
check(
  html.includes("s!==session"),
  "wave-clear timeout must be session-guarded (stale timeouts from a quit game must not fire)"
);
check(
  !/setTimeout\(\(\)=>\{ if\(state==='waving'\) state='playing'; \}/.test(html),
  "old racing wave-resume timeout present — soft-locks the game after wave 1 (ZOU-713 regression)"
);

/* 3 — inline script parses as valid JavaScript */
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
check(scriptMatch !== null, "inline <script> block missing");
if (scriptMatch) {
  try {
    // Static parse only (no dynamic eval): Bun's transpiler throws on syntax errors.
    new Bun.Transpiler({ loader: "js" }).transformSync(scriptMatch[1]);
  } catch (err) {
    check(false, `inline script has a syntax error: ${err}`);
  }
}

/* 4 — required elements, input safety, storage safety, accessibility */
for (const id of [
  "c", "titleScreen", "pauseScreen", "overScreen", "playBtn", "againBtn",
  "resumeBtn", "quitBtn", "menuBtn", "muteBtn", "fxBtn",
  "tb-left", "tb-right", "tb-fire", "hud", "powerups-hud", "combo-hud",
]) {
  check(html.includes(`id="${id}"`), `required element #${id} missing`);
}
check(html.includes("touchcancel"), "touchcancel handling missing — held touch input could stick");
check(html.includes("function storeGet"), "safe localStorage wrapper storeGet missing — blocked storage would crash the boot script");
check(!/[^.]\blocalStorage\.(getItem|setItem)\(/.test(html.replace(/function store(Get|Set)[^\n]*\n[^\n]*/g, "")), "raw localStorage access outside the storeGet/storeSet wrappers");
check(html.includes("dt*60"), "dt-normalized movement factor (dt*60) missing — gameplay would be frame-rate dependent");
check(/id="muteBtn"[^>]*aria-label=/.test(html), "mute button needs an accessible name (aria-label)");
check(/id="fxBtn"[^>]*aria-label=/.test(html), "FX toggle needs an accessible name (aria-label)");
for (const id of ["tb-left", "tb-right", "tb-fire"]) {
  check(new RegExp(`id="${id}"[^>]*aria-label=`).test(html),
    `touch control #${id} needs an accessible name (aria-label)`);
}
check(html.includes("voidblaster_best"), "high-score persistence key voidblaster_best missing (backward compatibility)");
check(html.includes(":focus-visible"), "visible focus styles (:focus-visible) missing");
check(html.includes("prefers-reduced-motion"), "prefers-reduced-motion default for the FX toggle missing");

if (failures.length > 0) {
  console.error(`Void Blaster integrity check FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("Void Blaster integrity check passed ✓");
