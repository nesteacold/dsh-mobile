#!/bin/bash
# cleanup-after-build.sh - remove this project's regenerable build output on the Mac.
#
# Runs ON THE MAC, over ssh, as the build user. ios-build.sh calls it (best effort) at the end
# of every run, next to the staged orchestrator, so a failed or interrupted build cannot leave
# 10+ GB of DerivedData behind. It is also safe to run by hand:
#
#   ssh mac '/bin/bash ~/.dsh-ios-build/cleanup-after-build.sh'              # dry run
#   ssh mac '/bin/bash ~/.dsh-ios-build/cleanup-after-build.sh' -- --apply   # delete
#
# DEFAULT IS A DRY RUN: it prints every path it would remove, with its size, and changes
# nothing. Deletion requires an explicit --apply.
#
# Scope is deliberately narrow:
#   * only $HOME of the build user, plus (with --volumes) the driver's own APFS volume name;
#   * only regenerable build output - never source, never settings, never documents;
#   * never Archives (signed builds may be needed) or iOS DeviceSupport unless asked for;
#   * never keychains, credentials, Downloads, Documents or another user's home;
#   * refuses to run as root, and refuses a $HOME that is empty or the filesystem root.
#
# Exit codes: 0 ok (including "nothing to do") | 2 bad usage or unsafe environment | 1 a
# deletion failed (the report names which).
#
# Measured context (2026-11-14, owner's Mac): the pipeline's own builds leave nothing outside
# the APFS volume, but Flutter/Xcode runs from other projects left ~1.7 GB of DerivedData,
# ~3.9 GB of /tmp scratch copies and ~3.7 GB of Gradle caches behind in one week.

set -Eeuo pipefail

readonly VOL_NAME='DSHIosBuild'
# ${HOME:-} rather than $HOME: with `set -u` an unset HOME would abort at parse time with a
# cryptic "unbound variable" instead of reaching the guard below, which explains the refusal.
readonly STAGE_ROOT="${HOME:-}/.dsh-ios-build"
readonly DD_ROOT="${HOME:-}/Library/Developer/Xcode/DerivedData"
readonly ARCHIVE_ROOT="${HOME:-}/Library/Developer/Xcode/Archives"
readonly DEVICE_SUPPORT_ROOT="${HOME:-}/Library/Developer/Xcode/iOS DeviceSupport"
# DerivedData folders are named <project>-<hash>. The name is only the first signal: is_ours()
# also reads the WorkspacePath Xcode recorded in <folder>/info.plist, so a rename of the Expo app
# cannot make this script blind to (or greedy about) the right folder.
readonly DEFAULT_APP_NAME='DSHCompanion'
readonly APP_PATH_MARKER='/mobile-companion/'

APPLY=0
AUTO=0
QUIET=0
ALL_DERIVED_DATA=0
POD_CACHE=0
NPM_CACHE=0
DEVICE_SUPPORT=0
ARCHIVES=0
VOLUMES=0
CATALOG_CACHE=0
APP_NAME="$DEFAULT_APP_NAME"
KEEP_RUN_ID=''
MIN_AGE_HOURS=24
EXIT=0

# Sizes and paths are accumulated as parallel indexed arrays: macOS ships bash 3.2, which has
# no associative arrays and no mapfile.
PLAN_SIZE=()
PLAN_PATH=()
PLAN_WHY=()
PLAN_TOTAL_KB=0

FREE_BEFORE=0
FREE_AFTER=0

log() { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*"; }

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 2
}

usage() {
    cat <<'EOF'
cleanup-after-build.sh - reclaim the disk this project's builds leave on the Mac

Usage:
  bash cleanup-after-build.sh [options]            # dry run: print the plan, change nothing
  bash cleanup-after-build.sh --apply [options]    # delete what the plan lists

Options:
  --apply                  actually delete (default is a dry run that prints and exits)
  --auto                   what the driver's own run calls: stale stage dirs from earlier runs
                           plus this project's DerivedData; never anything else
  --keep-run-id=<id>       never touch ~/.dsh-ios-build/artifacts/<id> (this run's .ipa)
  --min-age-hours=<n>      leave stage runs, DerivedData folders (--auto) and device support
                           newer than n hours (default 24)
  --derived-data-name=<x>  project name to match in DerivedData (default: DSHCompanion)
  --all-derived-data       every DerivedData folder, not just this project's (wide, opt-in)
  --pod-cache              clear the CocoaPods cache (pod cache clean --all)
  --npm-cache              clear the npm cache (npm cache clean --force)
  --device-support         remove the iOS DeviceSupport symbol folders (explicit opt-in)
  --archives               remove .xcarchive bundles (explicit opt-in: signed builds may be
                           needed for upload or symbolication)
  --volumes                delete leftover APFS volumes named DSHIosBuild (outside $HOME;
                           reported always, deleted only with this flag AND --apply)
  --simulator-catalog-cache  remove the CoreSimulator dyld build catalog (rebuilds itself)
  --quiet                  print only warnings, errors and the summary
  --help                   this text

Always safe to run: the dry run reads the disk and nothing else.
Exit codes: 0 ok | 1 a deletion failed | 2 bad usage or unsafe environment.
EOF
}

# --------------------------------------------------------------------------- arguments

is_uint() {
    case "${1:-}" in
        '' | *[!0-9]*) return 1 ;;
    esac
    return 0
}

# need_value <option> <value> ...: shared by the "space separated" spellings of the options.
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
            --auto) AUTO=1 ;;
            --quiet) QUIET=1 ;;
            --all-derived-data) ALL_DERIVED_DATA=1 ;;
            --pod-cache) POD_CACHE=1 ;;
            --npm-cache) NPM_CACHE=1 ;;
            --device-support) DEVICE_SUPPORT=1 ;;
            --archives) ARCHIVES=1 ;;
            --volumes) VOLUMES=1 ;;
            --simulator-catalog-cache) CATALOG_CACHE=1 ;;
            --keep-run-id=*) KEEP_RUN_ID=${1#*=} ;;
            --min-age-hours=*) MIN_AGE_HOURS=${1#*=} ;;
            --derived-data-name=*) APP_NAME=${1#*=} ;;
            # Space-separated spellings: take the next argument and consume both.
            --keep-run-id) need_value "$@"; KEEP_RUN_ID=$2; shift ;;
            --min-age-hours) need_value "$@"; MIN_AGE_HOURS=$2; shift ;;
            --derived-data-name) need_value "$@"; APP_NAME=$2; shift ;;
            --help | -h) usage; exit 0 ;;
            # Accept the "--" some drivers insert before passing flags to a remote bash.
            --) ;;
            *) die "unknown argument: $1 (try --help)" ;;
        esac
        shift
    done
}

# --------------------------------------------------------------------------- guards

# Root would make every rm below catastrophic (and $HOME would be /var/root, not the owner's).
validate_environment() {
    if [ "$(/usr/bin/id -u)" -eq 0 ]; then
        die "refusing to run as root: this script deletes under \$HOME only"
    fi

    case "${HOME:-}" in
        '' | '/') die "refusing to run: \$HOME is '${HOME:-}' (empty or the filesystem root)" ;;
    esac
    [ -d "$HOME" ] || die "refusing to run: \$HOME ($HOME) is not a directory"

    is_uint "$MIN_AGE_HOURS" || die "bad --min-age-hours '$MIN_AGE_HOURS' (whole hours)"
    case "$APP_NAME" in
        '' | *[!A-Za-z0-9._-]*) die "bad --derived-data-name '$APP_NAME' (letters, digits, dot, dash, underscore)" ;;
    esac
    case "${KEEP_RUN_ID:-}" in
        *[!A-Za-z0-9._-]*) die "bad --keep-run-id '$KEEP_RUN_ID' (letters, digits, dot, dash, underscore)" ;;
    esac
}

# --------------------------------------------------------------------------- planning

# free_gb <mount>: available GB there, or empty when it cannot be read.
free_gb() {
    { /bin/df -g "${1:-/}" 2>/dev/null | /usr/bin/awk 'END {print $4}'; } || true
}

# kb_of <path>: allocated size in 1K blocks, or empty when it cannot be measured (a path the
# current user may not read). Never fails: with `pipefail` a failing du would abort the run.
kb_of() {
    { /usr/bin/du -sk "$1" 2>/dev/null | /usr/bin/awk '{print $1}'; } || true
}

# add_target <path> <why>: record one deletable item, after proving it really is inside $HOME.
# A path that is not an absolute path under $HOME is a bug in this script, so it aborts rather
# than turning into an `rm -rf` of something unexpected.
add_target() {
    local path="$1" why="$2" kb
    case "$path" in
        "$HOME"/*) : ;;
        *) die "internal: refusing to plan a path outside \$HOME: $path" ;;
    esac
    [ -e "$path" ] || return 0
    kb=$(kb_of "$path")
    is_uint "${kb:-}" || kb=0
    PLAN_SIZE+=("$kb")
    PLAN_PATH+=("$path")
    PLAN_WHY+=("$why")
    PLAN_TOTAL_KB=$((PLAN_TOTAL_KB + kb))
}

# Older than N hours? Used so a run in progress is never collected.
older_than() {
    local path="$1" hits
    hits=$(/usr/bin/find "$path" -maxdepth 0 -mmin +"$((MIN_AGE_HOURS * 60))" 2>/dev/null || true)
    [ -n "$hits" ]
}

plan_stage_leftovers() {
    local d base found=0
    if [ ! -d "$STAGE_ROOT/artifacts" ]; then
        log "stage    : none ($STAGE_ROOT/artifacts does not exist)"
        return 0
    fi
    for d in "$STAGE_ROOT/artifacts"/*; do
        [ -e "$d" ] || continue
        found=$((found + 1))
        base=$(/usr/bin/basename "$d")
        if [ -n "$KEEP_RUN_ID" ] && [ "$base" = "$KEEP_RUN_ID" ]; then
            log "stage    : keeping this run's artifact dir $base"
            continue
        fi
        if ! older_than "$d"; then
            log "stage    : keeping $base (newer than ${MIN_AGE_HOURS}h: a transfer may still need it)"
            continue
        fi
        add_target "$d" "stage: artifact dir of an earlier run"
    done
    [ "$found" -gt 0 ] || log "stage    : none (no staged runs under $STAGE_ROOT/artifacts)"
}

# products_of <derived-data-dir>: the workspace/project paths Xcode recorded for that folder.
# The folder name is a guess (<project>-<hash>) and it changes when the Expo app is renamed;
# the info.plist WorkspacePath is what Xcode actually built, so the match uses it when present.
workspace_path_of() {
    local plist="$1/info.plist"
    [ -f "$plist" ] || return 1
    /usr/libexec/PlistBuddy -c 'Print :WorkspacePath' "$plist" 2>/dev/null || return 1
}

# is_ours <derived-data-dir>: true when that folder belongs to this app.
is_ours() {
    local dir="$1" base ws
    base=$(/usr/bin/basename "$dir")
    # Name-based match first: it also covers the folders Xcode creates before an info.plist
    # exists (and the Pods-/ModuleCache- siblings of a real project folder).
    case "$base" in
        "$APP_NAME"-*) return 0 ;;
    esac
    ws=$(workspace_path_of "$dir") || return 1
    case "$ws" in
        *"$APP_PATH_MARKER"*) return 0 ;;
    esac
    return 1
}

plan_derived_data() {
    local d base found=0 matched=0
    if [ ! -d "$DD_ROOT" ]; then
        log "derived  : none ($DD_ROOT does not exist)"
        return 0
    fi
    for d in "$DD_ROOT"/*; do
        [ -d "$d" ] || continue
        found=$((found + 1))
        base=$(/usr/bin/basename "$d")
        if [ "$ALL_DERIVED_DATA" -eq 1 ]; then
            if ! older_than "$d"; then
                log "derived  : keeping $base (written within ${MIN_AGE_HOURS}h; a build may be using it)"
                continue
            fi
            add_target "$d" "derived: all DerivedData (--all-derived-data)"
            continue
        fi
        if ! is_ours "$d"; then
            continue
        fi
        matched=$((matched + 1))
        # A folder written moments ago may belong to a build running in the Xcode GUI right now,
        # so it is only reclaimable once it has been untouched for --min-age-hours. This guard
        # applies in both modes: a manual --apply must not eat a live build either.
        if ! older_than "$d"; then
            log "derived  : keeping $base (written within ${MIN_AGE_HOURS}h; a build may be using it)"
            continue
        fi
        add_target "$d" "derived: this project's DerivedData"
    done
    if [ "$ALL_DERIVED_DATA" -eq 0 ] && [ "$matched" -eq 0 ]; then
        log "derived  : no folder of this app among $found entries in $DD_ROOT"
    fi
}

plan_volume_leftovers() {
    local mounted=0 count
    if [ -e "/Volumes/$VOL_NAME" ]; then
        mounted=1
    fi
    # Registered but unmounted volumes are invisible to /Volumes and to df, yet they hold real
    # space - that is how six of them silently ate 16.5 GB (measured 2026-11-09).
    count=$(/usr/sbin/diskutil apfs list 2>/dev/null | /usr/bin/grep -c "Name: *$VOL_NAME" || true)
    is_uint "${count:-}" || count=0
    if [ "$mounted" -eq 1 ] || [ "${count:-0}" -gt 0 ]; then
        log "volume   : $count APFS volume(s) named $VOL_NAME registered, mounted=$mounted"
        if [ "$VOLUMES" -eq 1 ]; then
            # Outside $HOME, so it is not part of add_target's invariant: handled explicitly.
            PLAN_SIZE+=("0")
            PLAN_PATH+=("/Volumes/$VOL_NAME")
            PLAN_WHY+=("volume: leftover APFS build volume (--volumes)")
        else
            log "volume   : report only - pass --volumes WITH --apply to delete them"
        fi
    else
        log "volume   : no leftover $VOL_NAME volume in the APFS container"
    fi
}

plan_device_support() {
    local d
    if [ "$DEVICE_SUPPORT" -ne 1 ]; then
        return 0
    fi
    if [ ! -d "$DEVICE_SUPPORT_ROOT" ]; then
        log "device   : none ($DEVICE_SUPPORT_ROOT does not exist)"
        return 0
    fi
    for d in "$DEVICE_SUPPORT_ROOT"/*; do
        [ -e "$d" ] || continue
        if ! older_than "$d"; then
            log "device   : keeping $(/usr/bin/basename "$d") (newer than ${MIN_AGE_HOURS}h)"
            continue
        fi
        add_target "$d" "device support: iOS symbols (rebuilt on the next device connection)"
    done
}

plan_archives() {
    local d
    if [ "$ARCHIVES" -ne 1 ]; then
        return 0
    fi
    if [ ! -d "$ARCHIVE_ROOT" ]; then
        log "archives : none ($ARCHIVE_ROOT does not exist)"
        return 0
    fi
    for d in "$ARCHIVE_ROOT"/*/*.xcarchive; do
        [ -e "$d" ] || continue
        add_target "$d" "archives: signed build archive (--archives)"
    done
}

plan_caches() {
    if [ "$POD_CACHE" -eq 1 ]; then
        if [ -d "$HOME/Library/Caches/CocoaPods" ]; then
            add_target "$HOME/Library/Caches/CocoaPods" "cache: CocoaPods pod cache"
        else
            log "cache    : no CocoaPods cache at $HOME/Library/Caches/CocoaPods"
        fi
        if [ -d "$STAGE_ROOT/cocoapods" ]; then
            add_target "$STAGE_ROOT/cocoapods" "cache: persistent CocoaPods cache (--keep-pods-cache)"
        fi
    fi
    if [ "$NPM_CACHE" -eq 1 ]; then
        if [ -d "$HOME/.npm/_cacache" ]; then
            add_target "$HOME/.npm/_cacache" "cache: npm content-addressable cache"
        else
            log "cache    : no npm cache at $HOME/.npm/_cacache"
        fi
    fi
    if [ "$CATALOG_CACHE" -eq 1 ]; then
        if [ -d "/Library/Developer/CoreSimulator/Caches/dyld" ]; then
            # Root-owned system path: print the command instead of deleting outside $HOME.
            log "catalog  : /Library/Developer/CoreSimulator/Caches/dyld is root-owned; run by hand:"
            log "           sudo rm -rf /Library/Developer/CoreSimulator/Caches/dyld"
        else
            log "catalog  : no CoreSimulator dyld catalog present"
        fi
    fi
}

# --------------------------------------------------------------------------- execution

# remove_one <path> <why>: delete a planned path, keeping the $HOME invariant even here (the
# plan is built from guarded input, but the deletion is the dangerous step, so it re-checks).
remove_one() {
    local path="$1" why="$2"
    case "$path" in
        "$HOME"/*) : ;;
        "/Volumes/$VOL_NAME") : ;;
        *) printf 'ERROR: refusing to delete outside the guarded set: %s\n' "$path" >&2; EXIT=1; return 0 ;;
    esac
    if [ ! -e "$path" ]; then
        return 0
    fi
    printf 'removing %s (%s)\n' "$path" "$why"
    if /bin/rm -rf -- "$path" 2>/dev/null; then
        return 0
    fi
    printf 'ERROR: could not fully remove %s\n' "$path" >&2
    EXIT=1
}

apply_volume() {
    local n=0 max=12 left watched
    [ "$VOLUMES" -eq 1 ] || return 0
    [ "$APPLY" -eq 1 ] || return 0
    if [ -e "/Volumes/$VOL_NAME" ]; then
        printf 'removing volume %s (unmounting first)\n' "$VOL_NAME"
        /usr/sbin/diskutil unmount force "/Volumes/$VOL_NAME" >/dev/null 2>&1 || true
        /bin/rmdir "/Volumes/$VOL_NAME" 2>/dev/null || true
    fi
    # Delete by NAME: the mount path is gone once the volume is unmounted, and deleting by path
    # then fails silently. One volume per call, so loop until none is left.
    while [ "$n" -lt "$max" ]; do
        watched=$(/usr/sbin/diskutil apfs list 2>/dev/null | /usr/bin/grep -c "Name: *$VOL_NAME" || true)
        is_uint "${watched:-}" || watched=0
        [ "${watched:-0}" -gt 0 ] || break
        if ! /usr/sbin/diskutil apfs deleteVolume "$VOL_NAME" >/dev/null 2>&1; then
            printf 'ERROR: could not delete an APFS volume named %s\n' "$VOL_NAME" >&2
            EXIT=1
            break
        fi
        n=$((n + 1))
    done
    left=$(/usr/sbin/diskutil apfs list 2>/dev/null | /usr/bin/grep -c "Name: *$VOL_NAME" || true)
    is_uint "${left:-}" || left=0
    if [ "${left:-0}" -gt 0 ]; then
        printf 'ERROR: %s APFS volume(s) named %s still registered\n' "$left" "$VOL_NAME" >&2
        EXIT=1
    elif [ "$n" -gt 0 ]; then
        printf 'volume   : deleted %s APFS volume(s) named %s (verified: none left)\n' "$n" "$VOL_NAME"
    fi
}

delete_simulator_unavailable() {
    local listing
    # --auto is the path the driver runs after every build, and it is scoped to this project's
    # own artifacts: deleting simulator devices is a wider decision than that, so it stays with
    # an explicit manual run.
    if [ "$AUTO" -eq 1 ]; then
        log "simulator: skipped in --auto mode (run this script without --auto to prune simulators)"
        return 0
    fi
    # Only in apply mode: `simctl delete unavailable` is a state-changing CoreSimulator call.
    listing=$(/usr/bin/xcrun simctl list devices unavailable 2>/dev/null || true)
    if [ "$APPLY" -eq 1 ]; then
        if /usr/bin/xcrun simctl delete unavailable >/dev/null 2>&1; then
            printf 'simulator: deleted unavailable devices\n'
        else
            printf 'WARN simulator: simctl delete unavailable failed (CoreSimulator busy?)\n' >&2
        fi
    else
        case "$listing" in
            *'iPhone'* | *'iPad'*)
                log "simulator: unavailable devices present; --apply runs 'xcrun simctl delete unavailable'" ;;
            *)
                log "simulator: no unavailable devices reported" ;;
        esac
    fi
}

print_plan() {
    local i size_mb
    if [ "${#PLAN_PATH[@]}" -eq 0 ]; then
        log "plan     : nothing to remove"
        return 0
    fi
    log ""
    log "plan     : ${#PLAN_PATH[@]} item(s), $((PLAN_TOTAL_KB / 1024)) MB total"
    i=0
    while [ "$i" -lt "${#PLAN_PATH[@]}" ]; do
        size_mb=$((PLAN_SIZE[$i] / 1024))
        printf '  %7s MB  %-52s  %s\n' "$size_mb" "${PLAN_WHY[$i]}" "${PLAN_PATH[$i]}"
        i=$((i + 1))
    done
}

# --------------------------------------------------------------------------- main

main() {
    parse_args "$@"
    validate_environment

    log "cleanup-after-build.sh: $( if [ "$APPLY" -eq 1 ]; then printf 'APPLY (deleting)'; else printf 'DRY RUN (nothing is deleted)'; fi )"
    log "host     : $(/usr/bin/uname -n) ($(/usr/bin/uname -m)), user $(/usr/bin/id -un), mode $( if [ "$AUTO" -eq 1 ]; then printf 'auto'; else printf 'explicit'; fi )"

    FREE_BEFORE=$(free_gb /System/Volumes/Data)
    is_uint "${FREE_BEFORE:-}" || FREE_BEFORE=0
    log "free     : ${FREE_BEFORE} GB free on /System/Volumes/Data before"

    if [ "$AUTO" -eq 1 ]; then
        # What the driver's own run cleans: only its own leftovers and this project's output.
        plan_stage_leftovers
        plan_derived_data
        plan_volume_leftovers
    else
        plan_stage_leftovers
        plan_derived_data
        plan_caches
        plan_device_support
        plan_archives
        plan_volume_leftovers
    fi

    print_plan
    delete_simulator_unavailable

    if [ "$APPLY" -ne 1 ]; then
        log ""
        log "dry run  : nothing was deleted, nothing was changed (pass --apply to delete)"
        log "reclaim  : $((PLAN_TOTAL_KB / 1024)) MB in the plan"
        exit 0
    fi

    local i=0
    while [ "$i" -lt "${#PLAN_PATH[@]}" ]; do
        case "${PLAN_PATH[$i]}" in
            "/Volumes/$VOL_NAME") : ;;
            *) remove_one "${PLAN_PATH[$i]}" "${PLAN_WHY[$i]}" ;;
        esac
        i=$((i + 1))
    done
    # Clear the CocoaPods/npm caches through their own tools when asked: they also update their
    # bookkeeping, which a bare rm of the directory would leave inconsistent.
    if [ "$POD_CACHE" -eq 1 ] && command -v pod >/dev/null 2>&1; then
        pod cache clean --all >/dev/null 2>&1 || printf 'WARN cache: pod cache clean --all failed\n' >&2
    fi
    if [ "$NPM_CACHE" -eq 1 ] && command -v npm >/dev/null 2>&1; then
        npm cache clean --force >/dev/null 2>&1 || printf 'WARN cache: npm cache clean --force failed\n' >&2
    fi

    apply_volume

    # APFS returns deleted blocks lazily, so an immediate reading understates the reclaim.
    /bin/sleep 5
    FREE_AFTER=$(free_gb /System/Volumes/Data)
    is_uint "${FREE_AFTER:-}" || FREE_AFTER=0
    log ""
    log "free     : ${FREE_BEFORE} GB -> ${FREE_AFTER} GB free on /System/Volumes/Data (after)"
    if [ "$EXIT" -eq 0 ]; then
        log "done     : every planned item was removed"
    else
        printf 'done     : finished with failures (see the ERROR lines above)\n' >&2
    fi
    exit "$EXIT"
}

main "$@"
