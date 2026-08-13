#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/home/jan/TwitchDropsMiner"
VENV_DIR="${REPO_DIR}/.env"
SERVICE_NAME="tdm.service"
HEALTH_URL="http://localhost:8080/api/health"
LOCK_FILE="/tmp/tdm-rollout.lock"
LOG_PREFIX="TDM-ROLLOUT:"
HEALTH_ATTEMPTS=12
HEALTH_INTERVAL_SECONDS=10

log() {
    echo "${LOG_PREFIX} $*"
}

# Restarts tdm.service and polls the health endpoint. Returns 0 once the
# unit is active AND the endpoint reports ok, 1 if it never does within
# HEALTH_ATTEMPTS tries.
restart_and_check_health() {
    sudo systemctl restart "$SERVICE_NAME"

    local i
    for ((i = 1; i <= HEALTH_ATTEMPTS; i++)); do
        sleep "$HEALTH_INTERVAL_SECONDS"
        systemctl is-active --quiet "$SERVICE_NAME" || continue
        curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null | grep -q '"status": "ok"' && return 0
    done
    return 1
}

# Reverts the checkout to $1, restarts the service and reports the
# outcome under the ROLLBACK marker. Never recurses into another
# rollback attempt: if the previous version is also unhealthy, that is
# a distinct, louder failure meant to trip whatever alerting watches
# this unit, not something to retry silently here.
rollback_to() {
    local target="$1"
    log "rolling back to ${target}"

    # A failed reset here would otherwise fall through silently (under
    # set -e it would kill the whole script with no ROLLBACK line at
    # all) -- make the failure loud and stop instead of restarting a
    # service against a checkout that may be in an inconsistent state.
    if ! git reset --hard "$target"; then
        echo "TDM-ROLLOUT ROLLBACK: FAILED, git reset to ${target} failed"
        exit 1
    fi

    # Deliberately not reverting pip packages here: a requirements
    # downgrade is pip dependency-resolution roulette, while the old
    # code almost always tolerates newer deps that are already
    # installed. If it doesn't, that surfaces as its own loud failure
    # below instead of being masked by a downgrade attempt.
    if restart_and_check_health; then
        echo "TDM-ROLLOUT ROLLBACK: succeeded, service healthy on ${target}"
    else
        echo "TDM-ROLLOUT ROLLBACK: FAILED, service unhealthy even on previous version ${target}"
    fi
}

# Everything below runs inside main() rather than at top level: further
# down, `git reset --hard origin/master` rewrites this very file mid-run
# whenever the rollout updates the script itself. Bash reads top-level
# statements from the script file as it goes, so a rewrite partway
# through would cut the run short -- observed as a silent exit 0 with
# the rest of the rollout never happening. A function body is read into
# memory in full before it starts executing, so the on-disk rewrite
# can't truncate it.
main() {
    # Non-blocking: a run already in progress (e.g. still inside its own
    # 12-attempt health-check loop) means this pass should skip rather than
    # pile up concurrent rollouts.
    exec 200>"$LOCK_FILE"
    if ! flock -n 200; then
        log "another rollout is already running, skipping this pass"
        exit 0
    fi

    cd "$REPO_DIR"

    # Untracked runtime files (claims.json, journal.json, cookies.jar,
    # *.bak-*) are left alone by `reset --hard` and excluded here; only
    # *tracked* changes indicate a hand-edit on the Pi that must never be
    # discarded silently.
    if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
        log "manual edits on the Pi, refusing to roll out"
        exit 1
    fi

    # A dead network (or a boot-time run racing DHCP/DNS, given
    # Persistent=true) must not be treated as a script failure -- there
    # is simply nothing to roll out to yet.
    if ! git fetch origin; then
        log "fetch failed, skipping"
        exit 0
    fi

    CURRENT_HEAD="$(git rev-parse HEAD)"
    REMOTE_HEAD="$(git rev-parse origin/master)"

    if [[ "$CURRENT_HEAD" == "$REMOTE_HEAD" ]]; then
        log "up to date (${CURRENT_HEAD})"
        exit 0
    fi

    PREV="$CURRENT_HEAD"
    # Movable ref to the pre-rollout commit, for manual inspection/recovery
    # only -- nothing in this script reads it back automatically.
    git branch -f rollback-previous "$PREV"

    log "rolling out ${PREV} -> ${REMOTE_HEAD}"
    git reset --hard origin/master

    if ! git diff --quiet "$PREV" "$REMOTE_HEAD" -- requirements.txt; then
        log "requirements.txt changed, installing dependencies"
        if ! "${VENV_DIR}/bin/python3" -m pip install -r requirements.txt; then
            log "pip install failed"
            rollback_to "$PREV"
            exit 1
        fi
    fi

    if restart_and_check_health; then
        log "updated ${PREV}->${REMOTE_HEAD}"
        exit 0
    fi

    log "health check failed after update"
    rollback_to "$PREV"
    exit 1
}

main "$@"
