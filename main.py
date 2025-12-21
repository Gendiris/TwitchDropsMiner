from __future__ import annotations

# import an additional thing for proper PyInstaller freeze support
from multiprocessing import freeze_support


if __name__ == "__main__":
    freeze_support()
    import asyncio
    import logging
    import io
    import sys
    import argparse
    import traceback
    import warnings
    from pathlib import Path
    from typing import NoReturn, TYPE_CHECKING

    import truststore
    truststore.inject_into_ssl()

    from translate import _
    from settings import Settings
    from version import __version__
    from miner_service import MinerService
    from utils import lock_file, resource_path, set_root_icon
    from constants import (
        LOGGING_LEVELS,
        SELF_PATH,
        FILE_FORMATTER,
        LOG_PATH,
        LOCK_PATH,
        set_paths,
    )

    if TYPE_CHECKING:
        from _typeshed import SupportsWrite

    warnings.simplefilter("default", ResourceWarning)

    # import tracemalloc
    # tracemalloc.start(3)

    if sys.version_info < (3, 10):
        raise RuntimeError("Python 3.10 or higher is required")

    class ParsedArgs(argparse.Namespace):
        _verbose: int
        _debug_ws: bool
        _debug_gql: bool
        log: bool
        tray: bool
        dump: bool
        headless: bool
        config: Path | None
        data_dir: Path | None
        bind: str | None

        # TODO: replace int with union of literal values once typeshed updates
        @property
        def logging_level(self) -> int:
            return LOGGING_LEVELS[min(self._verbose, 4)]

        @property
        def debug_ws(self) -> int:
            """
            If the debug flag is True, return DEBUG.
            If the main logging level is DEBUG, return INFO to avoid seeing raw messages.
            Otherwise, return NOTSET to inherit the global logging level.
            """
            if self._debug_ws:
                return logging.DEBUG
            elif self._verbose >= 4:
                return logging.INFO
            return logging.NOTSET

        @property
        def debug_gql(self) -> int:
            if self._debug_gql:
                return logging.DEBUG
            elif self._verbose >= 4:
                return logging.INFO
            return logging.NOTSET

    def _add_common_args(parser: argparse.ArgumentParser) -> argparse.ArgumentParser:
        parser.add_argument("--version", action="version", version=f"v{__version__}")
        parser.add_argument("-v", dest="_verbose", action="count", default=0)
        parser.add_argument("--tray", action="store_true")
        parser.add_argument("--log", action="store_true")
        parser.add_argument("--dump", action="store_true")
        parser.add_argument("--headless", action="store_true", help="Run without GUI")
        parser.add_argument("--config", type=Path, help="Path to settings file")
        parser.add_argument("--data-dir", type=Path, help="Directory for app data")
        parser.add_argument(
            "--bind",
            type=str,
            help="Host:port binding for the JSON web API",
        )
        # undocumented debug args
        parser.add_argument(
            "--debug-ws", dest="_debug_ws", action="store_true", help=argparse.SUPPRESS
        )
        parser.add_argument(
            "--debug-gql", dest="_debug_gql", action="store_true", help=argparse.SUPPRESS
        )
        return parser

    # Pre-parse to determine headless/config/data-dir without pulling in GUI deps
    pre_parser = argparse.ArgumentParser(add_help=False)
    pre_parser.add_argument("--headless", action="store_true")
    pre_parser.add_argument("--config", type=Path)
    pre_parser.add_argument("--data-dir", type=Path)
    pre_parser.add_argument("--bind", type=str)
    pre_args, _remaining_args = pre_parser.parse_known_args()

    if pre_args.data_dir or pre_args.config:
        set_paths(working_dir=pre_args.data_dir, settings_path=pre_args.config)

    parser_kwargs = {
        "prog": SELF_PATH.name,
        "description": "A program that allows you to mine timed drops on Twitch.",
    }

    if pre_args.headless:
        parser = _add_common_args(argparse.ArgumentParser(**parser_kwargs))
        args = parser.parse_args(namespace=ParsedArgs())
    else:
        import tkinter as tk
        from tkinter import messagebox

        class Parser(argparse.ArgumentParser):
            def __init__(self, *args, **kwargs) -> None:
                super().__init__(*args, **kwargs)
                self._message: io.StringIO = io.StringIO()

            def _print_message(self, message: str, file: SupportsWrite[str] | None = None) -> None:
                self._message.write(message)

            def exit(self, status: int = 0, message: str | None = None) -> NoReturn:
                try:
                    super().exit(status, message)
                finally:
                    messagebox.showerror("Argument Parser Error", self._message.getvalue())

        # handle input parameters
        # NOTE: parser output is shown via message box
        # we also need a dummy invisible window for the parser
        root = tk.Tk()
        root.overrideredirect(True)
        root.withdraw()
        set_root_icon(root, resource_path("icons/pickaxe.ico"))
        root.update()
        parser = _add_common_args(Parser(**parser_kwargs))
        args = parser.parse_args(namespace=ParsedArgs())
    # load settings
    try:
        settings = Settings(args, settings_path=pre_args.config)
    except Exception:
        if args.headless:
            print(
                "There was an error while loading the settings file:\n\n"
                f"{traceback.format_exc()}",
                file=sys.stderr,
            )
        else:
            messagebox.showerror(
                "Settings error",
                "There was an error while loading the settings file:\n\n"
                f"{traceback.format_exc()}"
            )
        sys.exit(4)
    if not args.headless:
        # dummy window isn't needed anymore
        root.destroy()
        # get rid of unneeded objects
        del root, parser

    # client run
    async def main():
        # set language
        try:
            _.set_language(settings.language)
        except ValueError:
            # this language doesn't exist - stick to English
            pass

        # handle logging stuff
        if settings.logging_level > logging.DEBUG:
            # redirect the root logger into a NullHandler, effectively ignoring all logging calls
            # that aren't ours. This always runs, unless the main logging level is DEBUG or lower.
            logging.getLogger().addHandler(logging.NullHandler())
        logger = logging.getLogger("TwitchDrops")
        logger.setLevel(settings.logging_level)
        if settings.headless:
            stream_handler = logging.StreamHandler(sys.stdout)
            stream_handler.setFormatter(logging.Formatter("{levelname}: {message}", style='{'))
            logger.addHandler(stream_handler)
        if settings.log:
            handler = logging.FileHandler(LOG_PATH)
            handler.setFormatter(FILE_FORMATTER)
            logger.addHandler(handler)
        logging.getLogger("TwitchDrops.gql").setLevel(settings.debug_gql)
        logging.getLogger("TwitchDrops.websocket").setLevel(settings.debug_ws)

        service = MinerService(settings)
        api = None
        if settings.bind:
            from web_api import build_api

            api = build_api(service)
            await api.start(settings.bind)
        try:
            exit_status = await service.start()
        finally:
            if api is not None:
                await api.stop()
        sys.exit(exit_status)

    try:
        # use lock_file to check if we're not already running
        success, file = lock_file(LOCK_PATH)
        if not success:
            # already running - exit
            sys.exit(3)

        asyncio.run(main())
    finally:
        file.close()
