# Changelog

Every notable change to the project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions are [semantic](https://semver.org/): a fix raises the last number, a new feature the middle one, an incompatible change of settings or behaviour the first.

The bot speaks Russian, so the quotes of its messages and buttons below stay in Russian, with their meaning in English.

## [Unreleased]

### Added

- `/points part of a name`: one job's restore points as 🗂 sees them: whether it keeps to its schedule, how many moments each machine can be rolled back to, the current chain, the scheduled Active Full and the dates missed, retention. Without a name it offers the jobs that need attention. Under the answer are «🔄 Обновить» (refresh) and «📋 Карточка» (card); under the `/job` card, «🗂 Точки» (points).
- In `/points`, a day-by-day calendar of the last five weeks: █ Full, ▒ increment, · no point. Gaps and Active Full days show at a glance.
- In `/points`, how much the points weigh: «Full 03.10: 856 ГБ данных → 523 ГБ на диске» (856 GB of data, 523 GB on disk), a typical increment and its share of a Full, and how much the job takes up on disk in all. If a new Full is still being written, it says so. Sizes are read from the backup files when asked; the hourly scan does no extra work.
- An account of its own for a Veeam server outside the domain: `VEEAM_MONITOR_USERNAME_<NAME>` and `VEEAM_MONITOR_PASSWORD_<NAME>`. The other servers use the shared one, as before.
- On the `/job` card, ⚡ the speed of the last run: how much was read and in how long, the bottleneck as Veeam reports it («Target 97% — репозиторий или его шлюз не успевают писать»: the repository or its gateway cannot write fast enough) and the load of all four stages, the disk transport mode (NBD or HotAdd, with the number of disks when mixed), the proxies, the repository gateway and the machines that took longest. A proxy on the Veeam server itself is called that: «VMware Backup Proxy (сам сервер Veeam)». Read on request from the run's logs; on a server with REST API 1.1, only the bottleneck and the load.
- CI builds the Docker image and starts it as `docker-compose.yml` does, until Docker calls it healthy, on every push and pull request, after the type check and the tests.
- A tag `vX.Y.Z` makes a release: the image on `ghcr.io/muratfaizulla/veeam-monit` for amd64 and arm64, and a GitHub release with the version's section of this changelog. The tag must match `package.json`.
- `MONITOR_IMAGE` in `.env` runs a published image instead of building one; `deploy/offline.sh` refuses to run while it is set.
- [Troubleshooting](docs/troubleshooting.md): the common problems, with the messages the bot writes for them and what to do.
- [CONTRIBUTING.md](CONTRIBUTING.md), forms for bug reports and feature requests, and a pull request checklist.
- CodeQL scans the code on every push and pull request, once the repository is public.
- `deploy/offline.sh user@host` ships a new version to a server without internet access: the build and the libraries are made on a machine with internet access, the commit and a ready archive go to the server over SSH, and the image is built there by copying on top of a base. The previous image is kept for rolling back.

### Changed

- 🩺 with several servers opens with how many of them are fine («🟡 4 из 5 серверов в порядке»), not with the selected server alone, which said «всё работает» while another could not sign in. A server in trouble comes first, with its reason and, after a refused password, when the next sign-in will be; the others say how many jobs they have; the selected one is marked in words rather than by ⚪, which read as «off»; the IP addresses are listed together under the list.
- A vulnerability is reported through GitHub's private vulnerability reporting, which SECURITY.md now points to: GitHub has no private messages to write to the owner with.
- The project is open under the [Apache 2.0](LICENSE) licence instead of a proprietary one; the README, the documentation, SECURITY.md and this changelog are in English. The README shows the bot in screenshots, rendered by its own code from invented data. The repository's history no longer holds the addresses, or the names of servers, jobs and customers, of a real installation.
- The menu under the input field holds every command: added «📦 Задание» (job) and «🗂 Точки» (points), which without a name offer the jobs that need attention, «📑 Темы» (topics) and «🧹 Очистить» (clear). «Очистить» asks for confirmation with a button first: a key is easier to hit by accident than `/clear` is to type. The bot posts the new menu to General by itself after the update.
- 🗂 is cut down to a list of the jobs that need attention, one line each: what is wrong and the date to look for in Veeam («пропущено 3 запуска · последний бэкап 02.10 в 03:32»: 3 runs missed, last backup on 02.10 at 03:32; «пропущен 03.10 · последний Full 26.09»: 03.10 missed, last Full on 26.09). Sections for jobs with no point at all, jobs missing backups, jobs missing a scheduled Full (more misses rank higher) and jobs with too few points to judge; the jobs that keep to their schedule are one line with their number. Explanations, totals and job details (chain, retention, points per machine, Full schedule) are gone: all of that is in `/points` for each job. Usually one message; if the list is longer, the messages are numbered.
- Jobs that should have points by their schedule but have none are named in 🗂, not counted in the totals.
- On the job card, a «Цепочка» (chain) line and the monthly Full, which used not to show at all; the Full mode is named the same way as in `/points`.

### Fixed

- The bot locked the service account out itself: after the password was refused it tried to sign in every minute, and Veeam locked the account for 15 minutes, then for 30. Now, after a refusal, the next sign-in waits at least 15 minutes, or until the lockout Veeam named is over. The alert says when the next attempt will be. Restarting the bot tries at once.
- The continuation of 🗂 ended up above its beginning in the topic: the topic's messages were replaced every 36 hours independently of each other. Now, when one is posted again, the ones after it are too.

## [1.0.0] — 2026-09-30

The first release. The bot has been running on the server since 28 September 2026; everything done before that day went into it.

### Alerts

- A job's failure, warning and recovery. The «Попытка 1 из 4» (attempt 1 of 4) line says what happens next: «Veeam повторит ≈ сегодня в 03:54» (Veeam retries ≈ today at 03:54), «повтор уже идёт» (a retry is already running) or «повторов больше не будет» (no more retries).
- The bot follows a failed run to its end: a retry that succeeds sends «задание восстановлено» (job recovered), and when the attempts run out, one «ОШИБКА, повторов больше не будет» (error, no more retries). Failures in between stay silent, and restarting the bot between attempts loses nothing.
- Jobs started by hand or disabled in Veeam are not promised a retry.
- Under an alert, the machines that failed or finished with a warning, with Veeam's reason: from the session's tasks on REST API 1.2 and from the session's log on 1.1. Veeam's internal lines (connection parameters with the user name, agent traces) are cut out.
- Losing and regaining the connection to Veeam, the service account being refused, repositories running out of space; repeats are held back by cooldowns.
- Run times are written the way people say them: «сегодня в 03:02» (today at 03:02), «завтра в 03:00» (tomorrow at 03:00).
- Routing: one 🚨 Alerts topic and a 🟢 Recovered one for recoveries, topics by severity, by category or by job, rules from a JSON file.

### Live topics

- 🩺 Monitor health, ▶️ Running now, 📅 Upcoming runs, 📈 Performance, 💾 Repositories, 🛡 Protection, 🗂 Restore points, and 🧹 Orphaned backups, off by default.
- A message is edited in place and replaced with a new one after 36 hours, while Telegram still allows deleting the old one. A deleted message and a deleted topic come back by themselves, a one-off Telegram failure does not breed duplicates, nothing is pinned.
- 🛡 and 🗂 judge by restore points: a point counts for the machine that made it even if the run as a whole failed; Veeam's retries count as one run; replicas are checked by their successful runs; being overdue is measured against the job's usual rhythm.
- The restore point scan runs hourly; between full readings the session history is topped up with new sessions only.

### Commands and the menu

- `/status`, `/menu`, `/servers`, `/check`, `/digest`, `/job`, `/topics`, `/clear`, `/help`.
- The menu under the input field: «🖥 Серверы · 📊 Сводка · 🔄 Проверить · 🩺 Статус · 🤖 Помощь» (servers, digest, check, status, help); buttons under the answers lead to jobs.
- The job card: result, runs with their number of attempts, schedule, settings, restore points, which machines failed.
- `/clear` clears General of the last 48 hours and posts a fresh menu.

### Several Veeam servers

- Several servers in `VEEAM_SERVERS`: alerts from all of them, the live topics and commands for the one selected in the menu.
- 🩺 lists every server with its IP: the selected one green, the others grey, one that is down red with the reason.
- The REST API version is picked for each server by itself; `VEEAM_LEGACY_TLS` for old servers.

### Security

- The bot answers only its own groups and their members, and leaves any other group by itself.
- Veeam certificates are pinned by their SHA-256 fingerprint; the password goes only to a verified server.
- The admin key and the webhook secret are at least 32 characters; an empty key closes the routes.
- An unprivileged container: not root, no Linux capabilities, a read-only file system, memory and process limits.
- Fixed versions of the libraries in which NestJS 10 held known vulnerabilities.
- Real addresses of servers and machines removed from the repository.

### Operations

- A Docker image on Node.js 22 with a health check, Docker Compose, and PM2 as a fallback.
- State in `data/telegram-state.json` with a `.bak` copy after every write; a damaged file is restored from the copy, unreadable records are dropped one by one.
- Wrong settings stop the start, and all the errors are named at once.
- Licence: proprietary, all rights reserved.

[Unreleased]: https://github.com/MuratFaizulla/veeam-monit/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/MuratFaizulla/veeam-monit/releases/tag/v1.0.0
