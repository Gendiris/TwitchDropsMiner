from __future__ import annotations

import base64
import logging
import os
from pathlib import Path
from typing import Any

import aiohttp
from aiohttp import web

from constants import PriorityMode
from utils import resource_path

logger = logging.getLogger("TwitchDrops.api")


def _parse_bind(bind: str) -> tuple[str, int]:
    host, _, port = bind.rpartition(":")
    if not host or not port:
        raise ValueError("Bind address must be in the form host:port")
    return host, int(port)


class WebAPI:
    def __init__(
        self,
        service,
        *,
        token: str | None = None,
        basic_user: str | None = None,
        basic_password: str | None = None,
    ) -> None:
        from miner_service import MinerService

        self._service: MinerService = service
        self._app = web.Application(middlewares=[self._auth_middleware])
        self._app.add_routes(
            [
                web.get("/api/health", self._health),
                web.get("/api/snapshot", self._snapshot),
                web.get("/api/settings", self._settings_get),
                web.put("/api/settings", self._settings_put),
                web.post("/api/actions/reload", self._action_reload),
                web.post("/api/actions/start", self._action_start),
                web.post("/api/actions/stop", self._action_stop),
                web.post("/api/actions/switch-channel", self._action_switch_channel),
            ]
        )
        self._webui_path = resource_path("webui")
        self._register_webui()
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._token = token
        self._basic_user = basic_user
        self._basic_password = basic_password
        self._auth_required = any((token, basic_user, basic_password))

    async def start(self, bind: str) -> None:
        host, port = _parse_bind(bind)
        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, host, port)
        await self._site.start()
        logger.info(f"Web API running on http://{host}:{port}")

    async def stop(self) -> None:
        if self._site is not None:
            await self._site.stop()
            self._site = None
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None

    @web.middleware
    async def _auth_middleware(self, request: web.Request, handler):
        if not self._auth_required:
            return await handler(request)

        if self._token and self._token == _extract_token(request):
            return await handler(request)

        if self._basic_user and self._basic_password and _validate_basic_auth(
            request, self._basic_user, self._basic_password
        ):
            return await handler(request)

        return web.Response(status=401, headers={"WWW-Authenticate": 'Basic realm="TwitchDrops"'})

    async def _health(self, _: web.Request) -> web.Response:
        return web.json_response({"status": "ok", "running": self._service.is_running})

    async def _snapshot(self, _: web.Request) -> web.Response:
        return web.json_response(self._service.get_snapshot())

    async def _settings_get(self, _: web.Request) -> web.Response:
        return web.json_response(self._service.get_snapshot().get("settings", {}))

    async def _settings_put(self, request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except aiohttp.ContentTypeError:
            return web.json_response({"error": "Invalid JSON"}, status=400)
        if not isinstance(payload, dict):
            return web.json_response({"error": "Payload must be an object"}, status=400)
        updated, errors = _apply_settings(self._service.settings, payload)
        if errors:
            return web.json_response({"error": errors}, status=400)
        if updated:
            self._service.settings.save()
            self._service.state_store.update_settings(self._service.settings)
        return web.json_response(self._service.get_snapshot().get("settings", {}))

    async def _action_reload(self, _: web.Request) -> web.Response:
        self._service.reload_state()
        self._service.state_store.set_last_reload()
        return web.json_response({"status": "queued"})

    async def _action_start(self, _: web.Request) -> web.Response:
        was_started = self._service.ensure_started()
        status = "started" if was_started else "already_running"
        return web.json_response({"status": status})

    async def _action_stop(self, _: web.Request) -> web.Response:
        await self._service.stop()
        return web.json_response({"status": "stopped"})

    async def _action_switch_channel(self, request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except aiohttp.ContentTypeError:
            return web.json_response({"error": "Invalid JSON"}, status=400)
        channel = payload.get("channel") if isinstance(payload, dict) else None
        if channel is not None and not isinstance(channel, (int, str)):
            return web.json_response({"error": "Channel must be int, str, or null"}, status=400)
        self._service.switch_channel(channel)
        return web.json_response({"status": "queued", "channel": channel})

    def _register_webui(self) -> None:
        webui_dir = Path(self._webui_path)
        if not webui_dir.exists():
            return
        self._app.router.add_get("/", self._serve_index)
        self._app.router.add_static("/webui", webui_dir)

    async def _serve_index(self, _: web.Request) -> web.StreamResponse:
        index_path = Path(self._webui_path, "index.html")
        if not index_path.exists():
            return web.Response(status=404, text="Web UI is not available.")
        return web.FileResponse(index_path)


def _extract_token(request: web.Request) -> str | None:
    auth = request.headers.get("Authorization")
    if not auth:
        return request.headers.get("X-Api-Token")
    if auth.startswith("Bearer "):
        return auth.removeprefix("Bearer ").strip()
    if auth.startswith("Token "):
        return auth.removeprefix("Token ").strip()
    return None


def _validate_basic_auth(request: web.Request, username: str, password: str) -> bool:
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Basic "):
        return False
    try:
        decoded = base64.b64decode(auth_header.removeprefix("Basic ").strip()).decode()
    except (ValueError, UnicodeDecodeError):
        return False
    try:
        user, pwd = decoded.split(":", 1)
    except ValueError:
        return False
    return user == username and pwd == password


def _apply_settings(settings: Any, payload: dict[str, Any]) -> tuple[bool, list[str]]:
    errors: list[str] = []
    updated = False
    for key, value in payload.items():
        try:
            if key == "language" and isinstance(value, str):
                settings.language = value
                updated = True
            elif key == "proxy" and isinstance(value, str):
                from yarl import URL

                settings.proxy = URL(value)
                updated = True
            elif key == "priority" and isinstance(value, list):
                settings.priority = [str(item) for item in value]
                updated = True
            elif key == "exclude" and isinstance(value, list):
                settings.exclude = set(str(item) for item in value)
                updated = True
            elif key == "priority_mode" and isinstance(value, str):
                settings.priority_mode = PriorityMode[value]
                updated = True
            elif key == "available_drops_check" and isinstance(value, bool):
                settings.available_drops_check = value
                updated = True
            elif key == "enable_badges_emotes" and isinstance(value, bool):
                settings.enable_badges_emotes = value
                updated = True
            elif key == "connection_quality" and isinstance(value, int):
                settings.connection_quality = value
                updated = True
            elif key == "tray_notifications" and isinstance(value, bool):
                settings.tray_notifications = value
                updated = True
            elif key == "autostart_tray" and isinstance(value, bool):
                settings.autostart_tray = value
                updated = True
            else:
                errors.append(f"Unsupported or invalid field: {key}")
        except Exception as exc:  # pragma: no cover - defensive
            errors.append(f"{key}: {exc}")
    return updated, errors


def build_api(service) -> WebAPI | None:
    bind = getattr(service.settings, "bind", None)
    if not bind:
        return None
    token = os.getenv("API_TOKEN")
    basic_user = os.getenv("API_BASIC_USER")
    basic_password = os.getenv("API_BASIC_PASSWORD")
    return WebAPI(
        service,
        token=token,
        basic_user=basic_user,
        basic_password=basic_password,
    )
