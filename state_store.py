from __future__ import annotations

import os
import json
from copy import deepcopy
from datetime import datetime, timezone
from threading import Lock
from typing import TYPE_CHECKING, Any, Iterable

from constants import State

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
        self._journal_file = "journal.json"

        self._game_last_seen: dict[str, datetime] = {}

        self._runtime: dict[str, Any] = {
            "state": State.EXIT.name,
            "watching": None,
            "channels": [],
            "campaigns": [],
            "last_reload": None,
            "errors": [],
            "journal": self._load_journal(),
            "pending_switch": None,
            "started_at": self._isoformat(self._started_at),
            "sys_load": "0.00 0.00 0.00",
        }

    def _load_journal(self) -> list:
        if not os.path.exists(self._journal_file):
            return []
        try:
            with open(self._journal_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
                for entry in data:
                    if entry.get("type") == "claim":
                        self._known_claims.add(entry.get("msg"))
                return data
        except Exception:
            return []

    def _save_journal(self):
        try:
            with open(self._journal_file, 'w', encoding='utf-8') as f:
                json.dump(self._runtime["journal"], f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    def _add_journal_entry(self, type: str, msg: str, icon: str = None):
        entry = {
            "time": self._isoformat(datetime.now(timezone.utc)),
            "type": type,
            "msg": msg,
            "icon": icon
        }
        journal = self._runtime["journal"]
        journal.insert(0, entry)
        self._runtime["journal"] = journal[:100]
        self._save_journal()

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
        return {
            "id": channel.id,
            "login": channel._login,
            "display_name": channel.name,
            "status": status,
            "game": channel.game and channel.game.name,
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
        last_seen_dt = self._game_last_seen.get(campaign.game.name)
        return {
            "id": campaign.id,
            "name": campaign.name,
            "game": campaign.game.name,
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

            if current_login != self._last_watching_login:
                if current_login:
                    self._add_journal_entry("switch",
                                            f"Kanal gewechselt: {channel.name} ({channel.game.name if channel.game else '?'})",
                                            "fa-tv")
                else:
                    self._add_journal_entry("info", "Stream gestoppt / Suche...", "fa-pause")
                self._last_watching_login = current_login

            if channel and channel.game:
                self._game_last_seen[channel.game.name] = datetime.now(timezone.utc)

            self._runtime["watching"] = self._channel_payload(channel)

    def set_channels(self, channels: Iterable["Channel"]) -> None:
        with self._lock:
            self._runtime["channels"] = [self._channel_payload(ch) for ch in channels]

    def set_campaigns(self, campaigns: Iterable["DropsCampaign"]) -> None:
        with self._lock:
            payload_list = []
            for c in campaigns:
                payload_list.append(self._campaign_payload(c))

                if not self._first_campaign_load:
                    for d in c.drops:
                        claim_key = f"DROP ERHALTEN: {d.name} ({c.game.name})"
                        if d.is_claimed and claim_key not in self._known_claims:
                            self._add_journal_entry("claim", claim_key, "fa-gift")
                            self._known_claims.add(claim_key)
                        elif d.is_claimed:
                            self._known_claims.add(claim_key)
                else:
                    for d in c.drops:
                        claim_key = f"DROP ERHALTEN: {d.name} ({c.game.name})"
                        if d.is_claimed:
                            self._known_claims.add(claim_key)

            self._first_campaign_load = False
            self._runtime["campaigns"] = payload_list

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
            except:
                self._runtime["sys_load"] = "-"

            return deepcopy({"settings": self._settings, "runtime": self._runtime})

    def update_settings(self, settings: "Settings") -> None:
        with self._lock:
            self._settings = self._settings_payload(settings)