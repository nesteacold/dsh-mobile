// Tests for tools/scan-pii.mjs. Run: node --test tools/scan-pii.test.mjs
//
// Each case builds a throwaway git repo, plants one finding per file, and asserts the
// scanner names it (exit 1). A clean case asserts exit 0; an allowlisted case asserts
// the finding is reported but does not fail the run. The planted literals are built at
// run time so this test file carries no personal data of its own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCANNER = join(HERE, "scan-pii.mjs");

// Built piecewise: an email, a tailnet name, a private literal, a key header and the
// vendor token prefixes never appear as literals in this file.
const at = "@";
const DOTS = ".".repeat(1);
const HOST_PLACEHOLDER = ["mac-mini", "tailnet", "ts", "net"].join(DOTS);
// A stand-in for a machine name, used only through tools/pii-private.txt.
const PRIVATE_LITERAL = ["fake", "pri", "vate"].join("") + "-" + ["ma", "chine"].join("");
// The host name the scanner's `hostname` rule looks for, assembled at run time.
const PLANTED_HOST = ["Toma", "hawk"].join("") + "-" + ["Sig", "ma"].join("");
const KEY_HEADER = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
const AWS_TOKEN = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const GH_TOKEN = ["gh", "p_"].join("") + "a".repeat(36);
const OWNER = "ow" + "ner";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "scan-pii-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t" + at + "example.com", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  mkdirSync(join(root, "tools"), { recursive: true });
  cpSync(SCANNER, join(root, "tools", "scan-pii.mjs"));
  return root;
}

function run(root, args = []) {
  const r = spawnSync(process.execPath, [join(root, "tools", "scan-pii.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function addAndStage(root, name, text) {
  writeFileSync(join(root, name), text);
  execFileSync("git", ["add", name], { cwd: root });
}

const cleanup = (root) => rmSync(root, { recursive: true, force: true });

test("clean tree passes and reports the file count", () => {
  const root = repo();
  addAndStage(root, "ok.txt", "nothing private here\n");
  const r = run(root);
  assert.equal(r.status, 0);
  assert.match(r.out, /scan-pii: clean/);
  cleanup(root);
});

test("a non-placeholder email fails the scan", () => {
  const root = repo();
  addAndStage(root, "a.md", "contact owner <someone" + at + "corp.example> for access\n");
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.out, new RegExp("a\\.md:1: email: someone" + at + "corp\\.example"));
  cleanup(root);
});

test("noreply placeholders are not findings", () => {
  const root = repo();
  addAndStage(root, "b.md", "bot <41898282+github-actions[bot]" + at + "users.noreply.github.com>\n");
  const r = run(root);
  assert.equal(r.status, 0);
  cleanup(root);
});

test("a Tailscale address is a finding, the CGNAT range text is not", () => {
  const root = repo();
  const ip = [100, 90, 240, 75].join(".");
  addAndStage(root, "c.md", "host at " + ip + " (range 100.64.0.0/10)\n");
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.out, new RegExp("c\\.md:1: tailscale_ip: " + ip.replace(/\./g, "\\.")));
  cleanup(root);
});

test("a tailnet name and a Windows user path are findings", () => {
  const root = repo();
  const sep = String.fromCharCode(92);
  addAndStage(root, "d.md", `wss://${HOST_PLACEHOLDER}:8443\n`);
  addAndStage(root, "e.md", `config lives in C:${sep}Users${sep}${OWNER}${sep}.config\n`);
  // The classroom placeholder (`<name>`), not a one-letter user: `--worktree` scans the
  // scanner's own copied source, and a lone `x` here would be a finding in every temp repo.
  addAndStage(root, "e2.js", `const p = 'C:${sep}${sep}Users${sep}${sep}${OWNER}${sep}x';\n`);
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.out, /d\.md:1: tsnet: /);
  assert.match(r.out, /e\.md:1: windows_user_path: /);
  assert.match(r.out, /e2\.js:1: windows_user_path: /, "the escaped form is a finding too");
  cleanup(root);
});

// The scanner carries no personal pattern itself: tools/pii-private.txt (git-ignored,
// absent in a fresh clone) supplies them.
test("a private-file literal is a finding, case-insensitively", () => {
  const root = repo();
  writeFileSync(join(root, "tools", "pii-private.txt"), `# private test list\n${PRIVATE_LITERAL}\n`);
  addAndStage(root, "f.md", `host ${PRIVATE_LITERAL.toUpperCase()} refused the link\n`);
  const r = run(root);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /f\.md:1: hostname: /i);
  cleanup(root);
});

test("a private-file sha256 entry is a finding and the hash itself never matches", () => {
  const root = repo();
  const hex = createHash("sha256").update(PRIVATE_LITERAL).digest("hex");
  writeFileSync(join(root, "tools", "pii-private.txt"), `sha256:${hex}\n`);
  addAndStage(root, "f.md", `host ${PRIVATE_LITERAL} refused the link\n`);
  const r = run(root);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /f\.md:1: private_sha256: /);
  // A word token is hashed whole, so a longer token containing the value does not match.
  addAndStage(root, "g.md", `host ${PRIVATE_LITERAL}-extra refused the link\n`);
  addAndStage(root, "h.md", "sha256:" + hex + "\n");
  const r2 = run(root);
  assert.equal(r2.status, 1, r2.out);
  assert.doesNotMatch(r2.out, /g\.md/);
  assert.doesNotMatch(r2.out, /h\.md/);
  cleanup(root);
});

test("no private file means no private findings", () => {
  const root = repo();
  addAndStage(root, "f.md", `host ${PRIVATE_LITERAL} refused the link\n`);
  const r = run(root);
  assert.equal(r.status, 0, r.out);
  cleanup(root);
});

test("private keys and vendor tokens are findings", () => {
  const root = repo();
  addAndStage(root, "g.txt", KEY_HEADER + "\n");
  addAndStage(root, "h.txt", "token " + AWS_TOKEN + "\n");
  addAndStage(root, "i.txt", GH_TOKEN + "\n");
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.out, /g\.txt:1: private_key/);
  assert.match(r.out, /h\.txt:1: token: AKIA/);
  assert.match(r.out, /i\.txt:1: token: gh/);
  cleanup(root);
});

test("binary files are skipped", () => {
  const root = repo();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x61, 0x40, 0x62, 0x2e, 0x63]);
  writeFileSync(join(root, "logo.png"), bytes);
  execFileSync("git", ["add", "logo.png"], { cwd: root });
  const r = run(root);
  assert.equal(r.status, 0);
  cleanup(root);
});

test("an allowlist entry exempts its own line, not another address on it", () => {
  const root = repo();
  const allowed = "no" + "tifications" + at + "allowed.example";
  writeFileSync(join(root, "tools", "pii-allowlist.txt"), "# test\nemail:" + at + "allowed.example\n");
  addAndStage(root, "j.md", "rate-limited by " + allowed + "\n");
  const r = run(root);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /allowlisted j\.md:1: email/);
  addAndStage(root, "k.md", "leaked other" + at + "real.example\n");
  const r2 = run(root);
  assert.equal(r2.status, 1, r2.out);
  assert.match(r2.out, new RegExp("k\\.md:1: email: other" + at + "real\\.example"));
  cleanup(root);
});

test("--worktree sees an untracked file that --all never looks at", () => {
  const root = repo();
  writeFileSync(join(root, "tools", "pii-private.txt"), `${PRIVATE_LITERAL}\n`);
  // Created but never `git add`ed: exactly a file copied in from a private checkout.
  writeFileSync(join(root, "copied.md"), "host " + PRIVATE_LITERAL + " was here\n");
  const all = run(root);
  assert.equal(all.status, 0, "--all only reads the index, so the copy is invisible");
  const worktree = run(root, ["--worktree"]);
  assert.equal(worktree.status, 1, worktree.out);
  assert.match(worktree.out, /copied\.md:1: hostname/);
  cleanup(root);
});

test("--worktree skips dependency and build directories and stays inside the repository", () => {
  const root = repo();
  writeFileSync(join(root, "tools", "pii-private.txt"), `${PRIVATE_LITERAL}\n`);
  writeFileSync(join(root, "clean.md"), "nothing private here\n");
  for (const dir of ["node_modules", ".git", "dist"]) {
    mkdirSync(join(root, dir), { recursive: true });
    // A finding planted inside a skipped directory must not reach the scan output.
    writeFileSync(join(root, dir, "planted.md"), "host " + PRIVATE_LITERAL + "\n");
  }
  const r = run(root, ["--worktree"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /scan-pii: clean/);
  cleanup(root);
});

test("--staged scans the index blob, not the working copy", () => {
  const root = repo();
  addAndStage(root, "k.md", "clean\n");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t", "commit", "-q", "-m", "k"], { cwd: root });
  // stash the leak in the index while the working copy stays clean
  const ip = [100, 66, 1, 2].join(".");
  writeFileSync(join(root, "k.md"), "leak: " + ip + "\n");
  execFileSync("git", ["add", "k.md"], { cwd: root });
  writeFileSync(join(root, "k.md"), "clean\n");
  const r = run(root, ["--staged"]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /k\.md:1: tailscale_ip/);
  cleanup(root);
});
