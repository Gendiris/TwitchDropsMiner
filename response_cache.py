from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from utils import json_load, json_save


class ResponseCache:
    """
    Timestamped cache for JSON-serialisable responses.

    Stores payloads on disk with their fetch time to avoid repeating
    expensive operations between runs while still respecting a TTL.
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self._entries: dict[str, dict[str, Any]] = json_load(path, {}, merge=False)
        except json.JSONDecodeError:
            # Corrupt cache file – start clean to avoid hard failures.
            self._entries = {}

    def get(self, key: str, *, max_age: timedelta) -> tuple[Any, datetime] | None:
        """
        Return a cached payload if it is not older than max_age.
        """
        entry = self._entries.get(key)
        if entry is None:
            return None
        fetched_at_str = entry.get("fetched_at")
        payload = entry.get("data")
        if fetched_at_str is None or payload is None:
            return None
        try:
            fetched_at = datetime.fromisoformat(fetched_at_str)
        except ValueError:
            return None
        if fetched_at.tzinfo is None:
            fetched_at = fetched_at.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) - fetched_at > max_age:
            return None
        return payload, fetched_at

    def set(self, key: str, payload: Any) -> datetime:
        """
        Persist a payload and return the timestamp used for the write.
        """
        fetched_at = datetime.now(timezone.utc)
        self._entries[key] = {
            "fetched_at": fetched_at.isoformat(),
            "data": payload,
        }
        json_save(self._path, self._entries, sort=True)
        return fetched_at

    def clear(self, key: str | None = None) -> None:
        """
        Clear either a single key or the entire cache.
        """
        if key is None:
            self._entries.clear()
        else:
            self._entries.pop(key, None)
        json_save(self._path, self._entries, sort=True)
