from __future__ import annotations

import asyncio
import logging
import signal
import sys
import traceback
from typing import TYPE_CHECKING, Any

from translate import _
from exceptions import CaptchaRequired
from constants import State
from state_store import StateStore

if TYPE_CHECKING:
    from channel import Channel
    from settings import Settings
    from twitch import Twitch


logger = logging.getLogger("TwitchDrops")


class MinerService:
    """
    Centralized controller for the miner lifecycle.

    Provides a narrow API that can be used by the GUI or other callers to
    control the miner without directly coupling to the core Twitch logic.
    """

    def __init__(self, settings: Settings):
        self.settings: Settings = settings
        self._state_store = StateStore(settings)
        self._twitch: Twitch | None = None
        self._task: asyncio.Task[int] | None = None
        self._requested_channel: int | str | None = None
        self._exit_status: int = 0

    @property
    def twitch(self) -> Twitch | None:
        return self._twitch

    @property
    def gui(self):
        if self._twitch is None:
            return None
        return self._twitch.gui

    def _ensure_twitch(self) -> Twitch:
        if self._twitch is None:
            from twitch import Twitch

            self._twitch = Twitch(
                self.settings,
                service=self,
                state_store=self._state_store,
            )
        return self._twitch

    async def start(self) -> int:
        """
        Start the miner lifecycle and return the resulting exit status.
        """
        if self._task is None or self._task.done():
            twitch = self._ensure_twitch()
            self._task = asyncio.create_task(self._run(twitch))
        return await self._task

    async def stop(self) -> None:
        twitch = self._twitch
        if twitch is None:
            return
        twitch.close()
        if self._task is not None:
            await asyncio.shield(self._task)

    def request_stop(self) -> None:
        twitch = self._twitch
        if twitch is None:
            return
        twitch.close()

    def reload_state(self) -> None:
        twitch = self._ensure_twitch()
        twitch.change_state(State.INVENTORY_FETCH)

    def switch_channel(self, channel_ref: int | str | None = None) -> None:
        """
        Request a switch to a specific channel.

        channel_ref can be:
        - Channel ID (int)
        - Channel login (str)
        - None to let the selector logic decide
        """
        self._requested_channel = channel_ref
        self._state_store.set_pending_switch(channel_ref)
        self._ensure_twitch().change_state(State.CHANNEL_SWITCH)

    def consume_switch_request(self) -> Channel | None:
        twitch = self._twitch
        if twitch is None:
            return None
        if self._requested_channel is None:
            return None
        request = self._requested_channel
        self._requested_channel = None
        self._state_store.set_pending_switch(None)
        channels = twitch.channels
        if isinstance(request, int):
            return channels.get(request)
        if isinstance(request, str):
            for channel in channels.values():
                if channel._login == request or channel._display_name == request:
                    return channel
        return None

    def get_snapshot(self) -> dict[str, Any]:
        self._state_store.update_settings(self.settings)
        return self._state_store.get_snapshot()

    async def _run(self, client: Twitch) -> int:
        self._exit_status = 0
        loop = asyncio.get_running_loop()
        if sys.platform == "linux":
            loop.add_signal_handler(signal.SIGINT, lambda *_: client.gui.close())
            loop.add_signal_handler(signal.SIGTERM, lambda *_: client.gui.close())
        try:
            await client.run()
        except CaptchaRequired:
            self._exit_status = 1
            self._state_store.record_error("Captcha required")
            client.prevent_close()
            client.print(_("error", "captcha"))
        except Exception:
            self._exit_status = 1
            self._state_store.record_error("Fatal error encountered")
            client.prevent_close()
            client.print("Fatal error encountered:\n")
            client.print(traceback.format_exc())
        finally:
            if sys.platform == "linux":
                loop.remove_signal_handler(signal.SIGINT)
                loop.remove_signal_handler(signal.SIGTERM)
            client.print(_("gui", "status", "exiting"))
            await client.shutdown()
        if client.gui and not client.gui.close_requested:
            client.gui.tray.change_icon("error")
            client.print(_("status", "terminated"))
            client.gui.status.update(_("gui", "status", "terminated"))
            client.gui.grab_attention(sound=True)
        await client.gui.wait_until_closed()
        client.save(force=True)
        client.gui.stop()
        client.gui.close_window()
        return self._exit_status
