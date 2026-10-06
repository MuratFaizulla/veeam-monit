# Getting started and running it

[← README](../README.md) · [Documentation](README.md)

## Requirements

- **Docker with Compose**, or Node.js 22+ and npm.
- Access to the Veeam Backup & Replication REST API, usually on port `9419`. The bot tells API versions 1.1 and 1.2 apart by itself.
- A separate read-only Veeam account; the recommended role is **Veeam Backup Viewer**.
- A bot created with [@BotFather](https://t.me/BotFather), and a **supergroup with topics turned on (a forum)**.

> [!TIP]
> Make the bot an administrator of the group with the **Manage topics** right, and it creates the topics it is missing by itself. Without that right, messages that have no topic to go to land in General.

## First run

**1. Fill in `.env`.** Copy [.env.example](../.env.example) to `.env` and set at least:

```dotenv
VEEAM_SERVERS=https://veeam01.example.com:9419
VEEAM_MONITOR_USERNAME=svc-veeam-monitor
VEEAM_MONITOR_PASSWORD=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_IDS=-1001234567890
TELEGRAM_ADMIN_KEY=...        # at least 32 characters: openssl rand -hex 32
```

The bot tells you the group's ID itself: start it with `TELEGRAM_CHAT_IDS` empty and send `/chatid` in the group. Several groups are separated by commas. Every other setting is in [configuration.md](configuration.md).

**2. Start it.**

```bash
docker compose up -d --build
docker compose logs -f
```

**Or run a published image** instead of building one. Every release is on ghcr.io, for amd64 and arm64. Set it in `.env`: `:1` follows every 1.x release, `:1.1.0` stays where it is.

```bash
echo 'MONITOR_IMAGE=ghcr.io/muratfaizulla/veeam-monit:1' >> .env
docker compose pull
docker compose up -d --no-build
```

**3. Check it.** `GET http://localhost:3000/api/health` shows whether the Veeam servers can be reached. Within a minute the live topics appear in the group, and the menu in General.

> [!CAUTION]
> Run **one instance** of the bot per token. Two instances (say, Docker and PM2) take Telegram's updates from each other (`409 Conflict`) and send every alert twice.

## Without Docker

```bash
npm ci
npm run start:dev                      # development, restarts on every change
npm run build && npm run start:prod    # the built service
```

**PM2 on Windows.** PM2 runs the built service from [ecosystem.config.cjs](../ecosystem.config.cjs). Run the commands from the project root; first set PM2's working folder for the current PowerShell window and keep it for every command that follows:

```powershell
$env:PM2_HOME = Join-Path (Get-Location) '.pm2'
```

```bash
npm ci
npm run build
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs veeam-telegram-monitor
```

After the code changes: `npm run build`, then `pm2 restart veeam-telegram-monitor --update-env`. To stop it: `pm2 stop veeam-telegram-monitor`. Starting it after a Windows reboot is set up separately.

## Running on a server

Every command runs from the project folder.

| What you need | Command |
| --- | --- |
| State (should be `Up … (healthy)`) | `docker compose ps` |
| Live log | `docker compose logs -f --tail 100` |
| Restart | `docker compose restart` |
| Stop / start | `docker compose stop` / `docker compose start` |
| Memory and CPU | `docker stats --no-stream veeam-telegram-monitor` |
| Is the service alive | `curl http://127.0.0.1:3000/api/health` |

**Ship a new version:**

```bash
git pull
docker compose up -d --build
```

With a published image (`MONITOR_IMAGE`), `docker compose pull && docker compose up -d --no-build` instead.

**Go back to an earlier version:** `git checkout v1.0.0 && docker compose up -d --build`; back to the latest with `git checkout main`. Every version is in [CHANGELOG.md](../CHANGELOG.md).

**Change a setting:** edit `.env` and run `docker compose up -d --force-recreate`. A plain `restart` does not re-read `.env`.

The container comes back by itself after the server reboots (`restart: unless-stopped`). The bot's log is `logs/backend.log`; Docker's own log is capped at three files of 10 MB.

> [!WARNING]
> **Do not delete `data/`.** Without it the bot publishes a second copy of every live topic and alerts again about old failures. To survive a lost disk, copy `data/telegram-state.json` and its `.bak` somewhere else.

If the server cannot reach Docker Hub, the base image `node:22-alpine` is loaded by hand (`docker load`). Do not replace it later with `docker pull`.

**A server with no internet access** (no GitHub, no npm, no Docker Hub). The new version is built on a machine that has internet access and shipped ready. From the project root, in Git Bash or on Linux, after committing:

```bash
deploy/offline.sh user@host            # the project folder on the server defaults to ~/veeam-monit
```

The script builds `dist` and installs the libraries here, then sends the commit and an archive to the server over SSH. There the image is built by plain copying on top of a base the server already holds (Node.js and time zones), the settings are checked and the container is restarted. Library updates ship the same way. The previous image is kept as `veeam-telegram-monitor:before-<commit>`; to go back to it:

```bash
docker tag veeam-telegram-monitor:before-<commit> veeam-telegram-monitor:local
docker compose up -d --no-build
```

Do not run `docker compose up -d --build` on such a server: the build goes to the internet for packages and fails. The script ships what it builds, so it refuses to run while `MONITOR_IMAGE` is set.

A published release reaches such a server too, without the script: `docker pull ghcr.io/muratfaizulla/veeam-monit:1.1.0` and `docker save -o veeam-monit.tar ghcr.io/muratfaizulla/veeam-monit:1.1.0` on a machine with internet access, copy the file over, `docker load -i veeam-monit.tar` there, set `MONITOR_IMAGE` to that image and run `docker compose up -d --no-build`.

If alerts do not arrive: `/status` in General, the log `logs/backend.log`, then `POST /api/telegram/test`; see [http-api.md](http-api.md).
