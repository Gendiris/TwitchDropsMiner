# TwitchDropsMiner Pi Auto-Rollout

Keeps the Pi Zero's copy of TwitchDropsMiner in sync with `origin/master`
without manual SSH: a systemd timer periodically runs `tdm-rollout.sh`,
which fetches, fast-forwards the checkout, reinstalls dependencies if
`requirements.txt` changed, restarts `tdm.service`, and rolls back
automatically if the health endpoint doesn't come back healthy.

## Files

- `tdm-rollout.sh` -- the rollout logic (fetch, `reset --hard`, pip
  install if needed, restart, health-check, rollback on failure).
- `tdm-rollout.service` -- oneshot unit that runs the script as `jan`.
- `tdm-rollout.timer` -- triggers the service every 30 minutes.

## Install (on the Pi, once)

```bash
sudo cp /home/jan/TwitchDropsMiner/deploy/tdm-rollout.service /etc/systemd/system/
sudo cp /home/jan/TwitchDropsMiner/deploy/tdm-rollout.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tdm-rollout.timer
```

Plain `cp`, not a symlink: systemd is picky about following symlinks
into a repo checkout for unit files. A copy also means the timer/service
definitions on the Pi survive a `git reset --hard` of the repo -- it
just won't pick up future edits to `deploy/*.service` / `deploy/*.timer`
automatically; re-run the two `cp` lines (and `daemon-reload`) after
changing either unit file.

## Status / logs

```bash
journalctl -u tdm-rollout.service -n 50 --no-pager   # last run's output
journalctl -u tdm-rollout.service -f                  # follow live
systemctl list-timers tdm-rollout.timer                # next scheduled run
```

Every log line is prefixed `TDM-ROLLOUT:`. A rollback (health check
failed after an update) logs a `TDM-ROLLOUT ROLLBACK: ...` line and the
run exits non-zero, so a failed rollout is visible both via
`journalctl -p err -u tdm-rollout.service` and via
`systemctl status tdm-rollout.service` ("Main PID exited, status=1").

## Disable

```bash
sudo systemctl disable --now tdm-rollout.timer
```

## Design notes

- Won't touch a dirty working tree: if `git status --porcelain` shows
  *tracked* changes, the script refuses to roll out instead of
  discarding manual edits. Untracked runtime files (`claims.json`,
  `journal.json`, `cookies.jar`, `*.bak-*`) are explicitly excluded from
  that check and are left alone by `git reset --hard` anyway.
- On health-check failure after an update, the script rolls back the
  git checkout but deliberately does **not** revert
  `requirements.txt` / pip packages -- a pip downgrade is its own
  source of breakage, and the old code almost always runs fine against
  newer dependencies already installed. If it doesn't, that fails
  loudly on its own rather than being masked by a downgrade attempt.
- No rollback-of-a-rollback: if the previous version is also unhealthy
  after a rollback, the script reports `TDM-ROLLOUT ROLLBACK: FAILED`
  and stops -- that's meant to surface as a loud, distinct incident
  rather than looping.
- A non-blocking `flock` guard (`/tmp/tdm-rollout.lock`) means an
  overlapping run (e.g. the previous run is still inside its own
  12-attempt health-check loop) is skipped rather than piling up.
- `rollback-previous` is a movable branch ref the script sets to the
  commit the Pi was on before each rollout, for manual
  inspection/recovery only -- nothing reads it back automatically.
- The service invokes the script via `/bin/bash <path>`, not by
  executing the file directly, so the script's executable bit doesn't
  matter (files written from a Windows checkout / git often lose it).
