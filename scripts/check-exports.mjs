#!/usr/bin/env node
/**
 * Static named-export check.
 *
 * Complements check-imports.mjs: that script proves the module a file imports
 * from *exists*; this one proves the specific names it imports are actually
 * exported. Together they catch the two most common silent breakages in a
 * TypeScript monorepo without requiring a full typecheck.
 *
 * Limitations (deliberate): re-export barrels (`export * from`) are treated as
 * "cannot verify" and skipped rather than reported as failures.
 *
 * Usage: node scripts/check-exports.mjs
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
  { dir: path.join(root, "backend", "src"), aliasRoot: null, extensions: [".ts"] },
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

const IMPORT_NAMED = /(?:^|\n)\s*import\s+(?:type\s+)?\{([^}]+)\}\s*from\s+["']([^"']+)["']/g;
const REEXPORT_NAMED = /(?:^|\n)\s*export\s+(?:type\s+)?\{([^}]+)\}\s*from\s+["']([^"']+)["']/g;

function resolveSpecifier(specifier, fromFile, aliasRoot) {
  let base;
  if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else if (specifier.startsWith("@/")) {
    if (!aliasRoot) return null;
    base = path.join(aliasRoot, specifier.slice(2));
  } else return null;

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

/** Extracts every exported name visible from a module's source text. */
function exportedNames(source) {
  const names = new Set();
  let hasStar = false;

  const patterns = [
    /\bexport\s+(?:async\s+)?(?:const|let|var|function|class|enum)\s+([A-Za-z0-9_$]+)/g,
    /\bexport\s+(?:type|interface)\s+([A-Za-z0-9_$]+)/g,
    /\bexport\s+default\b/g,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1]) names.add(match[1]);
      else names.add("default");
    }
  }

  // export { a, b as c } / export type { a }
  const braceExport = /\bexport\s+(?:type\s+)?\{([^}]+)\}/g;
  braceExport.lastIndex = 0;
  let braceMatch;
  while ((braceMatch = braceExport.exec(source)) !== null) {
    for (const part of braceMatch[1].split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const alias = /\bas\s+([A-Za-z0-9_$]+)$/.exec(trimmed);
      names.add(alias ? alias[1] : trimmed.replace(/^type\s+/, ""));
    }
  }

  if (/\bexport\s+\*\s+from\b/.test(source)) hasStar = true;

  return { names, hasStar };
}

let checkedFiles = 0;
let checkedNames = 0;
const failures = [];

for (const target of TARGETS) {
  for (const file of walk(target.dir, target.extensions)) {
    const source = readFileSync(file, "utf8");
    const occurrences = [];

    for (const pattern of [IMPORT_NAMED, REEXPORT_NAMED]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) occurrences.push(match);
    }

    for (const match of occurrences) {
      const namesRaw = match[1];
      const specifier = match[2];
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;

      const resolved = resolveSpecifier(specifier, file, target.aliasRoot);
      if (!resolved) continue; // check-imports.mjs already reports this

      checkedFiles += 1;
      const exported = exportedNames(readFileSync(resolved, "utf8"));

      for (const part of namesRaw.split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const importedName = trimmed.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (!importedName || importedName === "default") continue;

        checkedNames += 1;
        if (!exported.names.has(importedName) && !exported.hasStar) {
          failures.push({
            file: path.relative(root, file),
            specifier,
            importedName,
            target: path.relative(root, resolved),
          });
        }
      }
    }
  }
}

console.log(`Checked ${checkedNames} named imports across ${checkedFiles} import statements.`);

if (failures.length) {
  console.error(`\n✗ ${failures.length} named import(s) not exported:\n`);
  const seen = new Set();
  for (const failure of failures) {
    const key = `${failure.file}|${failure.specifier}|${failure.importedName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.error(`  ${failure.file}\n    imports { ${failure.importedName} } from ${failure.specifier}\n    but ${failure.target} does not export it`);
  }
  process.exit(1);
}

console.log("✓ All named imports are exported by their target modules.");
