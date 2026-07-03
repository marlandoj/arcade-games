#!/usr/bin/env bun
/**
 * Arcade registry validator (ZOU-449).
 *
 * Pure + offline. Reads games/registry.json and, for every catalog entry,
 * asserts that:
 *   1. the entry has the required string fields,
 *   2. the resolved game directory exists, and
 *   3. an index.html exists inside that directory.
 *
 * Exit codes:
 *   0  — every entry validates
 *   1  — one or more entries are missing/malformed (messages printed to stderr)
 *   2  — registry.json itself is missing or unparseable
 *
 * Usage:
 *   bun games/scripts/validate-registry.ts                # default: ../registry.json
 *   bun games/scripts/validate-registry.ts --registry <path>
 *   bun games/scripts/validate-registry.ts --help
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY = resolve(SCRIPT_DIR, "..", "registry.json");

interface GameEntry {
  id: string;
  title: string;
  subtitle?: string;
  description: string;
  path: string;
  icon?: string;
  accent?: string;
  tags?: string[];
  controls?: string[];
  status: string;
  featured?: boolean;
  added?: string;
}

interface Registry {
  version: number;
  updated?: string;
  games: GameEntry[];
}

const REQUIRED_STRING_FIELDS: (keyof GameEntry)[] = [
  "id",
  "title",
  "description",
  "path",
  "status",
];

function printHelp(): void {
  console.log(`Usage: bun validate-registry.ts [--registry <path>] [--help]

Validates games/registry.json: every catalog entry must resolve to a
directory that contains an index.html.

Options:
  --registry <path>   Path to a registry.json (default: ../registry.json)
  --help              Show this help
`);
}

function parseArgs(argv: string[]): { registry: string; help: boolean } {
  let registry = DEFAULT_REGISTRY;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--registry") registry = argv[++i] ?? "";
    else if (a.startsWith("--registry=")) registry = a.slice("--registry=".length);
  }
  return { registry, help };
}

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function validateEntry(entry: unknown, registryDir: string): string[] {
  const errors: string[] = [];
  if (typeof entry !== "object" || entry === null) {
    return ["entry is not an object"];
  }
  const e = entry as Record<string, unknown>;
  const id = isString(e.id) ? e.id : "(unknown id)";

  for (const field of REQUIRED_STRING_FIELDS) {
    if (!isString(e[field])) errors.push(`[${id}] missing/empty required field "${String(field)}"`);
  }

  if (isString(e.path)) {
    // Path must be relative and point to a directory (trailing slash expected).
    if (e.path.startsWith("/")) {
      errors.push(`[${id}] path must be relative (got "${e.path}")`);
    }
    const dirPath = resolve(registryDir, e.path);
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
      errors.push(`[${id}] directory not found at "${e.path}" (resolved: ${dirPath})`);
    } else {
      const indexPath = join(dirPath, "index.html");
      if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
        errors.push(`[${id}] index.html not found in "${e.path}" (resolved: ${indexPath})`);
      }
    }
  }

  if (e.featured !== undefined && typeof e.featured !== "boolean") {
    errors.push(`[${id}] "featured" must be boolean when present`);
  }
  if (isString(e.tags) || (Array.isArray(e.tags) && e.tags.some((t) => typeof t !== "string"))) {
    errors.push(`[${id}] "tags" must be an array of strings when present`);
  }

  return errors;
}

function main(): number {
  const { registry, help } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return 0;
  }
  if (!registry) {
    console.error("error: --registry requires a path argument");
    return 2;
  }
  if (!existsSync(registry)) {
    console.error(`error: registry not found: ${registry}`);
    return 2;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(registry, "utf8"));
  } catch (err) {
    console.error(`error: failed to parse registry JSON: ${(err as Error).message}`);
    return 2;
  }

  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as Registry).games)) {
    console.error('error: registry must be an object with a "games" array');
    return 2;
  }
  const reg = parsed as Registry;
  const registryDir = dirname(resolve(registry));

  if (!Array.isArray(reg.games) || reg.games.length === 0) {
    console.error("error: registry has no games");
    return 1;
  }

  const seenIds = new Set<string>();
  const allErrors: string[] = [];
  let featuredCount = 0;
  for (const entry of reg.games) {
    const errs = validateEntry(entry, registryDir);
    if (errs.length) allErrors.push(...errs);
    if (typeof entry === "object" && entry !== null && (entry as GameEntry).featured === true) featuredCount++;
    if (typeof entry === "object" && entry !== null && isString((entry as GameEntry).id)) {
      const id = (entry as GameEntry).id;
      if (seenIds.has(id)) allErrors.push(`[dup] duplicate game id "${id}"`);
      else seenIds.add(id);
    }
  }

  if (allErrors.length > 0) {
    console.error(`\n✗ ${allErrors.length} validation error(s):`);
    for (const msg of allErrors) console.error(`  - ${msg}`);
    console.error("");
    return 1;
  }

  console.log(`✓ registry valid: ${reg.games.length} game(s), ${featuredCount} featured — ${normalize(registry)}`);
  return 0;
}

const code = main();
if (code !== 0) process.exit(code);
