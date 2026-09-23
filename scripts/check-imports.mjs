#!/usr/bin/env node
/**
 * Static import-resolution check.
 *
 * Walks the backend and frontend sources, extracts every relative import (and
 * every `@/` alias import in the frontend) and verifies that a matching file
 * exists on disk. This catches the single most common class of breakage in a
 * codebase of this size — a renamed or moved module — without needing to install
 * dependencies or hit a database.
 *
 * Usage: node scripts/check-imports.mjs
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
  { dir: path.join(root, "backend", "src"), aliasRoot: null, extensions: [".ts", ".tsx"] },
  { dir: path.join(root, "backend", "prisma"), aliasRoot: null, extensions: [".ts"] },
  { dir: path.join(root, "backend", "tests"), aliasRoot: null, extensions: [".ts"] },
  { dir: path.join(root, "frontend"), aliasRoot: path.join(root, "frontend"), extensions: [".ts", ".tsx"] },
];

const IGNORED_DIRS = new Set(["node_modules", ".next", "dist", "coverage", ".git"]);

function walk(dir, extensions, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, extensions, out);
    else if (extensions.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

const IMPORT_PATTERN = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT_PATTERN = /import\(\s*["']([^"']+)["']\s*\)/g;

function resolveSpecifier(specifier, fromFile, aliasRoot) {
  let base;

  if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else if (specifier.startsWith("@/")) {
    if (!aliasRoot) return null; // backend does not use the @/ alias
    base = path.join(aliasRoot, specifier.slice(2));
  } else {
    return null; // package import
  }

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.d.ts`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];

  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

let checked = 0;
const failures = [];

for (const target of TARGETS) {
  const files = walk(target.dir, target.extensions);

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const specifiers = new Set();

    for (const pattern of [IMPORT_PATTERN, DYNAMIC_IMPORT_PATTERN]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) specifiers.add(match[1]);
    }

    for (const specifier of specifiers) {
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
      checked += 1;
      const resolved = resolveSpecifier(specifier, file, target.aliasRoot);
      if (!resolved) {
        failures.push({
          file: path.relative(root, file),
          specifier,
        });
      }
    }
  }
}

const fileCount = TARGETS.reduce((sum, target) => sum + walk(target.dir, target.extensions).length, 0);

console.log(`Scanned ${fileCount} source files, checked ${checked} relative imports.`);

if (failures.length) {
  console.error(`\n✗ ${failures.length} unresolved import(s):\n`);
  for (const failure of failures) {
    console.error(`  ${failure.file}\n    -> ${failure.specifier}`);
  }
  process.exit(1);
}

console.log("✓ All relative imports resolve.");
