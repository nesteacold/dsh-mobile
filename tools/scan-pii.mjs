#!/usr/bin/env node
// Pre-push PII / secret scan. No dependencies: node >= 18.
//
// Scans every git-tracked file in the working tree (`--all`, the default), every file
// in the working tree whether tracked or not (`--worktree`), or everything staged in
// the index (`--staged`, read as the staged blob so an edit not yet committed is seen
// the way the next commit will contain it). Prints one line per finding as
// `path:line: category: match` and exits 1 if any finding is not allowlisted.
//
// `--worktree` is the mode a migration runs before anything is staged: a file copied
// in from a private checkout is not tracked yet, and `--all` would never look at it.
//
// Usage: node tools/scan-pii.mjs [--all | --worktree | --staged] [--root DIR] [--quiet]
//
// Private literals: tools/pii-private.txt (git-ignored, optional), one per line, matched
// case-insensitively as a whole-word literal, or as `sha256:<hex>` against a word token.
// The machine name, the tailnet name and the owner's account name live there, not here.
//
// Allowlist: tools/pii-allowlist.txt, one exemption per line, `category:substring`.
// A finding is exempt only when its own line contains the substring (backslash
// escaping is normalised first), so an exemption for one address never hides
// another one on the same line. `#` starts a comment. Allowlisted findings still
// print, as an `allowlisted` note on stderr, and do not fail the run.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Backslashes are written as \x5c so the pattern survives every layer of quoting
// (shell, Windows console, editor) and never turns \U or \o into an escape.
const CATEGORIES = {
  // Any address that is not one of the EMAIL_PLACEHOLDERS below. Kotlin/Swift code
  // writes a label as `this@Foo.bar`, whose last segment is capitalised; a real
  // address here never has capitals after the `@`.
  email: /\b[A-Za-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/g,
  // Tailscale hands out 100.64.0.0/10 (CGNAT). A doc line quoting the *range*
  // ("100.64.0.0/10") is not a leak; a concrete address is.
  tailscale_ip: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g,
  // A tailnet machine name is a host label followed by its tailnet suffix and ts.net.
  tsnet: /\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)?\.ts\.net\b/g,
  // The Windows profile path, and the backslash-escaped forms source code writes (two
  // backslashes in a JS string, four in a nested fixture). Placeholders: the classroom form
  // `C:\Users\<name>` and the checksum's own worked example use `me`, which is a documented
  // stand-in (tools/pii-allowlist.txt) rather than an account.
  windows_user_path: /(?:[A-Za-z]:\x5c+|\x5c+)[\x5c]*Users[\x5c/]+[A-Za-z0-9_.-]+/g,
  private_key: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
  // Vendor token shapes that never belong in a repository.
  token: [
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    /\bAIza[0-9A-Za-z_-]{35}\b/g,
  ],
};

// Placeholder addresses never identify a human: GitHub / npm / CI bots and the
// conventional `you@example.com` style fillers used in docs and fixtures. `example`
// is the RFC 2606 reserved domain, and the hosts below are literals a comment or
// fixture wrote, not a machine name.
const EMAIL_PLACEHOLDERS = [
  /^noreply@github\.com$/i,
  /^noreply@anthropic\.com$/i,
  /^noreply@users\.noreply\.github\.com$/i,
  /\+\S@users\.noreply\.github\.com$/i,
  /^(?:you|your|user|owner|me|example|nobody)@/i,
  /@(?:example|example\.\w+)\.\w+$/i,
];

// Anything that names a documented placeholder host (`*.example*.ts.net`) is not a
// machine either; the tailnet suffix is what makes it a candidate in the first place.
const TSNET_PLACEHOLDERS = [/\.[a-z0-9-]*example[a-z0-9-]*\.ts\.net\b/i];

const opts = { mode: "all", quiet: false, root: process.cwd() };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--all" || a === "--hook") opts.mode = "all";
  else if (a === "--worktree") opts.mode = "worktree";
  else if (a === "--staged") opts.mode = "staged";
  else if (a === "--quiet") opts.quiet = true;
  else if (a === "--root") opts.root = resolve(argv[++i] ?? ".");
  else if (a === "--help" || a === "-h") {
    console.log("usage: node tools/scan-pii.mjs [--all|--worktree|--staged] [--root DIR] [--quiet]");
    process.exit(0);
  } else {
    console.error(`scan-pii: unknown argument ${a}`);
    process.exit(2);
  }
}

const root = opts.root;
const git = (args) => execFileSync("git", args, { cwd: root, maxBuffer: 1 << 28, encoding: "utf8" });

// Binary content is skipped: the patterns are text shapes. Vendor assets and lockfiles
// are still text and are scanned, because a leaked address there is the case this exists for.
const BINARY_EXT = /\.(?:png|jpg|jpeg|gif|webp|ico|bmp|pdf|zip|gz|tgz|jar|so|dll|exe|dylib|a|o|woff|woff2|ttf|eot|mp4|mov|wav|mp3)$/i;

function loadAllowlist() {
  const path = join(HERE, "pii-allowlist.txt");
  if (!existsSync(path)) return [];
  const rows = [];
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const k = line.indexOf(":");
    if (k < 1) continue;
    const category = line.slice(0, k).trim();
    const substring = line.slice(k + 1).trim();
    if (category && substring) rows.push({ category, substring });
  }
  return rows;
}

// The private file holds the values this public scanner must never name: the owner's
// machine, tailnet and account names. A plain line is a whole-word, case-insensitive
// literal; `sha256:<hex>` is the digest of a word token (6+ chars of a name, a path
// segment or an address, `_` and `.` included), so a config that only carries digests
// still catches the same token wherever it appears.
const PRIVATE_FILE = join(HERE, "pii-private.txt");
const WORD = /[A-Za-z0-9_.-]{6,}/g;
const SHA256_LITERAL = /^sha256:\s*([0-9a-f]{64})$/i;

function loadPrivate() {
  if (!existsSync(PRIVATE_FILE)) return [];
  const rows = [];
  for (const raw of readFileSync(PRIVATE_FILE, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const hashed = SHA256_LITERAL.exec(line);
    if (hashed) {
      rows.push({ category: "private_sha256", hex: hashed[1].toLowerCase() });
    } else {
      const body = line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      rows.push({ category: "hostname", re: new RegExp(`\\b${body}\\b`, "gi") });
    }
  }
  return rows;
}

const UNESCAPE = (s) => s.replace(/\\+/g, "\\");

const isPlaceholder = (category, raw) => {
  if (category === "email") return EMAIL_PLACEHOLDERS.some((re) => re.test(raw));
  if (category === "tsnet") return TSNET_PLACEHOLDERS.some((re) => re.test(raw));
  return false;
};

function record(allow, flat, row, out) {
  if (allow.some((a) => a.category === row.category && flat.includes(UNESCAPE(a.substring)))) out.allowlisted.push(row);
  else out.hits.push(row);
}

function scanLine(allow, privateRows, file, lineNo, text, out) {
  const flat = UNESCAPE(text);
  for (const [category, patterns] of Object.entries(CATEGORIES)) {
    for (const re of Array.isArray(patterns) ? patterns : [patterns]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        // A CIDR operator immediately after the last octet makes it a range, not an address.
        if (text[m.index + m[0].length] === "/") continue;
        if (isPlaceholder(category, m[0])) continue;
        record(allow, flat, { file, line: lineNo, category, match: m[0] }, out);
      }
    }
  }
  for (const p of privateRows) {
    if (p.re) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(text)) !== null) record(allow, flat, { file, line: lineNo, category: p.category, match: m[0] }, out);
      continue;
    }
    // Digest form: each word token is hashed and compared; the token is reported, never the hash.
    for (const [token] of text.matchAll(WORD)) {
      if (createHash("sha256").update(token).digest("hex") === p.hex) {
        record(allow, flat, { file, line: lineNo, category: p.category, match: token }, out);
      }
    }
  }
}

function scanText(allow, privateRows, file, bytes, out) {
  // A NUL byte in the first 8 KiB is the binary tell for files without a known extension.
  if (BINARY_EXT.test(file) || bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) return;
  // The rule source carries the literals it describes (a doc line, a `\x5c` form), so it
  // is scanned only past the `# ---` header that closes its rules; the entries stay live.
  if (/[\\/]pii-allowlist\.txt$/.test(file)) {
    const cut = bytes.lastIndexOf(Buffer.from("\n# ---"));
    if (cut >= 0) bytes = bytes.subarray(cut + 1);
  }
  const lines = bytes.toString("utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) scanLine(allow, privateRows, file, i + 1, lines[i], out);
}

// Every file in the working tree except the paths git itself refuses to track (.git) and
// the dependency/build directories the repository ignores, plus the private file — which
// holds the very literals this scan reports, and must never be scanned or pushed.
// Entries are taken only when they are regular files, so a directory symlink can never
// walk out of the repository.
const WORKTREE_SKIP = new Set([".git", "node_modules", ".expo", ".expo-shared", "dist", "build", ".wiki-cache", ".dsh-wiki"]);
const PRIVATE_REL = "tools/pii-private.txt";
function walkWorktree(dir, rel, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (WORKTREE_SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    let stat;
    try { stat = lstatSync(full); } catch { continue; }
    if (stat.isDirectory()) walkWorktree(full, relPath, out);
    else if (stat.isFile()) out.push(relPath);
  }
  return out;
}

const allow = loadAllowlist();
const privateRows = loadPrivate();
const out = { hits: [], allowlisted: [] };
let files = 0;

if (opts.mode === "worktree") {
  // One blob per file, so a staged-but-older version of a working file cannot mask an edit.
  for (const f of walkWorktree(root, "", [])) {
    if (f === PRIVATE_REL) continue;
    let bytes;
    try {
      bytes = readFileSync(join(root, f));
    } catch {
      continue; // unreadable entry
    }
    scanText(allow, privateRows, f, bytes, out);
    files++;
  }
} else if (opts.mode === "staged") {
  for (const f of git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]).split("\n").filter(Boolean)) {
    let bytes;
    try {
      bytes = execFileSync("git", ["show", `:${f}`], { cwd: root, maxBuffer: 1 << 28 });
    } catch {
      continue; // staged deletion or an unreadable index entry
    }
    scanText(allow, privateRows, f, bytes, out);
    files++;
  }
} else {
  for (const f of git(["ls-files", "-z"]).split("\0").filter(Boolean)) {
    let bytes;
    try {
      bytes = readFileSync(join(root, f));
    } catch {
      continue; // tracked but deleted in the working tree
    }
    scanText(allow, privateRows, f, bytes, out);
    files++;
  }
}

for (const h of out.hits) console.log(`${h.file}:${h.line}: ${h.category}: ${h.match}`);
for (const a of out.allowlisted) console.error(`allowlisted ${a.file}:${a.line}: ${a.category}: ${a.match}`);
if (out.hits.length) {
  console.error(`scan-pii: FAIL - ${out.hits.length} finding(s) in ${files} file(s) (${opts.mode})`);
  process.exit(1);
}
if (!opts.quiet) console.log(`scan-pii: clean - ${files} file(s) scanned (${opts.mode})`);
process.exit(0);
