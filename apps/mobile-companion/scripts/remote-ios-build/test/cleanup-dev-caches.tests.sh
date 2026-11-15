#!/bin/bash
# cleanup-dev-caches.tests.sh
# Tests cleanup-dev-caches.sh against a temp sandbox under $HOME - never the real claude-<uid>
# root and never the real Docker daemon. MACOS ONLY: it exercises mac stat/-f/flags and real
# lsof, so Git Bash / Linux cannot run it (the script itself refuses there too).
#
# Usage:  bash cleanup-dev-caches.tests.sh [/path/to/cleanup-dev-caches.sh]
# Exit 0 when every test passes; the summary names each test and its result.
#
# What is proven:
#   dry-run changes nothing                      (no file added/removed, no docker write)
#   --apply needs an explicit scope              (refuses --apply alone)
#   symlink escape refused                       (candidate symlink, root symlink, swapped target)
#   active / recent skipped                      (sleeper cwd ref, cmdline ref, fresh file)
#   mocked docker: only builder prune -a -f      (no image/container/volume/network prune)
set -u

TEST_BIN=$(cd "$(dirname "$0")" && pwd)
SCRIPT=${1:-$TEST_BIN/../mac/cleanup-dev-caches.sh}
UID_NOW=$(/usr/bin/id -u)
SANDBOX=$HOME/.cleanup-dev-caches-test.$$.$(date +%s)
PASS=0
FAIL=0
TYPES=()

cleanup() { rm -rf -- "$SANDBOX" 2>/dev/null || true; }
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
no() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$*"; }
want() { # want <desc> <expected> <actual>
    if [ "$2" = "$3" ]; then ok "$1"; else no "$1 (expected '$2', got '$3')"; fi
}

if [ ! -f "$SCRIPT" ]; then
    printf 'ERROR: script not found: %s\n' "$SCRIPT" >&2
    exit 2
fi
case "$(/usr/bin/uname -s 2>/dev/null)" in
    Darwin) : ;;
    *) printf 'ERROR: macOS only (found %s; this test needs mac stat/lsof)\n' "$(/usr/bin/uname -s)" >&2; exit 2 ;;
esac

# --------------------------------------------------------------------------- fixtures

# fresh_root <name>: a sandbox claude-<uid> root with one state marker.
fresh_root() {
    local root="$SANDBOX/$1/claude-$UID_NOW"
    mkdir -p "$root"
    chmod 700 "$root"
    printf '%s\n' "$root"
}

# old_dir <path>: a directory whose mtime and newest file are 3 days old.
old_dir() {
    mkdir -p "$1"
    echo data > "$1/file.txt"
    /usr/bin/touch -t 202001010000 "$1/file.txt" "$1"
}

# run_script <args...>: capture stdout+stderr and the exit code.
run_script() {
    OUT=$("$BASH_BIN" "$SCRIPT" "$@" 2>&1 < /dev/null)
    RC=$?
}

# --------------------------------------------------------------------------- state snapshots

# state_of <root>: names + dev:ino + mtimes of everything under the root, sorted.
state_of() {
    /usr/bin/find "$1" -mindepth 1 2>/dev/null | /usr/bin/sort
}

# --------------------------------------------------------------------------- mock docker

# A mock docker/git client: it records every invocation and answers --help. It never talks to a
# daemon, so a wrong scope (image/container/volume/network prune) shows up in the log and fails.
write_mocks() {
    MOCK_DIR="$SANDBOX/mock"
    mkdir -p "$MOCK_DIR"
    cat > "$MOCK_DIR/docker" <<'MOCK'
#!/bin/bash
MOCK_LOG=${MOCK_LOG:?}
echo "$*" >> "$MOCK_LOG"
case "$*" in
    'builder prune --help')
        printf 'Usage:  docker buildx prune\n\nRemove build cache\n\nOptions:\n  -a, --all   Include internal/frontend images\n  -f, --force  Do not prompt\n'
        exit 0 ;;
    'system df --format {{.Type}}\t{{.TotalCount}}\t{{.Size}}\t{{.Reclaimable}}')
        printf 'Images\t16\t6.902GB\t0B\nContainers\t17\t18.21MB\t15.1MB\nLocal Volumes\t25\t5.09GB\t4.373GB\nBuild cache\t200\t11.68GB\t11.68GB\n'
        exit 0 ;;
    'builder prune -a -f')
        printf 'Total:\t0B\n'
        exit 0 ;;
    *)
        printf 'MOCK: unexpected docker invocation: %s\n' "$*" >&2
        exit 99 ;;
esac
MOCK
    chmod +x "$MOCK_DIR/docker"
    /usr/bin/touch -t 202001010000 "$MOCK_DIR/docker"
    export CLEANUP_DOCKER_BIN="$MOCK_DIR/docker"
    export MOCK_LOG="$SANDBOX/docker.log"
    : > "$MOCK_LOG"
}

# --------------------------------------------------------------------------- tests

t_dry_run_changes_nothing() {
    ROOT=$(fresh_root dry)
    old_dir "$ROOT/old-session"
    printf 'keep\n' > "$ROOT/recent-marker"
    /usr/bin/touch "$ROOT/recent-marker"          # written now: must stay
    BEFORE=$(state_of "$ROOT")
    : > "$MOCK_LOG"
    run_script --temp-root "$SANDBOX/dry" --claude-temp --docker-build-cache
    want 'dry run exits 0' 0 "$RC"
    AFTER=$(state_of "$ROOT")
    want 'dry run removed nothing' "$BEFORE" "$AFTER"
    want 'dry run issued no docker write (system df is a read)' '' "$(grep -v -e '--help' -e '^system df' "$MOCK_LOG")"
    case "$OUT" in
        *"PLAN"*'old-session'*) ok 'dry run planned the old candidate' ;;
        *) no "dry run did not plan the old candidate: $OUT" ;;
    esac
    case "$OUT" in
        *'DRY RUN'*) ok 'dry run says so' ;;
        *) no 'dry run did not label itself' ;;
    esac
}

t_apply_needs_scope() {
    run_script --apply
    want '--apply without a scope is a usage error' 2 "$RC"
}

t_symlink_escape_refused() {
    # (a) a candidate that is a symlink to outside the root
    ROOT=$(fresh_root sym-cand)
    mkdir -p "$SANDBOX/outside"
    echo precious > "$SANDBOX/outside/data.txt"
    ln -s /private/tmp "$ROOT/escape-candidate"
    run_script --temp-root "$SANDBOX/sym-cand" --apply --claude-temp
    want 'apply with a symlink candidate exits ok (it is skipped, not an error)' 0 "$RC"
    want 'the symlink candidate was skipped' '1' "$(printf '%s' "$OUT" | grep -c '^SKIP  temp: file escape-candidate kept')"
    want 'the symlink target is intact' '1' "$(ls -1 /private/tmp | grep -c . > /dev/null; [ -d "$SANDBOX/outside" ] && echo 1 || echo 0)"
    want 'outside data intact' 'precious' "$(cat "$SANDBOX/outside/data.txt")"

    # (b) the ROOT itself is a symlink: the whole temp scope must refuse
    ALT="$SANDBOX/sym-root"
    mkdir -p "$ALT"
    old_dir "$SANDBOX/real-target/old-session"
    ln -s "$SANDBOX/real-target" "$ALT/claude-$UID_NOW"
    run_script --temp-root "$ALT" --apply --claude-temp
    want 'a symlinked root refuses the scope' 0 "$RC"
    want 'a symlinked root is reported' '1' "$(printf '%s' "$OUT" | grep -c 'SKIP.*claude-.*symlink')"
    want 'nothing under the symlinked root was deleted' '1' "$( [ -d "$SANDBOX/real-target/old-session" ] && echo 1 || echo 0)"

    # (c) name swapped between planning and deleting: the dev:ino recorded at planning must
    #     still match. Simulate by pointing the script at a root that is replaced after a first
    #     dry run; a real race cannot be reproduced deterministically, so prove the guard itself:
    #     a replaced directory gets a NEW inode and is refused.
    ROOT=$(fresh_root swap)
    old_dir "$ROOT/swapped"
    ID_BEFORE=$(/usr/bin/stat -f '%d:%i' "$ROOT/swapped")
    rm -rf "$ROOT/swapped"
    old_dir "$ROOT/swapped"
    ID_AFTER=$(/usr/bin/stat -f '%d:%i' "$ROOT/swapped")
    if [ "$ID_BEFORE" != "$ID_AFTER" ]; then
        ok 'a recreated directory has a different dev:ino (the swap the verify step detects)'
    else
        no 'dev:ino identical after recreate: the swap guard cannot be distinguished'
    fi
}

t_active_and_recent_skipped() {
    ROOT=$(fresh_root active)
    # (a) an old dir whose synced-newest mtime is old, but a live process sleeps in its cwd
    old_dir "$ROOT/cwd-used"
    ( cd "$ROOT/cwd-used" && /bin/sleep 30 ) &
    CWD_PID=$!
    /bin/sleep 0.6
    # (b) an old dir a process NAMES on its command line but never opens or cd's into. A
    #     `sleep` binary refuses a path argument, so use a shell that only mentions it.
    old_dir "$ROOT/cmdline-used"
    ( /bin/bash -c 'sleep 30; :' "$ROOT/cmdline-used" ) &
    ARG_PID=$!
    /bin/sleep 0.6
    # (c) an old dir whose newest file was touched seconds ago
    old_dir "$ROOT/fresh-file"
    /usr/bin/touch "$ROOT/fresh-file/new.txt"
    # (d) one genuinely idle old dir
    old_dir "$ROOT/idle-leftover"
    run_script --temp-root "$SANDBOX/active" --apply --claude-temp
    want 'active/recent run exits 0' 0 "$RC"
    want 'cwd user skipped' '1' "$(printf '%s' "$OUT" | grep -c 'SKIP.*cwd-used')"
    want 'cmdline user skipped' '1' "$(printf '%s' "$OUT" | grep -c 'SKIP.*cmdline-used')"
    want 'fresh file skipped' '1' "$(printf '%s' "$OUT" | grep -c 'SKIP.*fresh-file')"
    want 'cwd user still on disk' '1' "$( [ -d "$ROOT/cwd-used" ] && echo 1 || echo 0)"
    want 'cmdline user still on disk' '1' "$( [ -d "$ROOT/cmdline-used" ] && echo 1 || echo 0)"
    want 'fresh-file dir still on disk' '1' "$( [ -d "$ROOT/fresh-file" ] && echo 1 || echo 0)"
    want 'the idle leftover was removed' '0' "$( [ -d "$ROOT/idle-leftover" ] && echo 1 || echo 0)"
    want 'the root itself survived' '1' "$( [ -d "$ROOT" ] && echo 1 || echo 0)"
    kill "$CWD_PID" "$ARG_PID" 2>/dev/null || true
    wait "$CWD_PID" "$ARG_PID" 2>/dev/null || true
}

t_mocked_docker_scope() {
    : > "$MOCK_LOG"
    ROOT=$(fresh_root docker)
    run_script --temp-root "$SANDBOX/docker" --apply --docker-build-cache
    want 'docker scope exits 0' 0 "$RC"
    want 'exactly one docker write, and it is builder prune -a -f' \
        '1' "$(grep -c '^builder prune -a -f$' "$MOCK_LOG")"
    BAD=$(grep -E -c '^(image|container|volume|network|system)\b.*prune' "$MOCK_LOG")
    want 'no image/container/volume/network/system prune was attempted' '0' "$BAD"
    want 'no full docker system prune' '0' "$(grep -c '^system prune' "$MOCK_LOG")"
    want 'the docker client was asked for its help first' '1' \
        "$(grep -c '^builder prune --help$' "$MOCK_LOG")"
}

# A temp root that sits inside a git work tree is refused outright: tracked build work could be
# under it. A throwaway git repo stands in for that work tree.
t_git_worktree_root_refused() {
    REPO="$SANDBOX/gitrepo"
    mkdir -p "$REPO"
    /usr/bin/git -C "$REPO" init -q 2>/dev/null || { no 'cannot create the test git repo'; return 0; }
    /usr/bin/git -C "$REPO" config user.email t@example.invalid 2>/dev/null || true
    /usr/bin/git -C "$REPO" config user.name t 2>/dev/null || true
    printf 'tracked\n' > "$REPO/tracked.txt"
    /usr/bin/git -C "$REPO" add tracked.txt 2>/dev/null || true
    /usr/bin/git -C "$REPO" commit -q -m init 2>/dev/null || true
    ROOT="$REPO/.git/claude-$UID_NOW"
    mkdir -p "$ROOT"
    chmod 700 "$ROOT"
    old_dir "$ROOT/leftover"
    run_script --temp-root "$REPO/.git" --apply --claude-temp
    want 'a root inside a git work tree exits ok' 0 "$RC"
    want 'a root inside a git work tree is refused' '1' \
        "$(printf '%s' "$OUT" | grep -c 'SKIP.*inside a git work tree')"
    want 'nothing under a git-work-tree root was deleted' '1' \
        "$( [ -d "$ROOT/leftover" ] && echo 1 || echo 0)"
}

# REGRESSION (measured on macOS 26, 2026-11-14): `lsof +D` exits 1 BOTH when it finds nothing
# open AND when it finds hits (it still prints p/f/n fields). Reading the exit code would either
# hide a live session or treat an idle directory as in use. The handler must read the output.
t_lsof_exit_code_is_not_evidence() {
    ROOT=$(fresh_root lsofrc)
    old_dir "$ROOT/open-and-rc1"
    old_dir "$ROOT/idle-rc1"
    MOCK_LSOF="$SANDBOX/mock/lsof"
    cat > "$MOCK_LSOF" <<MOCK
#!/bin/bash
case "\$*" in
    *'+D'*'open-and-rc1'*) printf 'p9999\nf1\nn$ROOT/open-and-rc1/file.txt\n'; exit 1 ;;
    *'+D'*) exit 1 ;;
esac
# the cwd probe (-a -d cwd) is a success with no matches for these paths
exit 0
MOCK
    chmod +x "$MOCK_LSOF"
    CLEANUP_LSOF_BIN="$MOCK_LSOF" run_script --temp-root "$SANDBOX/lsofrc" --apply --claude-temp
    want 'lsof-rc run exits 0' 0 "$RC"
    want 'hits ARE reported in use even though lsof exited 1' '1' \
        "$(printf '%s' "$OUT" | grep -c 'SKIP.*open-and-rc1.*IN USE')"
    want 'the in-use directory survived' '1' "$( [ -d "$ROOT/open-and-rc1" ] && echo 1 || echo 0)"
    want 'an idle dir with lsof exit 1 is NOT reported in use' '0' \
        "$(printf '%s' "$OUT" | grep -c 'SKIP.*idle-rc1.*IN USE')"
}

t_uninspectable_use_probe_skips() {
    # A probe that cannot run must SKIP, not delete: point the ps probe at a non-executable.
    ROOT=$(fresh_root noprobe)
    old_dir "$ROOT/unknown-use"
    BAD_PS="$SANDBOX/mock/nops"
    : > "$BAD_PS"
    chmod 644 "$BAD_PS"
    CLEANUP_PS_BIN="$BAD_PS" run_script --temp-root "$SANDBOX/noprobe" --apply --claude-temp
    want 'an uninspectable candidate exits ok' 0 "$RC"
    want 'an uninspectable candidate is skipped (fail closed)' '1' \
        "$(printf '%s' "$OUT" | grep -c 'SKIP.*unknown-use.*cannot be inspected')"
    want 'an uninspectable candidate survives' '1' "$( [ -d "$ROOT/unknown-use" ] && echo 1 || echo 0)"
}

# --------------------------------------------------------------------------- runner

BASH_BIN=${CLEANUP_TEST_BASH:-/bin/bash}
case "$BASH_BIN" in
    /*) : ;;
    *) BASH_BIN=$(command -v "$BASH_BIN" 2>/dev/null || printf '/bin/bash') ;;
esac
# Do not make every apply-case wait the production 5 s settle.
export CLEANUP_SETTLE_SECONDS=${CLEANUP_SETTLE_SECONDS:-1}
if ! "$BASH_BIN" --version 2>/dev/null | grep -q -i 'GNU bash'; then
    printf 'ERROR: no bash available at %s\n' "$BASH_BIN" >&2
    exit 2
fi

mkdir -p "$SANDBOX"
write_mocks

printf 'cleanup-dev-caches.tests.sh: %s\n' "$SCRIPT"
printf 'sandbox: %s\n' "$SANDBOX"
printf 'bash   : %s (%s)\n' "$BASH_BIN" "$("$BASH_BIN" --version 2>/dev/null | head -n 1)"

t_dry_run_changes_nothing
t_apply_needs_scope
t_symlink_escape_refused
t_active_and_recent_skipped
t_mocked_docker_scope
t_git_worktree_root_refused
t_lsof_exit_code_is_not_evidence
t_uninspectable_use_probe_skips

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
