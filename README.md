<p align="center">
  <img src="docs/assets/logo.svg" width="320" alt="Veeam Backup & Replication → Telegram" />
</p>

<h1 align="center">Veeam Telegram Monitor</h1>

<p align="center">A bot that watches <a href="https://www.veeam.com/" target="_blank">Veeam Backup &amp; Replication</a> and tells a <a href="https://telegram.org/" target="_blank">Telegram</a> group what happened to the backups, before anybody has to ask.</p>

<p align="center">
  <a href="https://github.com/MuratFaizulla/veeam-monit/actions/workflows/test.yml" target="_blank"><img src="https://github.com/MuratFaizulla/veeam-monit/actions/workflows/test.yml/badge.svg" alt="Tests" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-1.0.0-00B336.svg" alt="Version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0" /></a>
  <img src="https://img.shields.io/badge/Veeam_B%26R-REST_API_1.1_%7C_1.2-00B336?logo=veeam&logoColor=white" alt="Veeam B&R REST API" />
  <img src="https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram&logoColor=white" alt="Telegram Bot API" />
  <img src="https://img.shields.io/badge/Node.js-22-5FA04E?logo=nodedotjs&logoColor=white" alt="Node.js 22" />
  <img src="https://img.shields.io/badge/NestJS-10-E0234E?logo=nestjs&logoColor=white" alt="NestJS 10" />
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white" alt="Docker Compose" />
</p>

## About

Veeam Telegram Monitor is a <a href="https://nestjs.com/" target="_blank">NestJS</a> service written in <a href="https://www.typescriptlang.org/" target="_blank">TypeScript</a>. It polls the Veeam Backup & Replication REST API and posts to a Telegram group when a job fails, recovers, or a repository is about to run out of space.

In a forum group the bot also keeps **live topics**: messages it edits in place, showing what is running now, what is scheduled next, and which jobs lack fresh restore points. It needs no public address, because it pulls its updates from Telegram, and it runs as a single Docker container.

> [!NOTE]
> The bot speaks Russian: its messages, buttons and command help are in Russian. The code, its comments and all the documentation are in English.

## Features

- 🚨 **Alerts** for failed, warning and recovered jobs, listing the machines that did not make it and Veeam's reason for each.
- 🔁 **Veeam's retries count as one run.** An alert says whether Veeam will try again and when, and the run is followed to its end in one more message rather than one per attempt.
- 📌 **Eight live topics**: monitor health, running jobs, upcoming runs, speed, repositories, protection, restore points, and backups left behind by deleted jobs.
- 🗂 **Restore points are judged per machine**, against each job's own rhythm and its Full schedule, not by a bare "Success". A nightly job two days stale has missed two backups; a weekly one has not.
- ⚡ **What held a run back.** A job's card shows the bottleneck Veeam reported (Source, Proxy, Network, Target), the transport mode of every disk (NBD, HotAdd…), the proxies and the repository gateway used, and the machines that took longest.
- 📅 **A job's last weeks at a glance**: a calendar of Fulls and increments, the size of a Full and of a typical increment, and what the job takes up on disk.
- ⌨️ **Commands and a menu** under the input field: digest, a job's card, its restore points, an on-demand check.
- 🖥 **Several Veeam servers in one bot**: alerts from all of them, live topics for the one selected. A server outside the domain can sign in with an account of its own.

## What it looks like

An alert, rendered by the bot's own code from test data:

```text
🔴 SQL_Nightly: ОШИБКА
Результат: ошибка
Было: успешно
Попытка: 1 из 4 · Veeam повторит ≈ сегодня в 03:54
Тип: бэкап ВМ
Последний запуск: сегодня в 03:02
Следующий запуск: завтра в 03:00

Не прошли: 1 из 3
🔴 sql01 — Failed to open VDDK disk [[DATASTORE01] sql01/sql01_1.vmdk] ( is read-only mode - [true] ) / Failed to open disk for read.

С предупреждением: 1 из 3
🟡 app01 — Unable to truncate SQL Server transaction logs.
```

## Requirements

- **Docker with Compose**, or Node.js 22+ and npm.
- Network access to the Veeam Backup & Replication REST API, usually port `9419`. REST API 1.1 and 1.2 are both supported; the bot finds out which one a server speaks.
- A dedicated, read-only Veeam account. The recommended role is **Veeam Backup Viewer**.
- A bot created with [@BotFather](https://t.me/BotFather) and a **supergroup with topics enabled (a forum)**. Make the bot an administrator with **Manage topics** so it can create the topics it needs.

## Getting started

```bash
cp .env.example .env            # Veeam servers, the read-only account, bot token, group id
docker compose up -d --build
docker compose logs -f
```

The minimum `.env`:

```dotenv
VEEAM_SERVERS=https://veeam01.example.com:9419
VEEAM_MONITOR_USERNAME=svc-veeam-monitor
VEEAM_MONITOR_PASSWORD=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_IDS=-1001234567890
TELEGRAM_ADMIN_KEY=...        # at least 32 characters: openssl rand -hex 32
```

To learn the group's id, start the bot with `TELEGRAM_CHAT_IDS` empty and send `/chatid` in the group. Veeam ships with a self-signed certificate: pin it with `VEEAM_TLS_CERTS` rather than turning verification off. Within a minute of a successful start the live topics appear in the group and the menu in General, and `GET http://localhost:3000/api/health` says whether each Veeam server is reachable.

> [!CAUTION]
> Run **one instance** per bot token. Two instances take Telegram updates from each other (`409 Conflict`) and send every alert twice.

**A server with no internet access** (no npm registry, no Docker Hub) cannot build the image. Build it on a machine that can and ship it ready with `deploy/offline.sh user@host`; see [docs/getting-started.md](docs/getting-started.md).

## Commands

| Command | What it does |
| --- | --- |
| `/status` | Whether Veeam answers and the monitor account signs in |
| `/servers` | The Veeam servers and their state; choose the one the live topics show |
| `/digest` | Every job of the selected server, and which ones are not fine |
| `/job <name>` | One job's card: last result and reason, runs, schedule, settings, what held the last run back |
| `/points <name>` | One job's restore points: calendar, chain, missed Fulls, retention, sizes |
| `/check` | Poll Veeam now |
| `/topics` | The forum topics the bot knows |
| `/clear` | Empty General of the last two days, then put the menu back |
| `/menu`, `/help` | The menu under the input field; this list |

A name can be typed in part and in any case: `/job kingston db` finds `OPS_Veeam_DB_Kingston`. Every command is also a key of the menu.

## Documentation

- Requirements, first run, running on a server: [docs/getting-started.md](docs/getting-started.md)
- Every setting and its default: [docs/configuration.md](docs/configuration.md)
- Commands and the menu: [docs/commands.md](docs/commands.md)
- Topics, Veeam's retries and live messages: [docs/telegram.md](docs/telegram.md)
- HTTP API and Swagger: [docs/http-api.md](docs/http-api.md)
- How the code is organised: [docs/architecture.md](docs/architecture.md)
- The domain language the code is written in: [CONTEXT.md](CONTEXT.md)

## Development

```bash
npm ci
npm test            # builds the service and runs the tests against the compiled code
npm run start:dev
```

What changed in each version is in [CHANGELOG.md](CHANGELOG.md).

## Security

The bot only reads from Veeam and only answers its own groups and their members; it leaves any other group it is added to. Veeam certificates are pinned by their SHA-256 fingerprint, so the password is only ever sent to a verified server. When Veeam refuses the password, the bot waits instead of retrying every minute, so it does not lock the account out. Keys shorter than 32 characters are refused, the container runs unprivileged on a read-only file system, and its port is published on the host's loopback only.

Please report vulnerabilities privately, not in Issues. [SECURITY.md](SECURITY.md) says how, and what to do if a secret leaks.

## Author

[Murat Faizulla](https://github.com/MuratFaizulla)

## License

Veeam Telegram Monitor is licensed under the [Apache License 2.0](LICENSE).

<sub>Veeam and Veeam Backup & Replication are trademarks of Veeam Software; this project is not affiliated with Veeam Software. Icons by <a href="https://simpleicons.org">Simple Icons</a> (CC0).</sub>
