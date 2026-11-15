#!/bin/bash
# cleanup-dev-caches.sh - reclaim workstation-level caches the iOS build leaves on the Mac.
#
# Runs ON THE MAC, over ssh, as the build user. It is a MANUAL tool: the driver never calls it,
# and it never runs after a build on its own. Two separate, explicit scopes:
#
#   --docker-build-cache   BuildKit cache only: `docker builder prune -a -f`. Never images,
#                          containers, volumes, networks or Docker.raw.
#   --claude-temp          leftovers under the Claude temp root (claude-<uid>), handled ONE
#                          SUBDIRECTORY AT A TIME: never the root, never a blind recursive
#                          delete of it.
#
#   ssh mac '/bin/bash ~/.dsh-ios-build/cleanup-dev-caches.sh'                      # dry run
#   ssh mac '/bin/bash ~/.dsh-ios-build/cleanup-dev-caches.sh --apply --docker-build-cache --claude-temp'
#
# DEFAULT IS A DRY RUN: it prints the plan (with sizes) and changes nothing. Deletion needs
# --apply AND at least one explicit scope flag; there is no "--apply everything".
#
# Scope guards, all fail-closed (a check that cannot be made is a SKIP, never a delete):
#   * the temp root is derived, never hardcoded: $TMPDIR/claude-<uid> when $TMPDIR is set, else
#     /tmp/claude-<uid>; it must be a REAL directory (lstat, no symlink) directly under /private/tmp
#     or /tmp, owned by the current uid, mode 0700 or 0755, and outside any git work tree;
#   * a candidate is the root's immediate physical child: a real directory (no symlink), same
#     owner, not on a read-only mount, and older than --temp-min-age-hours (default 24) by BOTH
#     its directory mtime and its newest file, so a file touched just now protects the whole
#     candidate;
#   * an in-use candidate is skipped when a process HOLDS IT OPEN, has it as (or under) its
#     CURRENT WORKING DIRECTORY, or NAMES IT in its COMMAND LINE (lsof AND ps AND cwd are all
#     asked; if any probe cannot run, the candidate is skipped). "lsof alone" is not proof of
#     non-use, and the reverse is true too;
#   * the exact absolute path is re-verified (parent, lstat, dev+ino, owner, age, no process
#     reference) immediately before each delete: the root's parent is world-writable (1777), so
#     another local user could swap a name between planning and deleting. The root itself is
#     refused even if it somehow reached the plan;
#   * build outputs are never candidates: a path this repository's git work tree tracks, or one
#     of those paths with subdirectories appended (a build tree rooted at a tracked directory).
#
# Concurrency is inherently racy: a process that starts using a candidate between the check and
# the delete is not seen by either method. Run --apply on a quiet Mac.
#
# Tests: test/cleanup-dev-caches.tests.sh (macOS bash 3.2; Git Bash cannot run it).
#
# Exit codes: 0 ok (including "nothing to do" or skips) | 2 bad usage or unsafe environment |
# 1 an --apply step failed (the report names which).

set -Eeuo pipefail

APPLY=0
DOCKER_BUILD_CACHE=0
CLAUDE_TEMP=0
QUIET=0
TEMP_MIN_AGE_HOURS=24
TEMP_ROOT_OVERRIDE=''
# Output stays bounded: a size above the ceiling prints as "> N GB".
readonly SIZE_CEILING_KB=134217728
# Test hook: a docker client to use instead of the discovered one. Tests point this at a mock;
# the default is discovery, never a hardcoded path.
DOCKER_BIN_OVERRIDE=${CLEANUP_DOCKER_BIN:-}
# Test hook: a git binary to use for the tracked-files check (default: /usr/bin/git).
GIT_BIN=${CLEANUP_GIT_BIN:-/usr/bin/git}

EXIT=0
FREE_BEFORE_KB=0

TEMP_ROOT=''
TEMP_ROOTS=()
AVAILABLE_ROOTS=()
TRACKED_INDEX=''
REPO_TOP=''

log() { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*"; }
out() { printf '%s\n' "$*"; }
err() { printf 'ERROR: %s\n' "$*" >&2; }
die() { err "$*"; exit 2; }
skip() { printf 'SKIP  %s\n' "$*"; }
note() { printf '          %s\n' "$*"; }

usage() {
    cat <<'EOF'
cleanup-dev-caches.sh - reclaim workstation caches the build leaves on the Mac (manual tool)

Usage:
  bash cleanup-dev-caches.sh --docker-build-cache [--claude-temp]            # dry run
  bash cleanup-dev-caches.sh --apply --docker-build-cache [--claude-temp]    # delete

Scopes (at least one is required):
  --docker-build-cache     BuildKit cache only: docker builder prune -a -f
  --claude-temp            leftovers under the claude-<uid> temp root, one subdirectory at a time

Options:
  --apply                   actually delete (default is a dry run that prints and exits)
  --temp-min-age-hours=<n>  leave temp candidates newer than n hours (default 24, minimum 1)
  --temp-root=<dir>         test hook: <dir> becomes <dir>/claude-<uid> and must then pass every
                            structural guard and the UID check, exactly as the real root does
  --quiet                   print only the plan, warnings and errors (and skips)
  --help                    this text

Never touched: Docker images, containers, volumes, networks, Docker.raw, DerivedData,
simulators, runtimes, or anything outside the two scopes above.
Exit codes: 0 ok | 1 an apply step failed | 2 bad usage or unsafe environment.
EOF
}

# --------------------------------------------------------------------------- arguments

is_uint() {
    case "${1:-}" in
        '' | *[!0-9]*) return 1 ;;
    esac
    return 0
}

need_value() {
    if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
        die "option $1 needs a value"
    fi
}

parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --apply) APPLY=1 ;;
            --dry-run) APPLY=0 ;;
            --docker-build-cache) DOCKER_BUILD_CACHE=1 ;;
            --claude-temp) CLAUDE_TEMP=1 ;;
            --quiet) QUIET=1 ;;
            --temp-min-age-hours=*) TEMP_MIN_AGE_HOURS=${1#*=} ;;
            --temp-root=*) TEMP_ROOT_OVERRIDE=${1#*=} ;;
            --temp-min-age-hours) need_value "$@"; TEMP_MIN_AGE_HOURS=$2; shift ;;
            --temp-root) need_value "$@"; TEMP_ROOT_OVERRIDE=$2; shift ;;
            --help | -h) usage; exit 0 ;;
            # Accept the "--" some drivers insert before passing flags to a remote bash.
            --) ;;
            *) die "unknown argument: $1 (try --help)" ;;
        esac
        shift
    done
}

# --------------------------------------------------------------------------- guards

validate_environment() {
    if [ "$(/usr/bin/id -u)" -eq 0 ]; then
        die "refusing to run as root: this tool deletes inside the invoking user's temp root"
    fi
    case "${HOME:-}" in
        '' | '/') die "refusing to run: \$HOME is '${HOME:-}' (empty or the filesystem root)" ;;
    esac
    is_uint "$TEMP_MIN_AGE_HOURS" || die "bad --temp-min-age-hours '$TEMP_MIN_AGE_HOURS' (whole hours)"
    [ "$TEMP_MIN_AGE_HOURS" -ge 1 ] ||
        die "--temp-min-age-hours must be at least 1: a 0-hour policy would delete a session that just started"
    if [ "$APPLY" -eq 1 ] && [ "$DOCKER_BUILD_CACHE" -eq 0 ] && [ "$CLAUDE_TEMP" -eq 0 ]; then
        die "--apply needs an explicit scope: --docker-build-cache and/or --claude-temp"
    fi
    if [ "$DOCKER_BUILD_CACHE" -eq 0 ] && [ "$CLAUDE_TEMP" -eq 0 ]; then
        die "nothing selected: pass --docker-build-cache and/or --claude-temp (see --help)"
    fi
}

# free_kb <mount>: available 1K blocks there, or empty when it cannot be read.
free_kb() {
    { /bin/df -k "${1:-/}" 2>/dev/null | /usr/bin/awk 'END {print $4}'; } || true
}

kb_of() {
    { /usr/bin/du -sk "$1" 2>/dev/null | /usr/bin/awk '{print $1}'; } || true
}

# show_size <kb>: bounded, human size for one line of output.
show_size() {
    local kb="$1" pre=''
    if [ "$kb" -gt "$SIZE_CEILING_KB" ]; then
        kb="$SIZE_CEILING_KB"
        pre='>'
    fi
    if [ "$kb" -ge 1048576 ]; then
        printf '%s%sG' "$pre" "$(((kb + 524288) / 1048576))"
    else
        printf '%s%sM' "$pre" "$(((kb + 511) / 1024))"
    fi
}

# physical_of <path>: the physical absolute path (every symlink resolved), or nothing.
# macOS has no /usr/bin/realpath, so this is the portable idiom: cd into it and ask pwd -P.
physical_of() {
    local p="$1" out
    [ -d "$p" ] || return 1
    out=$(cd -- "$p" 2>/dev/null && /bin/pwd -P 2>/dev/null) || return 1
    [ -n "$out" ] || return 1
    printf '%s\n' "$out"
}

# physical_parent_of <path>: the physical path of <path>'s directory (for a path that may be a
# file or a not-yet-existing name, which physical_of refuses).
physical_parent_of() {
    local d
    d=$(/usr/bin/dirname "$1")
    physical_of "$d"
}

# read_only_mount_of <path>: "yes" when a read-only mount covers the path (directly or as an
# ancestor). A read-only bind mount - the kind a sandbox uses - never shows up in lsof, so it is
# probed here instead. Any inability to read the mount table prints "yes" (fail closed).
read_only_mount_of() {
    local path mounts mnt line
    mounts=$(/sbin/mount 2>/dev/null) || { printf 'yes\n'; return 0; }
    while IFS= read -r line; do
        case "$line" in
            *'(read-only,'*) : ;;
            *) continue ;;
        esac
        # "<device> on <mountpoint> (read-only, ...)" - the mountpoint is the 3rd field.
        mnt=$(printf '%s\n' "$line" | /usr/bin/awk '{ for (i = 1; i <= NF; i++) if ($i == "on") { print $(i + 1); exit } }')
        [ -n "${mnt:-}" ] || continue
        case "$path" in
            "$mnt" | "$mnt"/*) printf 'yes\n'; return 0 ;;
        esac
    done <<-MOUNTS
	$mounts
	MOUNTS
    printf 'no\n'
}

# --------------------------------------------------------------------------- claude temp root

# resolve_temp_root: derive and prove the root. Returns 1 (after a SKIP line) on any doubt.
#
# Two locations exist in the wild: $TMPDIR/claude-<uid> (what recent clients use) and
# /tmp/claude-<uid> (the legacy location; measured on the owner's Mac 2026-11-14, where $TMPDIR
# held nothing and /tmp held 3.9 GB). Without an override the scanner takes whichever of the two
# EXISTS, and when both do it examines BOTH: none of them is hardcoded, and the chosen paths are
# printed. Every structural guard below applies to each one.
TEMP_ROOTS=()
resolve_temp_root() {
    local hint parent
    local env_root='' legacy_root=''
    AVAILABLE_ROOTS=()
    if [ -n "$TEMP_ROOT_OVERRIDE" ]; then
        hint="$TEMP_ROOT_OVERRIDE/claude-$(/usr/bin/id -u)"
        if [ ! -e "$hint" ]; then
            skip "temp root: $hint does not exist (nothing to clean)"
            return 1
        fi
        AVAILABLE_ROOTS+=("$hint")
        TEMP_ROOT=''
        resolve_one_root "$hint" || return 1
        TEMP_ROOTS=("$TEMP_ROOT")
        return 0
    fi
    if [ -n "${TMPDIR:-}" ]; then
        env_root="${TMPDIR%/}/claude-$(/usr/bin/id -u)"
    fi
    legacy_root="/tmp/claude-$(/usr/bin/id -u)"
    if [ -n "$env_root" ] && [ -e "$env_root" ]; then
        AVAILABLE_ROOTS+=("$env_root")
    fi
    if [ -e "$legacy_root" ]; then
        AVAILABLE_ROOTS+=("$legacy_root")
    fi
    if [ "${#AVAILABLE_ROOTS[@]}" -eq 0 ]; then
        skip "temp root: no claude-$(/usr/bin/id -u) under \$TMPDIR or /tmp (nothing to clean)"
        return 1
    fi
    # Resolving is per root: one bad root must not hide the other, but any refusal is reported.
    TEMP_ROOTS=()
    local ok=0 one
    for one in "${AVAILABLE_ROOTS[@]}"; do
        if resolve_one_root "$one"; then
            TEMP_ROOTS+=("$TEMP_ROOT")
            ok=1
        fi
    done
    if [ "$ok" -eq 0 ]; then
        return 1
    fi
    TEMP_ROOT=${TEMP_ROOTS[0]}
    return 0
}

# resolve_one_root <hint>: prove ONE root; sets TEMP_ROOT on success.
resolve_one_root() {
    local hint="$1" parent
    if [ -L "$hint" ]; then
        skip "temp root: $hint is a symlink - refusing to treat a link as the root"
        return 1
    fi
    [ -d "$hint" ] || { skip "temp root: $hint is not a directory"; return 1; }
    TEMP_ROOT=$(physical_of "$hint") || { skip "temp root: $hint is not resolvable"; return 1; }
    case "$TEMP_ROOT" in
        */claude-"$(/usr/bin/id -u)") : ;;
        *) skip "temp root: ${TEMP_ROOT:-<unresolved>} is not a .../claude-$(/usr/bin/id -u) path"; return 1 ;;
    esac
    parent=$(/usr/bin/dirname "$TEMP_ROOT")
    [ -d "$parent" ] || { skip "temp root: parent $parent is missing"; return 1; }
    if [ "$(physical_of "$parent")" != "$parent" ]; then
        skip "temp root: parent $parent is itself a symlink"
        return 1
    fi
    if [ "$(/usr/bin/stat -f '%u' "$TEMP_ROOT" 2>/dev/null)" != "$(/usr/bin/id -u)" ]; then
        skip "temp root: $TEMP_ROOT is not owned by uid $(/usr/bin/id -u)"
        return 1
    fi
    case "$(/usr/bin/stat -f '%Sp' "$TEMP_ROOT" 2>/dev/null)" in
        drwx------ | drwxr-xr-x) : ;;
        *) skip "temp root: $TEMP_ROOT has an unexpected mode ($(/usr/bin/stat -f '%Sp' "$TEMP_ROOT" 2>/dev/null))"; return 1 ;;
    esac
    # A temp root inside a git work tree could hold tracked build work: refuse the whole scope.
    if "$GIT_BIN" -C "$TEMP_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        skip "temp root: $TEMP_ROOT sits inside a git work tree - refusing the whole temp scope"
        return 1
    fi
    return 0
}

# --------------------------------------------------------------------- build-output protection

# load_tracked_index: this repository's tracked paths, one per line. Sets TRACKED_INDEX (empty
# when there is no work tree to ask, which is a legitimate state - the age and use checks still
# apply).
load_tracked_index() {
    TRACKED_INDEX=''
    REPO_TOP=''
    local here
    here=$(physical_of "$(dirname "$0")")
    # The script normally lives inside the repository (mac/ of remote-ios-build), but it is also
    # copied to ~/.dsh-ios-build on the Mac. Try both, and the invoking directory.
    REPO_TOP=$("$GIT_BIN" -C "$here" rev-parse --show-toplevel 2>/dev/null) || true
    case "${REPO_TOP:-}" in
        /*) : ;;
        *) REPO_TOP=$("$GIT_BIN" -C "${HOME:-/}" rev-parse --show-toplevel 2>/dev/null) || true ;;
    esac
    case "${REPO_TOP:-}" in
        /*) : ;;
        *) return 0 ;;
    esac
    TRACKED_INDEX=$("$GIT_BIN" -C "$REPO_TOP" ls-files 2>/dev/null) || TRACKED_INDEX=''
    return 0
}

# is_tracked_build_tree <dir>: "yes" when <dir> is a path this repository tracks, or one of
# those paths with subdirectories appended (a build tree rooted at a tracked directory).
is_tracked_build_tree() {
    local dir="$1" base abs
    [ -n "$TRACKED_INDEX" ] || { printf 'no\n'; return 0; }
    case "$base" in
        -*) : ;;
        *) printf 'no\n'; return 0 ;;
    esac
    # Claude names project copies -Users-foo-Documents-GitHub-Repo-sub, i.e. an absolute path with
    # the leading slash and every separator written as a dash. Rebuild that path.
    abs="/$(printf '%s' "${base#-}" | /usr/bin/tr '\055' '/')"
    case "$abs" in
        "${HOME%/}/"*) abs=${abs#"${HOME%/}/"} ;;
        *) printf 'no\n'; return 0 ;;
    esac
    if printf '%s\n' "$TRACKED_INDEX" | /usr/bin/awk -v c="$abs" '
        { if ($0 == c || index($0, c "/") == 1) { found = 1; exit } }
        END { exit(found ? 0 : 1) }'; then
        printf 'yes\n'
    else
        printf 'no\n'
    fi
}

# ------------------------------------------------------------------- claude temp: candidates

# candidate_age_ok <dir>: "yes" when older than the policy by directory mtime AND newest file;
# otherwise one line saying why not. Any inspection failure prints a reason (never "yes").
candidate_age_ok() {
    local dir="$1" minutes now dir_secs newest_secs
    minutes=$((TEMP_MIN_AGE_HOURS * 60))
    now=$(/bin/date +%s)
    dir_secs=$(/usr/bin/stat -f '%m' "$dir" 2>/dev/null) || { printf 'directory mtime unreadable\n'; return 0; }
    if [ "$dir_secs" -gt "$((now - minutes * 60))" ]; then
        printf 'directory mtime newer than %sh\n' "$TEMP_MIN_AGE_HOURS"
        return 0
    fi
    # The whole subtree: a file touched just now protects the candidate even if the directory
    # was not touched.
    if ! newest_secs=$(/usr/bin/find "$dir" -type f -exec /usr/bin/stat -f '%m' {} + 2>/dev/null |
        /usr/bin/sort -n | /usr/bin/tail -n 1); then
        printf 'file list unreadable (find/stat failed)\n'
        return 0
    fi
    if [ -n "${newest_secs:-}" ] && [ "$newest_secs" -gt "$((now - minutes * 60))" ]; then
        printf 'newest file newer than %sh\n' "$TEMP_MIN_AGE_HOURS"
        return 0
    fi
    # Empty is fine ONLY with an old directory mtime (checked above): such a dir is old evidence.
    printf 'yes\n'
}

# ref_evidence <path>: zero or more "how detail" lines proving a process references the path
# (open file, cwd, or command-line argument). Prints an EVIDENCE line; returns
#   0 = no reference found, and the probes all ran
#   3 = references found (the lines say how)
#   2 = could not inspect (a probe is missing or failed): the caller must treat it as in use
ref_evidence() {
    local path="$1"
    local lsof_bin ps_bin
    lsof_bin=${CLEANUP_LSOF_BIN:-/usr/sbin/lsof}
    ps_bin=${CLEANUP_PS_BIN:-/bin/ps}
    if [ ! -x "$lsof_bin" ]; then printf 'probe-unavailable lsof missing at %s\n' "$lsof_bin"; return 2; fi
    if [ ! -x "$ps_bin" ]; then printf 'probe-unavailable ps missing at %s\n' "$ps_bin"; return 2; fi

    local open_out cwd_out ps_out
    # lsof +D exits 1 both when nothing in the tree is open AND when it found matches, so the
    # exit code says nothing about "in use". Measured on macOS 26: with hits, it still prints
    # "p<pid>/f<fd>/n<name>" fields and exits 1. The output is therefore the evidence, and the
    # probe counts as failed only when its text is not lsof field output (an error message).
    open_out=$("$lsof_bin" -Fpn +D "$path" 2>&1) || true
    if [ -n "$open_out" ] && ! printf '%s\n' "$open_out" | /usr/bin/grep -q '^[pfn]'; then
        printf 'probe-failed lsof +D: %s\n' "$(printf '%s\n' "$open_out" | /usr/bin/head -n 1)"
        return 2
    fi
    if ! cwd_out=$("$lsof_bin" -a -d cwd -Fpn 2>&1); then
        printf 'probe-failed lsof cwd\n'
        return 2
    fi
    if ! ps_out=$("$ps_bin" -axo pid=,command= 2>/dev/null); then
        printf 'probe-failed ps\n'
        return 2
    fi

    local hit hit_cwd hit_ps found=0
    # 1) open files (grouped: "p<pid>" then "n<name>")
    # lsof -F emits one field per line, each tagged with its kind: "p" + pid, "f" + fd, "n" +
    # name - and also single-character fields such as "f1" (fd 1) between them. The fd line
    # "f1" starts with "f", NOT "n" ... but a NAME line always starts with exactly "n".
    hit=$(printf '%s\n' "$open_out" | /usr/bin/awk -v root="$path" '
        /^p/ { pid = substr($0, 2); next }
        /^n/ {
            f = substr($0, 2)
            if (f == root || index(f, root "/") == 1) { printf "open pid=%s %s\n", pid, f }
        }')
    # 2) cwd of every process
    hit_cwd=$(printf '%s\n' "$cwd_out" | /usr/bin/awk -v root="$path" '
        /^p/ { pid = substr($0, 2); next }
        /^n/ {
            f = substr($0, 2)
            if (f == root || index(f, root "/") == 1) { printf "cwd pid=%s %s\n", pid, f }
        }')
    # 3) command-line arguments. The script's own process is excluded: its argv contains the
    #    planned path by design, and it is the one deleting, not using.
    hit_ps=$(printf '%s\n' "$ps_out" | /usr/bin/awk -v root="$path" -v self="$$" '
        {
            pid = $1
            if (pid == self) next
            cmd = $0
            sub(/^[ \t]*[0-9]+[ \t]+/, "", cmd)
            n = split(cmd, tok, " ")
            for (i = 1; i <= n; i++) {
                if (tok[i] == root || index(tok[i], root "/") == 1) {
                    line = cmd
                    gsub(/\t/, " ", line)
                    if (length(line) > 150) line = substr(line, 1, 150) "..."
                    printf "cmdline pid=%s %s\n", pid, line
                    break
                }
            }
        }')
    if [ -n "$hit" ]; then printf '%s\n' "$hit"; found=1; fi
    if [ -n "$hit_cwd" ]; then printf '%s\n' "$hit_cwd"; found=1; fi
    if [ -n "$hit_ps" ]; then printf '%s\n' "$hit_ps"; found=1; fi
    if [ "$found" -eq 1 ]; then
        return 3
    fi
    return 0
}

# ------------------------------------------------------------------- claude temp: planning

TEMP_CANDIDATES=()   # absolute paths of the candidates the checks will evaluate
TEMP_PLANNED=()      # absolute paths that passed every check
TEMP_PLANNED_ID=()   # the same, as "<dev>:<ino>" captured at planning time
TEMP_PLANNED_ROOT=() # the same, as the root each path was planned under

collect_candidates() {
    local entry name
    TEMP_CANDIDATES=()
    [ -d "$TEMP_ROOT" ] || return 0
    for entry in "$TEMP_ROOT"/*; do
        [ -e "$entry" ] || continue
        if [ -f "$entry" ] || [ -L "$entry" ]; then
            # A plain (or linked) FILE directly in the root is never a candidate: it could be an
            # open log the agent is writing (cache-break-state-*.json, *.log, ...).
            name=$(/usr/bin/basename "$entry")
            skip "temp: file $name kept (only real subdirectories can be candidates)"
            continue
        fi
        # Only real directories are candidates; check_candidate proves the rest.
        TEMP_CANDIDATES+=("$entry")
    done
    return 0
}

# check_candidate <path> <min-age-hours>: prove every per-candidate rule before it becomes a
# candidate. Any failure is a SKIP line; only a fully proven dir returns 0.
check_candidate() {
    local path="$1" name why
    name=$(/usr/bin/basename "$path")
    if [ "$path" = "$TEMP_ROOT" ]; then
        skip "temp: refusing the root $TEMP_ROOT itself (only its subdirectories can go)"
        return 1
    fi
    if [ -L "$path" ]; then
        skip "temp: $name is a symlink - refusing (not a real directory)"
        return 1
    fi
    if [ ! -d "$path" ]; then
        skip "temp: $name is not a directory - skipped (only subdirectories are candidates)"
        return 1
    fi
    case "$path" in
        "$TEMP_ROOT"/*) : ;;
        *)
            skip "temp: $name is not directly inside $TEMP_ROOT - skipped"
            return 1
            ;;
    esac
    if [ "$(/usr/bin/stat -f '%u' "$path" 2>/dev/null)" != "$(/usr/bin/id -u)" ]; then
        skip "temp: $name is not owned by uid $(/usr/bin/id -u) - skipped"
        return 1
    fi
    # A read-only mount (a sandbox bind mount) never appears in lsof and cannot be cleaned anyway.
    if [ "$(read_only_mount_of "$path")" = 'yes' ] || [ ! -w "$path" ]; then
        skip "temp: $name is on a read-only mount or not writable - skipped"
        return 1
    fi
    if [ "$(is_tracked_build_tree "$path")" = 'yes' ]; then
        skip "temp: $name is a tracked path of this repository (build output) - kept"
        return 1
    fi
    # Identity and size, captured once: the plan prints them and the delete phase re-checks them.
    size_kb=$(kb_of "$path")
    is_uint "${size_kb:-}" || size_kb=0
    CAND_SIZE_KB="$size_kb"
    # Age and use are BOTH reported, even when one alone already refuses the candidate: an idle
    # reader of the log must see that a directory is young AND that a live process holds it, not
    # only whichever check happened to run first.
    local age_why ev rc refs=''
    age_why=$(candidate_age_ok "$path")
    set +e
    ev=$(ref_evidence "$path")
    rc=$?
    set -e
    case "$rc" in
        3) refs=$(printf '%s' "$ev" | /usr/bin/head -n 1) ;;
        0) : ;;
        *) refs='cannot be inspected for use' ;;
    esac
    if [ "$age_why" != 'yes' ] || [ "$rc" -ne 0 ]; then
        if [ "$age_why" != 'yes' ] && [ "$rc" -eq 3 ]; then
            skip "temp: $name is not old enough ($age_why) AND IN USE by a live process ($refs)"
        elif [ "$age_why" != 'yes' ]; then
            skip "temp: $name is not old enough ($age_why)"
        elif [ "$rc" -eq 3 ]; then
            skip "temp: $name is IN USE by a live process ($refs)"
        else
            skip "temp: $name cannot be inspected for use ($(printf '%s' "$ev" | /usr/bin/head -n 1)) - skipped (fail closed)"
        fi
        if [ -n "${ev:-}" ]; then
            printf '%s\n' "$ev" | /usr/bin/head -n 6 | /usr/bin/sed 's/^/          /' || true
        fi
        return 1
    fi
    return 0
}

# --------------------------------------------------------------------------- docker scope

# docker_bin: discovered client or the test override; prints the path, or nothing.
docker_bin() {
    if [ -n "$DOCKER_BIN_OVERRIDE" ]; then
        case "$DOCKER_BIN_OVERRIDE" in
            /*) printf '%s\n' "$DOCKER_BIN_OVERRIDE"; return 0 ;;
            *)  printf '%s\n' "$DOCKER_BIN_OVERRIDE"; return 0 ;;
        esac
    fi
    local c
    c=$(command -v docker 2>/dev/null) || true
    case "$c" in
        /*) printf '%s\n' "$c"; return 0 ;;
    esac
    for c in /usr/local/bin/docker /opt/homebrew/bin/docker \
        /Applications/Docker.app/Contents/Resources/bin/docker; do
        if [ -x "$c" ]; then
            printf '%s\n' "$c"
            return 0
        fi
    done
    return 1
}

plan_docker_build_cache() {
    local bin out
    if ! bin=$(docker_bin); then
        skip "docker: no docker CLI found - build-cache scope skipped"
        return 0
    fi
    # The semantics of the command this tool issues are confirmed against the installed CLI.
    if ! out=$("$bin" builder prune --help 2>&1); then
        skip "docker: builder prune --help failed (Docker not running?) - scope skipped"
        return 0
    fi
    case "$out" in
        *'-a, --all'* ) : ;;
        *) skip "docker: builder prune lacks -a/--all on this CLI - refusing"; return 0 ;;
    esac
    case "$out" in
        *Remove*'build cache'* | *Remove*build*cache*) : ;;
        *) skip "docker: builder prune does not describe itself as build-cache only - refusing"; return 0 ;;
    esac
    # Read-only snapshot first: the plan shows the before numbers and what will be reclaimed.
    if out=$("$bin" system df --format '{{.Type}}\t{{.TotalCount}}\t{{.Size}}\t{{.Reclaimable}}' 2>&1); then
        printf 'docker   : before (type / count / size / reclaimable)\n'
        printf '%s\n' "$out" | /usr/bin/head -n 8 | /usr/bin/sed 's/^/          /'
        printf 'docker   : reclaimable build cache %s\n' \
            "$(printf '%s\n' "$out" | /usr/bin/awk -F'\t' '$1 ~ /Build cache|Build Cache/ {print $4; exit}')"
    else
        printf 'docker   : system df unreadable (reporting the help check only)\n'
    fi
    # Scope proof: the invocation below is the ONLY docker write this script can make.
    printf 'docker   : %s (build cache only; the only write this script issues is: %s builder prune -a -f)\n' \
        "$bin" "$bin"
    if [ "$APPLY" -ne 1 ]; then
        return 0
    fi
    if ! out=$("$bin" builder prune -a -f < /dev/null 2>&1); then
        err "docker: builder prune failed"
        printf '%s\n' "$out" | /usr/bin/head -n 10
        EXIT=1
        return 0
    fi
    printf 'docker   : builder prune output (tail)\n'
    printf '%s\n' "$out" | /usr/bin/tail -n 2 | /usr/bin/sed 's/^/          /'
    if out=$("$bin" system df --format '{{.Type}}\t{{.TotalCount}}\t{{.Size}}\t{{.Reclaimable}}' 2>&1); then
        printf 'docker   : after\n'
        printf '%s\n' "$out" | /usr/bin/head -n 8 | /usr/bin/sed 's/^/          /'
    fi
}

# --------------------------------------------------------------------------- plan and delete

print_plan_start() {
    log "cleanup-dev-caches.sh: $( if [ "$APPLY" -eq 1 ]; then printf 'APPLY (deleting)'; else printf 'DRY RUN (nothing is deleted)'; fi )"
    log "host     : $(/usr/bin/uname -n) ($(/usr/bin/uname -m)), user $(/usr/bin/id -un)"
    FREE_BEFORE_KB=$(free_kb /System/Volumes/Data)
    is_uint "${FREE_BEFORE_KB:-}" || FREE_BEFORE_KB=0
    log "free     : $(show_size "$FREE_BEFORE_KB") free on /System/Volumes/Data before"
}

# plan_claude_temp: every candidate gets a decision, printed as PLAN or SKIP, BEFORE any delete.
plan_claude_temp() {
    local path kb name root
    TEMP_PLANNED=()
    TEMP_PLANNED_ID=()
    TEMP_PLANNED_ROOT=()
    if ! resolve_temp_root; then
        return 0
    fi
    for root in "${TEMP_ROOTS[@]}"; do
        TEMP_ROOT="$root"
        log "temp     : root $TEMP_ROOT (real dir, uid $(/usr/bin/id -u), mode $(/usr/bin/stat -f '%Sp' "$TEMP_ROOT"))"
        collect_candidates
        if [ "${#TEMP_CANDIDATES[@]}" -eq 0 ]; then
            log "temp     : no entries under $TEMP_ROOT"
            continue
        fi
        for path in "${TEMP_CANDIDATES[@]}"; do
            name=$(/usr/bin/basename "$path")
            if check_candidate "$path"; then
                kb=$(kb_of "$path")
                is_uint "${kb:-}" || kb=0
                TEMP_PLANNED+=("$path")
                TEMP_PLANNED_ID+=("$(/usr/bin/stat -f '%d:%i' "$path" 2>/dev/null)")
                TEMP_PLANNED_ROOT+=("$TEMP_ROOT")
                printf 'PLAN  %8s temp: %s (older than %sh, no process reference)\n' \
                    "$(show_size "$kb")" "$name" "$TEMP_MIN_AGE_HOURS"
            fi
        done
    done
    if [ "${#TEMP_PLANNED[@]}" -eq 0 ]; then
        log "temp     : nothing removable (all candidates were skipped; see SKIP lines)"
    fi
}

# verify_for_delete <path> <dev:ino-at-plan> <root-at-plan>: the exact absolute target,
# re-checked immediately before deletion. Anything unexpected refuses THAT path; the others
# still proceed. <root-at-plan> is the root whose subtree this path was planned under.
verify_for_delete() {
    local path="$1" planned_id="$2" root="$3" name
    name=$(/usr/bin/basename "$path")
    if [ -L "$path" ]; then
        err "temp: $name became a symlink at delete time - refusing"
        return 1
    fi
    if [ ! -d "$path" ]; then
        err "temp: $name is no longer a directory at delete time - refusing"
        return 1
    fi
    # The physical parent must still be the planned root, and the name must be ONE component:
    # anything that resolved elsewhere (a swapped root, a "/", "..", "") is refused outright.
    local phys_parent
    phys_parent=$(physical_parent_of "$path") || {
        err "temp: parent of $name is not resolvable at delete time - refusing"
        return 1
    }
    if [ "$phys_parent" != "$root" ]; then
        err "temp: $name is no longer under $root at delete time (parent is $phys_parent) - refusing"
        return 1
    fi
    case "${path#"$root/"}" in
        '' | */* | *..* ) err "temp: $name is not an immediate safe child at delete time"; return 1 ;;
    esac
    # Identity: the parent is world-writable (1777), so a name can be swapped between planning
    # and deleting. The (dev, inode) pair recorded at planning must still be the target's.
    if [ "$(/usr/bin/stat -f '%d:%i' "$path" 2>/dev/null)" != "$planned_id" ]; then
        err "temp: $name was replaced between planning and deleting (dev:ino changed) - refusing"
        return 1
    fi
    if [ "$(/usr/bin/stat -f '%u' "$path" 2>/dev/null)" != "$(/usr/bin/id -u)" ]; then
        err "temp: $name changed owner at delete time - refusing"
        return 1
    fi
    if [ "$(read_only_mount_of "$path")" = 'yes' ]; then
        err "temp: $name is now on a read-only mount at delete time - refusing"
        return 1
    fi
    local why
    why=$(candidate_age_ok "$path")
    if [ "$why" != 'yes' ]; then
        err "temp: $name is no longer old enough at delete time ($why) - refusing"
        return 1
    fi
    local ev rc
    set +e
    ev=$(ref_evidence "$path")
    rc=$?
    set -e
    if [ "$rc" -ne 0 ]; then
        err "temp: $name is in use or cannot be inspected at delete time ($(printf '%s' "$ev" | /usr/bin/head -n 1)) - refusing"
        return 1
    fi
    return 0
}

apply_claude_temp() {
    local i=0 path root n=0 total
    [ "$APPLY" -eq 1 ] || return 0
    total=${#TEMP_PLANNED[@]}
    [ "$total" -gt 0 ] || return 0
    while [ "$i" -lt "$total" ]; do
        path=${TEMP_PLANNED[$i]}
        root=${TEMP_PLANNED_ROOT[$i]}
        if verify_for_delete "$path" "${TEMP_PLANNED_ID[$i]}" "$root"; then
            printf 'removing %s\n' "$path"
            if /bin/rm -rf -- "$path"; then
                n=$((n + 1))
            else
                err "temp: could not remove $path"
                EXIT=1
            fi
        else
            EXIT=1
        fi
        i=$((i + 1))
    done
    printf 'temp     : removed %s of %s planned subdirectories\n' "$n" "$total"
}

# --------------------------------------------------------------------------- main

main() {
    parse_args "$@"
    validate_environment
    load_tracked_index
    print_plan_start

    if [ "$CLAUDE_TEMP" -eq 1 ]; then
        plan_claude_temp
    fi
    if [ "$DOCKER_BUILD_CACHE" -eq 1 ]; then
        plan_docker_build_cache
    fi

    if [ "$APPLY" -ne 1 ]; then
        log ""
        log "dry run  : nothing was deleted and nothing was changed (pass --apply to delete)"
        exit "$EXIT"
    fi

    if [ "$CLAUDE_TEMP" -eq 1 ] && [ "${#TEMP_PLANNED[@]}" -gt 0 ]; then
        # apply_claude_temp re-verifies every planned path - root parent, dev:ino, owner, age and
        # process references - immediately before removing it. The plan above is the only list,
        # and a path whose checks no longer hold is refused individually.
        apply_claude_temp
    fi

    # APFS returns deleted blocks lazily, so an immediate reading understates the reclaim. Tests
    # shorten this with CLEANUP_SETTLE_SECONDS.
    local settle=${CLEANUP_SETTLE_SECONDS:-5}
    is_uint "$settle" || settle=5
    /bin/sleep "$settle"
    local after
    after=$(free_kb /System/Volumes/Data)
    is_uint "${after:-}" || after=$FREE_BEFORE_KB
    log ""
    log "free     : $(show_size "$FREE_BEFORE_KB") -> $(show_size "$after") on /System/Volumes/Data (after)"
    if [ "$EXIT" -eq 0 ]; then
        log "done     : every planned item was removed"
    else
        err "done     : finished with failures (see the ERROR lines above)"
    fi
    exit "$EXIT"
}

main "$@"
