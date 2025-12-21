# WebUI-Plan für TwitchDropsMiner

## Modulkarte (Datei → Zweck)
- `main.py` – Einstiegspunkt; richtet Tk für Argument-Fehlerdialoge ein, lädt `Settings`, konfiguriert Logging (`FileHandler` bei `--log`, NullHandler für Fremdlogger) und startet den `Twitch`-Client über `asyncio.run`, inklusive Signal-Handlern und Lockfile-Prüfung.
- `constants.py` – Zentrale Pfade (`LOG_PATH`, `COOKIES_PATH`, `SETTINGS_PATH`, etc.), Logging-Formatter und Intervalle (u. a. `WATCH_INTERVAL`), Client-IDs/User-Agents sowie Arbeitsverzeichnis- und Resource-Resolver.
- `settings.py` – Lädt `settings.json` mit `json_load` (Merge mit Defaults), stellt CLI-Argumente priorisiert bereit, markiert Änderungen (`alter`) und speichert bei Bedarf via `json_save`.
- `utils.py` – Infrastruktur: `lock_file` für Einzellauf, (de-)Serialisierung für Settings, `RateLimiter` für GQL, `task_wrapper` für Task-Fehlerbehandlung und Hilfsfunktionen für Nonces/Chunks/Cache.
- `twitch.py` – Kern-Orchestrator: hält Session/Cookies, Auth-Flow, GQL- und REST-Requests, State-Maschine (`INVENTORY_FETCH → GAMES_UPDATE → …`), Watch-Loop, Wartungstask, Kampagnen-/Drop-Verwaltung, Start/Stop/Relaod (`run`, `shutdown`, `change_state`, `close`, `restart_watching`), Speicherung von Settings/GUI-Cache.
- `gui.py` – Tk-basierter UI-Manager mit Async-Polling statt `mainloop`, Tray, Tabs, Status- und Fortschrittsanzeigen, Konsolen-Output-Handler `_TKOutputHandler`, Settings-Panel (mutiert `Settings`), sowie Graceful-Close/Stop-Hooks.
- `channel.py` – Darstellung und Verwaltung einzelner Kanäle/Streams (inkl. ACL), Abruf der Spade-/Stream-URLs, Watch-Payload (`send_watch`), Online/Offline-Übergänge und Update-Callbacks Richtung `Twitch`.
- `inventory.py` – Modelle für Kampagnen und Drops (`TimedDrop`, `BaseDrop`, `Benefit`): Earn-/Claim-Bedingungen, Fortschritts- und Claim-Updates, Timer/Verfügbarkeitslogik und Kampagnen-spezifische Zeittrigger.
- `websocket.py` – PubSub-Pool mit mehreren Verbindungen, Backoff-Reconnect, Topic-Verwaltung und Dispatch zu Drop-/Notification-/Channel-Handlern.
- Ergänzend: `cache.py` (Bildcache für GUI), `exceptions.py` (kontrollierte Flow-Exceptions wie `ReloadRequest`, `ExitRequest`), `translate.py` (Lokalisierung), `version.py` (Versionsstring).

## Headless Runner Design (Start/Stop/Status/Reload)
- **Start**: Repliziere den Ablauf aus `main.py`, aber ohne Tk-Fenster-Erzeugung (kein `Tk()`/`messagebox`). Initialisiere `Settings` mit CLI/Config, konfiguriere Logging wie gehabt (Dateioption optional), öffne den Lock über `utils.lock_file` und starte `asyncio.run(twitch.run())`. Der `Twitch`-Konstruktor startet Websocket-Pool und Watch-Loop erst in `run/_run`, daher bleibt der Control Flow async.
- **Stop**: Für ein Headless-Steuerkommando genügt `twitch.close()` (setzt `State.EXIT`), anschließend `await twitch.shutdown()` sobald `run` beendet ist. Das stoppt Watch-Loop, Wartungstask, Websocket-Pool, schließt Session und persistiert Cookies/Settings.
- **Status**: Laufende Zustände liegen in `twitch._state` und werden bei Änderungen über `change_state/state_change` gesetzt. Aktueller Kanal via `twitch.watching_channel` (`AwaitableValue`), Drops über `twitch.get_active_campaign`/`first_drop`, sowie GUI-Spiegel (`gui.status/progress`) als Single Source of Truth. Für Headless sollte eine schmale Status-DTO aus diesen Feldern erzeugt werden (State, aktueller Kanal, aktiver Drop mit Minutenfortschritt).
- **Reload**: Wie im Wartungstask (`_maintenance_task`) nutzbar: `twitch.change_state(State.INVENTORY_FETCH)` stößt Inventur, erneute Kampagnenauswahl und anschließendes Channel-Cleanup an. `restart_watching()` kann zum sofortigen Watch-Loop-Reset genutzt werden.
- **Async/Threads**: Alle Langläufer sind Async-Tasks (Watch-Loop, Wartung, Websocket-Handler, GUI-Poll). Keine zusätzlichen Threads außer Tk intern; Headless-Ausführung vermeidet Tk komplett.

## Events & Live-Updates Quelle (Logs/Progress)
- **Logs**: Logger `TwitchDrops` (plus Sub-Logger `gql`, `websocket`) werden im GUI über `_TKOutputHandler` angezeigt und optional in `log.txt` geschrieben. Bei `--log` erzeugt `main.py` einen `FileHandler` mit `FILE_FORMATTER`. Live-Stream für WebUI: denselben Logger mit zusätzlichem Handler (z. B. Queue/Socket) anbinden.
- **Progress**: Drop-Fortschritt kommt primär aus PubSub (`process_drops` in `twitch.py` via `WebsocketPool`), fällt bei Stille auf GQL (`CurrentDrop`) oder heuristisches Bumping im Watch-Loop zurück. UI zeigt `CampaignProgress.display` an; dieselben Werte (aktueller Drop, Minuten, Timer) können exportiert werden.
- **Inventory/Drops/Claims**: `fetch_inventory` holt Kampagnen/Drops, erzeugt `DropsCampaign`/`TimedDrop` Instanzen und triggert Claims (`TimedDrop.claim`) beim Status `can_claim`. Änderungen landen in `twitch.inventory`, `twitch._drops` und GUI-Inventar; diese Collections sind die Datenquelle für ein WebUI-Inventar.
- **Channel/Online-Events**: PubSub-Events (`process_stream_state`/`process_stream_update`) aktualisieren `Channel`-Objekte und stoßen ggf. Statuswechsel oder Watch-Switches an. `watching_channel` und `gui.channels` spiegeln den aktuellen Fokus.

## Minimale Core-Änderungen für WebUI (Dateipfade)
- `twitch.py`: Konstruktor um einen optionalen UI-Adapter/Fabrik erweitern, statt hart `GUIManager` zu instanziieren – erlaubt Headless-UI mit identischer API-Oberfläche für Status/Output.
- `main.py`: Headless-Einstieg hinzufügen, der auf Tk-Inits und `messagebox` verzichtet, aber Logging/Settings/Lock-Handling beibehält; Status-/Stop-Steuerung z. B. via HTTP oder CLI-Signale.
- `gui.py`: Logging-Handler-Setup entkoppeln (z. B. Factory-Methode für Handler), sodass dieselben Log-Events an eine Headless-Pipeline gestreamt werden können. Optional UI-spezifische `grab_attention`/Tray-Aufrufe noopbar machen.
- `channel.py`/`inventory.py`: Kleine Getter/DTO-Funktionen bereitstellen, um Watch-Ziel, aktiven Drop und Claim-Status ohne GUI-Abhängigkeit konsumierbar zu machen (keine Verhaltensänderung, nur Datenzugriff).
