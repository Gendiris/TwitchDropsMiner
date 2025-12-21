from __future__ import annotations

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
        self._runtime: dict[str, Any] = {
            "state": State.EXIT.name,
            "watching": None,
            "channels": [],
            "campaigns": [],
            "last_reload": None,
            "errors": [],
            "pending_switch": None,
        }

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
        if channel is None:
            return None
        status = "offline"
        if channel.online:
            status = "online"
        elif channel.pending_online:
            status = "pending_online"
        return {
            "id": channel.id,
            "login": channel._login,
            "display_name": channel.name,
            "status": status,
            "game": channel.game and channel.game.name,
            "viewers": channel.viewers,
            "drops_enabled": channel.drops_enabled,
            "acl_based": channel.acl_based,
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

    @classmethod
    def _campaign_payload(cls, campaign: "DropsCampaign") -> dict[str, Any]:
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
            "starts_at": cls._isoformat(campaign.starts_at),
            "ends_at": cls._isoformat(campaign.ends_at),
            "drops": [cls._drop_payload(drop) for drop in campaign.drops],
        }

    def update_settings(self, settings: "Settings") -> None:
        with self._lock:
            self._settings = self._settings_payload(settings)

    def set_state(self, state: State) -> None:
        with self._lock:
            self._runtime["state"] = state.name

    def set_watching(self, channel: "Channel" | None) -> None:
        with self._lock:
            self._runtime["watching"] = self._channel_payload(channel)

    def set_channels(self, channels: Iterable["Channel"]) -> None:
        with self._lock:
            self._runtime["channels"] = [self._channel_payload(ch) for ch in channels]

    def set_campaigns(self, campaigns: Iterable["DropsCampaign"]) -> None:
        with self._lock:
            self._runtime["campaigns"] = [self._campaign_payload(c) for c in campaigns]

    def set_last_reload(self, when: datetime | None = None) -> None:
        with self._lock:
            self._runtime["last_reload"] = self._isoformat(when or datetime.now(timezone.utc))

    def set_pending_switch(self, requested: Any) -> None:
        with self._lock:
            self._runtime["pending_switch"] = requested

    def record_error(self, message: str) -> None:
        with self._lock:
            errors: list[str] = self._runtime["errors"]
            errors.append(message)
            self._runtime["errors"] = errors[-10:]

    def get_snapshot(self) -> dict[str, Any]:
        with self._lock:
            return deepcopy({"settings": self._settings, "runtime": self._runtime})
