from __future__ import annotations

import logging
import os
import json
from copy import deepcopy
from datetime import datetime, timezone
from threading import Lock
from typing import TYPE_CHECKING, Any, Iterable

from constants import State, JOURNAL_PATH, CLAIMS_PATH

logger = logging.getLogger("TwitchDrops")

if TYPE_CHECKING:
    from channel import Channel
    from inventory import DropsCampaign, TimedDrop
    from settings import Settings


class StateStore:
    def __init__(self, settings: "Settings"):
        self._lock = Lock()
        self._settings = self._settings_payload(settings)
        self._started_at = datetime.now(timezone.utc)

        self._last_watching_login = None
        self._known_claims = set()
        self._first_campaign_load = True
        self._journal_file = JOURNAL_PATH
        self._claims_file = CLAIMS_PATH

        self._game_last_seen: dict[str, datetime] = {}
        self._claims: list[dict[str, Any]] = self._load_claims()
        self._migrate_journal_claims()

        self._watchdog_log: list = []

        self._runtime: dict[str, Any] = {
            "state": State.EXIT.name,
            "watching": None,
            "channels": [],
            "campaigns": [],
            "last_reload": self._isoformat(datetime.now(timezone.utc)),
            "errors": [],
            "journal": self._load_journal(),
            "pending_switch": None,
            "started_at": self._isoformat(self._started_at),
            "sys_load": "0.00 0.00 0.00",
        }
        self._add_journal_entry("info", "Service started", "fa-power-off")

    def _load_journal(self) -> list:
        if not os.path.exists(self._journal_file):
            return []
        try:
            with open(self._journal_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return []

    def _migrate_journal_claims(self):
        """Migrate existing claim entries from journal.json into claims.json (one-time)."""
        if not os.path.exists(self._journal_file):
            return
        known_ids = {e.get("drop_id") for e in self._claims if e.get("drop_id")}
        try:
            with open(self._journal_file, 'r', encoding='utf-8') as f:
                journal = json.load(f)
        except Exception:
            return
        migrated = 0
        for entry in reversed(journal):
            if entry.get("type") != "claim":
                continue
            drop_id = entry.get("drop_id")
            if drop_id and drop_id in known_ids:
                continue
            self._claims.append(entry)
            if drop_id:
                known_ids.add(drop_id)
                self._known_claims.add(f"claim:{drop_id}")
            migrated += 1
        if migrated:
            self._claims.sort(key=lambda e: e.get("time", ""), reverse=True)
            self._save_claims()

    def _load_claims(self) -> list[dict[str, Any]]:
        if not os.path.exists(self._claims_file):
            return []
        try:
            with open(self._claims_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
                for entry in data:
                    drop_id = entry.get("drop_id")
                    if drop_id:
                        self._known_claims.add(f"claim:{drop_id}")
                return data
        except Exception:
            return []

    def _save_claims(self):
        try:
            with open(self._claims_file, 'w', encoding='utf-8') as f:
                json.dump(self._claims, f, ensure_ascii=False, indent=2)
        except Exception:
            logger.warning("Failed to save claims file", exc_info=True)

    def _save_journal(self):
        try:
            with open(self._journal_file, 'w', encoding='utf-8') as f:
                json.dump(self._runtime["journal"], f, ensure_ascii=False, indent=2)
        except Exception:
            logger.warning("Failed to save journal file", exc_info=True)

    def _add_journal_entry(self, entry_type: str, msg: str, icon: str = None, **extra):
        entry = {
            "time": self._isoformat(datetime.now(timezone.utc)),
            "type": entry_type,
            "msg": msg,
            "icon": icon,
            **extra,
        }
        journal = self._runtime["journal"]
        journal.insert(0, entry)
        self._runtime["journal"] = journal[:100]
        self._save_journal()

    def _add_claim_entry(self, msg: str, **extra):
        entry = {
            "time": self._isoformat(datetime.now(timezone.utc)),
            "type": "claim",
            "msg": msg,
            "icon": "fa-gift",
            **extra,
        }
        self._claims.insert(0, entry)
        self._save_claims()
        # Also add to journal for the activity timeline
        self._add_journal_entry("claim", msg, "fa-gift", **extra)

    def _settings_payload(self, settings: "Settings") -> dict[str, Any]:
        return {
            "language": settings.language,
            "proxy": str(settings.proxy),
            "priority": list(settings.priority),
            "exclude": sorted(settings.exclude),
            "priority_mode": settings.priority_mode.name,
            "available_drops_check": settings.available_drops_check,
            "enable_badges_emotes": settings.enable_badges_emotes,
            "connection_quality": settings.connection_quality,
            "tray_notifications": settings.tray_notifications,
            "autostart_tray": settings.autostart_tray,
        }

    @staticmethod
    def _isoformat(dt: datetime | None) -> str | None:
        return dt.astimezone(timezone.utc).isoformat() if dt is not None else None

    @staticmethod
    def _channel_payload(channel: "Channel" | None) -> dict[str, Any] | None:
        if channel is None: return None
        status = "online" if channel.online else ("pending_online" if channel.pending_online else "offline")
        game_name = channel.game.name if (channel.game and hasattr(channel.game, 'name')) else "?"
        return {
            "id": channel.id,
            "login": channel._login,
            "display_name": channel.name,
            "status": status,
            "game": game_name,
            "viewers": channel.viewers,
            "drops_enabled": channel.drops_enabled,
        }

    @classmethod
    def _drop_payload(cls, drop: "TimedDrop") -> dict[str, Any]:
        return {
            "id": drop.id,
            "name": drop.name,
            "progress": drop.progress,
            "claimed": drop.is_claimed,
            "can_claim": drop.can_claim,
            "current_minutes": drop.current_minutes,
            "required_minutes": drop.required_minutes,
            "starts_at": cls._isoformat(drop.starts_at),
            "ends_at": cls._isoformat(drop.ends_at),
        }

    def _campaign_payload(self, campaign: "DropsCampaign") -> dict[str, Any]:
        g_name = campaign.game.name if campaign.game else "Unknown"
        last_seen_dt = self._game_last_seen.get(g_name)
        return {
            "id": campaign.id,
            "name": campaign.name,
            "game": g_name,
            "eligible": campaign.eligible,
            "active": campaign.active,
            "upcoming": campaign.upcoming,
            "progress": campaign.progress,
            "claimed_drops": campaign.claimed_drops,
            "total_drops": campaign.total_drops,
            "starts_at": self._isoformat(campaign.starts_at),
            "ends_at": self._isoformat(campaign.ends_at),
            "last_seen": self._isoformat(last_seen_dt),
            "drops": [self._drop_payload(drop) for drop in campaign.drops],
        }

    def set_state(self, state: State) -> None:
        with self._lock:
            self._runtime["state"] = state.name

    def set_watching(self, channel: "Channel" | None) -> None:
        with self._lock:
            current_login = channel._login if channel else None

            # Safe Game Name extraction
            game_name = "?"
            if channel and channel.game:
                game_name = channel.game.name
                self._game_last_seen[game_name] = datetime.now(timezone.utc)

            if current_login != self._last_watching_login:
                if current_login:
                    self._add_journal_entry("switch", f"Switched to: {channel.name} ({game_name})", "fa-tv")
                else:
                    self._add_journal_entry("info", "Stream stopped / searching...", "fa-pause")
                self._last_watching_login = current_login

            self._runtime["watching"] = self._channel_payload(channel)

    def set_channels(self, channels: Iterable["Channel"]) -> None:
        with self._lock:
            self._runtime["channels"] = [self._channel_payload(ch) for ch in channels]

    def set_campaigns(self, campaigns: Iterable["DropsCampaign"]) -> None:
        with self._lock:
            payload_list = []
            for c in campaigns:
                try:
                    payload_list.append(self._campaign_payload(c))

                    if not self._first_campaign_load:
                        g_name = c.game.name if c.game else "?"
                        for d in c.drops:
                            claim_key = f"claim:{d.id}"
                            if d.is_claimed and claim_key not in self._known_claims:
                                msg = f"Drop claimed: {d.name} ({g_name})"
                                self._add_claim_entry(msg, drop_id=d.id)
                                self._known_claims.add(claim_key)
                            elif d.is_claimed:
                                self._known_claims.add(claim_key)
                    else:
                        for d in c.drops:
                            if d.is_claimed:
                                self._known_claims.add(f"claim:{d.id}")
                except Exception:
                    logger.warning("Failed to build campaign payload", exc_info=True)
                    continue

            self._first_campaign_load = False
            self._runtime["campaigns"] = payload_list

    def update_drop_progress(self, drop_id: str, current_minutes: int, required_minutes: int) -> None:
        with self._lock:
            for campaign in self._runtime.get("campaigns", []):
                for drop in campaign.get("drops", []):
                    if drop["id"] == drop_id:
                        drop["current_minutes"] = current_minutes
                        drop["required_minutes"] = required_minutes
                        drop["progress"] = current_minutes / required_minutes if required_minutes > 0 else 0.0
                        return

    def set_last_reload(self, when: datetime | None = None) -> None:
        with self._lock:
            self._runtime["last_reload"] = self._isoformat(when or datetime.now(timezone.utc))

    def set_pending_switch(self, requested: Any) -> None:
        with self._lock:
            self._runtime["pending_switch"] = requested

    def record_error(self, message: str) -> None:
        with self._lock:
            self._add_journal_entry("error", message, "fa-exclamation-triangle")
            errors: list[str] = self._runtime["errors"]
            errors.append(message)
            self._runtime["errors"] = errors[-10:]

    def record_watchdog(
        self,
        *,
        state: str,
        idle_min: float | None,
        threshold_min: float,
        consecutive: int,
        action: str,
    ) -> None:
        with self._lock:
            entry = {
                "time": self._isoformat(datetime.now(timezone.utc)),
                "state": state,
                "idle_min": idle_min,
                "threshold_min": threshold_min,
                "consecutive": consecutive,
                "action": action,
            }
            self._watchdog_log.insert(0, entry)
            self._watchdog_log = self._watchdog_log[:20]

    def get_watchdog_log(self) -> list:
        with self._lock:
            return list(self._watchdog_log)

    def record_restart_attempt(self, message: str) -> None:
        with self._lock:
            self._add_journal_entry("restart", message, "fa-redo")

    def get_snapshot(self) -> dict[str, Any]:
        with self._lock:
            if "started_at" not in self._runtime:
                self._runtime["started_at"] = self._isoformat(self._started_at)
            try:
                if hasattr(os, "getloadavg"):
                    av = os.getloadavg()
                    self._runtime["sys_load"] = f"{av[0]:.2f} {av[1]:.2f} {av[2]:.2f}"
                else:
                    self._runtime["sys_load"] = "Win/NA"
            except Exception:
                self._runtime["sys_load"] = "-"

            snapshot = deepcopy({"settings": self._settings, "runtime": self._runtime})
            snapshot["runtime"]["claims"] = deepcopy(self._claims)
            return snapshot

    def clear_journal(self) -> None:
        with self._lock:
            self._runtime["journal"] = []
            self._save_journal()

    def update_settings(self, settings: "Settings") -> None:
        with self._lock:
            self._settings = self._settings_payload(settings)