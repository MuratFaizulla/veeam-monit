# Configuration

[← README](../README.md) · [Documentation](README.md)

Every setting is made in `.env`; the full list with comments is in [.env.example](../.env.example). A wrong value stops the start and names the variable, and all the errors are named at once. After editing `.env` on the server, run `docker compose up -d --force-recreate`.

## Veeam

| Variable | Default | Purpose |
| --- | --- | --- |
| `VEEAM_SERVERS` | — | Servers, comma-separated: `name=url`, or just the URL (the name is then the first part of the host name). |
| `VEEAM_BASE_URL` | — | The older way to give a single server; set either this or `VEEAM_SERVERS`. |
| `VEEAM_MONITOR_USERNAME`, `VEEAM_MONITOR_PASSWORD` | — | The service account, shared by every server. |
| `VEEAM_MONITOR_USERNAME_<NAME>`, `VEEAM_MONITOR_PASSWORD_<NAME>` | — | An account of its own for a server outside the domain, where the shared one is unknown. `<NAME>` is the server's name in capitals with `_` for `-`: for `veeam-dc2` it is `VEEAM_MONITOR_USERNAME_VEEAM_DC2`. Set both; a variable naming a server that is not in `VEEAM_SERVERS` stops the start. |
| `VEEAM_TLS_CERTS` | — | Certificate pinning: `name=path_to_PEM`, comma-separated. The bot trusts a server by exactly this certificate, checking its SHA-256 fingerprint before the password is sent. In Docker, the `./certs` folder is seen as `/app/certs`. If Veeam changes its certificate, the error is `CERT_NOT_PINNED`: put the new file in place. |
| `VEEAM_INSECURE_TLS` | `false` | Skip certificate checks for servers that are not pinned. Unsafe. |
| `VEEAM_LEGACY_TLS` | — | Names of servers that need old TLS algorithms (SHA-1); otherwise an old server drops the connection with `ECONNRESET`. |
| `VEEAM_API_VERSION` | `1.2-rev1` | REST API version. An older server refuses it and names its own versions, and the bot switches to the newest of them. |
| `VEEAM_TIMEOUT_MS` | `30000` | How long to wait for Veeam to answer. |

## Telegram

| Variable | Default | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | The bot's token from BotFather. |
| `TELEGRAM_CHAT_IDS` | — | Groups that receive alerts and live topics. No other chat ever becomes a recipient. |
| `TELEGRAM_ADMIN_KEY` | — | Key for the operator HTTP routes, at least 32 characters. Empty closes them to everybody. |
| `TELEGRAM_WEBHOOK_URL`, `TELEGRAM_WEBHOOK_SECRET` | — | Public URL and secret of the webhook (at least 32 characters). An empty URL means long polling. |
| `TELEGRAM_ROUTING_MODE` | `single` | `single`, `severity`, `kind` or `job`; see [telegram.md](telegram.md). |
| `TELEGRAM_ROUTES_FILE` | — | File with explicit routing rules. |
| `TELEGRAM_CREATE_TOPICS` | `true` | Create the topics that are missing. |
| `TELEGRAM_TIMEZONE` | the server's time zone | IANA zone for the times in messages. In Docker it defaults to `Asia/Qyzylorda`. |

## Intervals and thresholds

| Variable | Default | Purpose |
| --- | --- | --- |
| `TELEGRAM_MONITOR_INTERVAL_MS` | `60000` | Veeam polling cycle; `0` turns periodic polling off. |
| `TELEGRAM_PROTECTION_INTERVAL_MIN` | `60` | Full scan of restore points. A server selected again is scanned at once if its data is older than 10 minutes. |
| `TELEGRAM_PROTECTION_STALE_DAYS` | `3` | A job goes into 🛡 when its newest point is older than this many days… |
| `TELEGRAM_PROTECTION_OVERDUE_FACTOR` | `2.5` | …and older than this many of its usual intervals. That keeps a weekly job from counting as overdue after three days. |
| `TELEGRAM_PROTECTION_FAILURE_STREAK` | `3` | This many failed runs in a row put a job in 🛡 even when it has a fresh point. |
| `TELEGRAM_REPOSITORY_FREE_PERCENT` | `10` | Free space threshold: below it is a warning, below half of it is critical, `0` turns the check off. |
| `TELEGRAM_JOB_COOLDOWN_MIN` | `15` | Do not repeat the same alert about a job more often than this. |
| `TELEGRAM_AUTH_COOLDOWN_MIN` | `60` | The same for problems with the account. |
| `TELEGRAM_REPOSITORY_COOLDOWN_MIN` | `720` | The same for repositories. |
| `TELEGRAM_DIGEST_HOUR` | `-1` | Hour of the daily digest; `-1` means none. `/digest` always works. |
| `TELEGRAM_LIVE_REFRESH_MIN` | `5` | A live message is rewritten at least this often, even with nothing new: a frozen «Обновлено» ("updated") time means the monitor has stopped. The menu is checked as often. |

## Live topics, topic names, files

| Variable | Default | Purpose |
| --- | --- | --- |
| `TELEGRAM_LIVE` | `true` | Live topics. |
| `TELEGRAM_LIVE_ORPHANS` | `false` | The 🧹 Orphaned backups topic. |
| `TELEGRAM_TOPIC_*` | see `.env.example` | Names of all the topics, both live and for alerts. |
| `TELEGRAM_SEND_INTERVAL_MS`, `TELEGRAM_QUEUE_LIMIT` | `1500`, `200` | Pause between messages to one chat, and the size of the queue. |
| `TELEGRAM_STATE_FILE` | `data/telegram-state.json` | State file. |
| `LOG_FILE` | `logs/backend.log` | Log. |
| `PORT` | `3000` | HTTP port inside the container. |
| `HOST_BIND`, `HOST_PORT` | `127.0.0.1`, `3000` | Where Compose publishes the port on the host. |
| `API_DOCS` | `false` | The Swagger page at `/api/docs`; see [http-api.md](http-api.md). |
