from __future__ import annotations

import asyncio
import logging
import sys
from typing import TYPE_CHECKING, Any

from translate import _
from exceptions import ExitRequest
from constants import OUTPUT_FORMATTER

if TYPE_CHECKING:
    from channel import Channel
    from inventory import DropsCampaign, TimedDrop
    from miner_service import MinerService
    from twitch import Twitch


logger = logging.getLogger("TwitchDrops")


class _HeadlessTray:
    def __init__(self, manager: "HeadlessGUI") -> None:
        self._manager = manager

    def change_icon(self, *_: Any, **__: Any) -> None:
        # GUI icon changes are irrelevant in headless mode
        return

    def notify(self, message: str, title: str | None = None) -> None:
        if title:
            logger.info(f"{title}: {message}")
        else:
            logger.info(message)

    def stop(self) -> None:
        return


class _HeadlessStatus:
    def __init__(self, manager: "HeadlessGUI") -> None:
        self._manager = manager

    def update(self, message: str) -> None:
        logger.info(message)


class _HeadlessChannels:
    def __init__(self, manager: "HeadlessGUI") -> None:
        self._manager = manager
        self._selection: Channel | None = None

    def clear(self) -> None:
        self._selection = None

    def clear_watching(self) -> None:
        return

    def clear_selection(self) -> None:
        self._selection = None

    def set_watching(self, channel: Channel | None) -> None:
        self._selection = channel
        if channel is not None:
            logger.info(_("status", "watching").format(channel=channel.name))

    def get_selection(self) -> Channel | None:
        return self._selection

    def display(self, channel: Channel, *, add: bool = True) -> None:
        if add:
            logger.debug(f"Tracking channel: {channel.name}")

    def remove(self, channel: Channel) -> None:
        if self._selection is channel:
            self._selection = None


class _HeadlessInventory:
    def __init__(self, manager: "HeadlessGUI") -> None:
        self._manager = manager

    def clear(self) -> None:
        return

    async def add_campaign(self, campaign: DropsCampaign) -> None:
        logger.info(f"Added campaign: {campaign.game.name}")

    def update_drop(self, drop: TimedDrop) -> None:
        logger.debug(f"Drop updated: {drop}")


class _HeadlessProgress:
    def __init__(self, manager: "HeadlessGUI") -> None:
        self._manager = manager

    def start_timer(self) -> None:
        return

    def stop_timer(self) -> None:
        return

    def display(self, *_: Any, **__: Any) -> None:
        return

    def minute_almost_done(self) -> bool:
        return False


class _HeadlessWebsockets:
    def __init__(self, manager: "HeadlessGUI") -> None:
        self._manager = manager

    def update(self, *_: Any, **__: Any) -> None:
        return

    def remove(self, *_: Any, **__: Any) -> None:
        return


class _HeadlessLogin:
    def __init__(self, manager: "HeadlessGUI") -> None:
        self._manager = manager

    def clear(self, *_: Any, **__: Any) -> None:
        return

    async def wait_for_login_press(self) -> None:
        return

    async def ask_login(self):
        def _prompt():
            print(_("gui", "login", "request"))
            username = input("Username: ").strip()
            password = input("Password: ")
            token = input("2FA token (optional): ").strip()
            return type(
                "LoginData",
                (),
                {"username": username, "password": password, "token": token},
            )

        return await asyncio.to_thread(_prompt)

    async def ask_enter_code(self, page_url, user_code: str) -> None:
        logger.info(f"Open {page_url} and enter code: {user_code}")

    def update(self, status: str, user_id: int | None) -> None:
        logger.info(f"{status} ({user_id or '-'})")


class HeadlessGUI:
    def __init__(self, twitch: "Twitch", *, service: "MinerService | None" = None) -> None:
        self._twitch = twitch
        self._service: MinerService | None = service or getattr(twitch, "_service", None)
        self._close_requested = asyncio.Event()
        self.tray = _HeadlessTray(self)
        self.status = _HeadlessStatus(self)
        self.channels = _HeadlessChannels(self)
        self.inv = _HeadlessInventory(self)
        self.progress = _HeadlessProgress(self)
        self.websockets = _HeadlessWebsockets(self)
        self.login = _HeadlessLogin(self)
        self._handler: logging.Handler | None = None
        if not logging.getLogger("TwitchDrops").handlers:
            handler = logging.StreamHandler(sys.stdout)
            handler.setFormatter(OUTPUT_FORMATTER)
            logging.getLogger("TwitchDrops").addHandler(handler)
            self._handler = handler

    @property
    def service(self) -> "MinerService":
        assert self._service is not None
        return self._service

    @property
    def close_requested(self) -> bool:
        return self._close_requested.is_set()

    def prevent_close(self) -> None:
        self._close_requested.clear()

    def start(self) -> None:
        logger.debug("Starting in headless mode")

    def stop(self) -> None:
        self.progress.stop_timer()

    def close(self, *args: Any) -> int:
        self._close_requested.set()
        self.service.request_stop()
        return 0

    def close_window(self) -> None:
        self.tray.stop()
        if self._handler is not None:
            logging.getLogger("TwitchDrops").removeHandler(self._handler)

    def save(self, *, force: bool = False) -> None:
        return

    def grab_attention(self, *, sound: bool = True) -> None:
        return

    def print(self, message: str) -> None:
        logger.info(message)

    async def wait_until_closed(self):
        return

    async def coro_unless_closed(self, coro):
        if self._close_requested.is_set():
            raise ExitRequest()
        return await coro

    def display_drop(self, drop: TimedDrop, *, countdown: bool = True, subone: bool = False):
        logger.info(drop.rewards_text())
