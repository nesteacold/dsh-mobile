#!/usr/bin/env node
// Profile-link drift check (roadmap P0-3). Run: node tools/ops/check-profile.mjs [--profile NAME]
//
// A DSH profile is not an npm project that installs from a registry: it *links* to sibling
// checkouts (`link:C:/.../plugins/mobile-gateway`) so the owner runs the tree they are editing.
// Three files therefore have to agree, and nothing in the toolchain keeps them agreeing:
//
//   1. package.json            — what the owner asked for (`link:<absolute path>`)
//   2. pnpm-lock.yaml          — what pnpm recorded at install time (specifier + relative target)
//   3. node_modules/<name>     — the symlink/junction the loader actually follows
//
// After a checkout is moved, renamed or re-cloned, (1) and (2) can keep naming the old path while
// (3) still points somewhere real — or (3) can be missing entirely and the plugin silently does not
// load. Both look like "the gateway is not in Settings" and cost an evening. This script compares
// all three and exits non-zero on any disagreement.
//
// Read-only, by construction: it only ever reads. No install, no `pnpm`, no network, no rewrite of
// a lockfile, no repair. Fix drift by re-running the profile's install (docs/ops/runbook.md), never
// by editing the lockfile by hand.
//
// Exit codes: 0 = all three agree, 1 = drift, 2 = could not inspect (missing profile, malformed
// lockfile, ambiguous profile name). 1 and 2 must not be confused: 2 means "unknown", not "fine".
//
// Paths are printed with the user's home directory replaced by `~`, so a transcript of a run can be
// pasted into an issue without carrying the owner's account name.

import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WAY = ["link:", "file:"];

const argv = process.argv.slice(2);
const opts = { profile: null, profileDir: null, profilesRoot: null, quiet: false, home: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--profile") opts.profile = argv[++i];
  else if (a === "--profile-dir") opts.profileDir = path.resolve(argv[++i] ?? ".");
  else if (a === "--profiles-root") opts.profilesRoot = path.resolve(argv[++i] ?? ".");
  else if (a === "--home") opts.home = path.resolve(argv[++i] ?? "."); // tests: redaction only
  else if (a === "--quiet") opts.quiet = true;
  else if (a === "--help" || a === "-h") {
    console.log("usage: node tools/ops/check-profile.mjs [--profile NAME] [--profile-dir DIR] [--profiles-root DIR] [--quiet]");
    process.exit(0);
  } else {
    console.error(`check-profile: unknown argument ${a}`);
    process.exit(2);
  }
}

const fail = (message) => {
  console.error(`check-profile: ${message}`);
  process.exit(2);
};

// `%USERPROFILE%` on Windows, `$HOME` elsewhere. DSH_HOME wins when the harness sets it (a profile
// can live outside the default home); it is a directory the caller already owns.
const HOME = opts.home ?? process.env.USERPROFILE ?? process.env.HOME ?? homedir();
const DSH_HOME = process.env.DSH_HOME ?? path.join(HOME, ".dsh");
const PROFILES_ROOT = opts.profilesRoot ?? path.join(DSH_HOME, "profiles");

const toPosix = (p) => p.split(path.sep).join("/");
/** Printed form: home-relative, forward slashes. Never echo the account name into a log. */
const show = (p) => {
  if (typeof p !== "string" || p === "") return "(none)";
  const abs = path.resolve(p);
  const rel = path.relative(HOME, abs);
  // rel === "" is the home directory itself; the `..` test is a sibling or an ancestor.
  const inside = !rel.startsWith("..") && !path.isAbsolute(rel);
  return toPosix(inside ? (rel === "" ? "~" : `~/${rel}`) : abs);
};

/**
 * Printed form of a raw specifier, which embeds an absolute path (`link:C:/Users/<name>/...`).
 * Redaction is textual here because the path arrives glued to its scheme prefix; it replaces the
 * home directory wherever it appears, in either slash spelling.
 */
const redactText = (text) => {
  if (typeof text !== "string") return "";
  const home = path.resolve(HOME);
  for (const spelling of new Set([home, toPosix(home)])) {
    text = text.split(spelling).join("~");
  }
  return text;
};

/**
 * Comparison key for a directory path: absolute, realpathed when it exists (so `a/b/../c` and a
 * junction both fold to one spelling), case-folded on Windows where paths are case-insensitive.
 * The *display* form stays `show(p)`; this key is only ever compared, never printed.
 */
const keyOf = (p) => {
  if (typeof p !== "string" || p.trim() === "") return "";
  const abs = path.resolve(p);
  let real = abs;
  try {
    if (existsSync(abs)) real = realpathSync(abs);
  } catch {
    real = abs;
  }
  const posix = toPosix(real).replace(/\/+$/, "");
  return process.platform === "win32" ? posix.toLowerCase() : posix;
};

/** Resolve a `link:`/`file:` specifier or version to an absolute path, relative to `base`. */
const targetOf = (spec, base) => {
  if (typeof spec !== "string" || spec.trim() === "") return "";
  const raw = spec.trim().replace(/^["']|["']$/g, "");
  const prefix = WAY.find((candidate) => raw.startsWith(candidate));
  if (prefix === undefined) return "";
  const rest = raw.slice(prefix.length);
  // pnpm records `link:<absolute>` in package.json and `link:<relative>` in the lockfile.
  return path.isAbsolute(rest) ? path.resolve(rest) : path.resolve(base, rest);
};

// ---------------------------------------------------------------------------
// Lockfile: only the root importer of lockfileVersion 9 is read, by indentation. A full YAML
// parser would be a dependency, and the profile lockfile is machine-written with stable layout.
// Anything this cannot read is reported as "could not inspect" (exit 2), never as agreement.
// ---------------------------------------------------------------------------

/**
 * @returns {Map<string, {specifier: string, version: string}>} dependency name -> recorded fields
 */
function readLockfile(file) {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const out = new Map();
  let start = lines.findIndex((line) => /^importers:\s*$/.test(line));
  if (start === -1) throw new Error("no `importers:` section (not a pnpm lockfile?)");

  // The root importer is the `.` key at the first indentation level inside `importers:`.
  let rootAt = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line) && line.trim() !== "") break; // next top-level key
    if (/^\s{2}(?:'\.'|"\.'|\.):\s*$/.test(line)) {
      rootAt = i;
      break;
    }
  }
  if (rootAt === -1) throw new Error("no root importer `.` inside `importers:`");

  let section = null;
  let current = null;
  for (let i = rootAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const indent = line.length - line.replace(/^\s*/, "").length;
    if (indent <= 2) break; // left the root importer

    const sectionMatch = /^\s{4}([A-Za-z]+):\s*$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      current = null;
      continue;
    }
    const entryMatch = /^\s{6}(\S.*?):\s*$/.exec(line);
    if (entryMatch) {
      const name = entryMatch[1].replace(/^["']|["']$/g, "");
      current = out.get(name) ?? { specifier: "", version: "" };
      out.set(name, current);
      continue;
    }
    const fieldMatch = /^\s{8}(specifier|version):\s*(.*)$/.exec(line);
    if (fieldMatch) {
      if (current === null || section === null) continue;
      current[fieldMatch[1]] = fieldMatch[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Profile resolution: explicit directory, then the harness's own environment, then the one
// profile that exists. Never guess between two: that is how a check silently watches the wrong
// tree.
// ---------------------------------------------------------------------------

function resolveProfileDir() {
  if (opts.profileDir) return opts.profileDir;
  if (process.env.DSH_PROFILE_DIR && !opts.profile) return path.resolve(process.env.DSH_PROFILE_DIR);
  const wanted = opts.profile ?? process.env.DSH_PROFILE ?? null;
  if (wanted) return path.join(PROFILES_ROOT, wanted);

  let names;
  try {
    names = readdirSync(PROFILES_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    fail(`no profiles directory at ${show(PROFILES_ROOT)}; pass --profile-dir or --profile`);
  }
  if (names.length === 1) return path.join(PROFILES_ROOT, names[0]);
  if (names.length === 0) fail(`no profile directories under ${show(PROFILES_ROOT)}`);
  fail(`several profiles under ${show(PROFILES_ROOT)} (${names.join(", ")}); pass --profile NAME`);
}

// ---------------------------------------------------------------------------
// The comparison.
// ---------------------------------------------------------------------------

const dir = resolveProfileDir();
const manifestPath = path.join(dir, "package.json");
const lockPath = path.join(dir, "pnpm-lock.yaml");
const modulesDir = path.join(dir, "node_modules");

if (!existsSync(manifestPath)) fail(`no package.json at ${show(manifestPath)}`);
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`package.json at ${show(manifestPath)} is not valid JSON (${error.message})`);
}
if (!existsSync(lockPath)) fail(`no pnpm-lock.yaml at ${show(lockPath)}: the profile has never been installed`);

let locked;
try {
  locked = readLockfile(lockPath);
} catch (error) {
  fail(`cannot read ${show(lockPath)}: ${error.message}`);
}

const declared = {};
for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
  for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
    declared[name] = { specifier: String(specifier), field };
  }
}

const linked = Object.entries(declared).filter(([, entry]) => WAY.some((prefix) => entry.specifier.trim().startsWith(prefix)));
const otherCount = Object.keys(declared).length - linked.length;

if (linked.length === 0) {
  fail(`no link:/file: dependencies in ${show(manifestPath)}: nothing to check`);
}

/** One row's verdict: the three-way comparison for a single dependency. */
function inspect(name, entry) {
  const problems = [];
  const declaredTarget = targetOf(entry.specifier, dir);
  const record = locked.get(name);

  if (!record) problems.push("not in the lockfile");

  // (1+2) package.json and pnpm-lock.yaml must name the same directory. The comparison is on the
  // RESOLVED target, not on the literal text: pnpm records the specifier verbatim but the version
  // as a path relative to the profile, so `link:C:/p/x` and `link:../x` are the same link and a
  // string comparison would report drift where there is none. What a difference means: the
  // lockfile predates the edit in package.json, and the next `pnpm install` will rewrite it.
  const lockSpecifier = record?.specifier ?? "";
  const lockTarget = targetOf((lockSpecifier || record?.version) ?? "", dir);
  if (record && lockTarget === "") {
    problems.push(`lockfile recorded ${redactText(lockSpecifier || record.version) || "(empty)"}, not a link`);
  } else if (record && keyOf(lockTarget) !== keyOf(declaredTarget)) {
    problems.push(`lockfile target is ${show(lockTarget)}`);
  }

  // (3) The symlink the module loader follows must exist and land on that same directory.
  const linkPath = path.join(modulesDir, ...name.split("/"));
  let linkTarget = "";
  let linkState = "present";
  try {
    const stats = lstatSync(linkPath);
    // A real directory here is an installed copy, not a link: it will not follow the checkout.
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      linkState = "not a link";
      problems.push("node_modules entry is a directory, not a symlink");
    } else {
      linkTarget = path.resolve(path.dirname(linkPath), readlinkSync(linkPath));
    }
  } catch {
    linkState = "missing";
    problems.push("node_modules entry is missing");
  }
  if (linkTarget && keyOf(linkTarget) !== keyOf(declaredTarget)) {
    problems.push(`node_modules target is ${show(linkTarget)}`);
  }

  // The LOCKED column: the path the lockfile's recorded target resolves to, or, when it records no
  // link at all, the raw recorded specifier (redacted: it embeds an absolute path).
  const lockedTarget = targetOf((lockSpecifier || record?.version) ?? "", dir);
  const lockedCell = !record
    ? "(absent)"
    : lockedTarget !== ""
      ? show(lockedTarget)
      : redactText(lockSpecifier || record.version) || "(empty)";

  return {
    name,
    declared: show(declaredTarget),
    locked: lockedCell,
    linked: linkTarget ? show(linkTarget) : `(${linkState})`,
    ok: problems.length === 0,
    problems,
  };
}

const rows = linked.map(([name, entry]) => inspect(name, entry));
const drifted = rows.filter((row) => !row.ok);

if (!opts.quiet) {
  const headers = ["PACKAGE", "DECLARED (package.json)", "LOCKED (pnpm-lock.yaml)", "LINKED (node_modules)", "STATUS"];
  const cells = rows.map((row) => [row.name, row.declared, row.locked, row.linked, row.ok ? "ok" : "DRIFT"]);
  const widths = headers.map((header, i) => Math.max(header.length, ...cells.map((cell) => cell[i].length)));
  const render = (line) => line.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
  console.log(`profile: ${show(dir)}`);
  console.log(render(headers));
  console.log(render(widths.map((w) => "-".repeat(w))));
  for (const line of cells) console.log(render(line));
  for (const row of drifted) {
    for (const problem of row.problems) console.log(`  ${row.name}: ${problem}`);
  }
  if (otherCount > 0) {
    console.log(`${otherCount} registry dependenc${otherCount === 1 ? "y" : "ies"} not checked (no link: target to follow)`);
  }
}

if (drifted.length > 0) {
  console.error(`\ncheck-profile: DRIFT in ${drifted.length}/${rows.length} link(s). Re-run the profile install; do not hand-edit pnpm-lock.yaml.`);
  process.exit(1);
}
console.error(`\ncheck-profile: all ${rows.length} link(s) agree (package.json = pnpm-lock.yaml = node_modules)`);
process.exit(0);
