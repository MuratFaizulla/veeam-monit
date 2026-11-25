# Grafana: what the bot reads, charted

[← README](../README.md) · [Documentation](README.md)

The bot reads every Veeam server once a minute. With `METRICS_TOKEN` set it also serves what it read at `/api/metrics`, in the format Prometheus scrapes, and `deploy/grafana/` runs a Prometheus and a Grafana beside it with a ready dashboard, «Veeam — обзор» (Veeam overview):

- the bot itself, and whether each Veeam server answered;
- how many jobs failed, warned or are running now, and the jobs that failed or warned, with their last and next runs;
- every repository, how full it is and how fast its free space goes;
- failed jobs and running jobs per server over time: the backup window and where it is crowded;
- Veeam's configuration backup on every server, and how long ago the last good one was made;
- jobs a schedule should run that have not run for more than a week.

A scrape asks Veeam nothing: it reads what the bot's cycle already read. Prometheus keeps 90 days.

## Setting it up

The bot's server usually reaches no Docker Hub, so the images are shipped from a machine that does, as `deploy/offline.sh` ships the bot.

**1. Turn the metrics on.** In the bot's `.env` on the server:

```dotenv
METRICS_TOKEN=...      # at least 32 characters: openssl rand -hex 32
```

and restart the bot (`docker compose up -d` in its folder), or ship a new version with `deploy/offline.sh`, which restarts it. Without the token `/api/metrics` answers 404.

**2. Ship and start Prometheus and Grafana**, from your checkout, after `deploy/offline.sh` has shipped a version that has `deploy/grafana/`:

```bash
deploy/grafana.sh user@host            # the bot's folder on the server is veeam-monit
deploy/grafana.sh user@host other-dir  # or another one
```

The script pulls `prom/prometheus` and `grafana/grafana` here and ships them when the server does not have them yet, about 570 MB the first time. On the server it writes the bot's token for Prometheus, makes Grafana's admin password once and prints it, finds the network the bot's container is on, and starts the stack. It ends by saying whether Prometheus is scraping the bot.

Nothing of the bot's is changed, and `deploy/offline.sh` goes on starting the bot alone: the stack is a Compose project of its own, `veeam-grafana`, with the containers `veeam-prometheus` and `veeam-grafana`.

**3. Open it.** Grafana listens on `127.0.0.1:3001` of the server, as the bot's own port is on the server only. From your computer:

```bash
ssh -L 3001:127.0.0.1:3001 user@host
```

then **http://localhost:3001**, user `admin` and the password the script printed (also in `deploy/grafana/.env` on the server). The overview is the home page. To open Grafana to the network instead, set `GRAFANA_BIND=0.0.0.0` in `deploy/grafana/.env` and run `docker compose up -d` in `deploy/grafana`; it is still behind its login.

## Settings

In `deploy/grafana/.env` on the server, which the script creates:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GRAFANA_ADMIN_PASSWORD` | made by the script | Grafana's `admin` password. |
| `GRAFANA_ADMIN_USER` | `admin` | Its user name. |
| `GRAFANA_BIND`, `GRAFANA_PORT` | `127.0.0.1`, `3001` | Where Grafana is published on the host. |
| `MONITOR_NETWORK` | found by the script | The Docker network the bot's container is on; Prometheus joins it to reach the bot as `veeam-telegram-monitor:3000`. |
| `PROMETHEUS_RETENTION` | `90d` | How long Prometheus keeps what it scraped. |
| `PROMETHEUS_IMAGE`, `GRAFANA_IMAGE` | the versions in `docker-compose.yml` | Other images; the server must already hold them. |
| `TZ` | `Asia/Qyzylorda` | Grafana's time zone. |

The dashboard is provisioned from `deploy/grafana/grafana/dashboards/` and cannot be saved over in Grafana's editor: a change made there is lost at the next start. Save a copy under another name, or change the file and deploy again.

## The metrics

`GET /api/metrics` with `Authorization: Bearer <METRICS_TOKEN>`. A series the latest cycle did not read is left out rather than repeated: when a server stops answering, its jobs and repositories disappear and `veeam_server_up` goes to 0.

| Metric | Labels | Value |
| --- | --- | --- |
| `veeam_server_up` | `server` | 1 when the server answered the latest cycle, 0 when not. |
| `veeam_server_authenticated` | `server` | 1 when the bot's account signed in. |
| `veeam_server_last_check_timestamp_seconds` | `server` | When the latest cycle of the server ended. |
| `veeam_job_last_result` | `server`, `job_name`, `job_id`, `job_type` | 2 failed, 1 warning, 0 success, -1 none: never run, or running now. |
| `veeam_job_running`, `veeam_job_disabled` | the same | 1 or 0. |
| `veeam_job_last_run_timestamp_seconds`, `veeam_job_next_run_timestamp_seconds` | the same | When it last started; when it starts next, absent when nothing schedules it. |
| `veeam_job_objects` | the same | Machines and other objects it protects. |
| `veeam_repository_capacity_bytes`, `_free_bytes`, `_used_bytes` | `server`, `repository`, `repository_id` | Veeam's GB taken as GiB. Used is capacity minus free. |
| `veeam_repository_online` | the same | 1 or 0. |
| `veeam_config_backup_state` | `server`, `state` | 1 for the state it is in: `ok`, `never`, `failed`, `stale` or `unencrypted`. |
| `veeam_config_backup_last_result` | `server` | 2 failed, 1 warning, 0 success. |
| `veeam_config_backup_last_good_timestamp_seconds` | `server` | When the newest run that left a backup behind ended. |
| `veeam_monitor_events_delivered_total`, `_undelivered_total` | | Alerts that reached a chat, and that reached none, since the bot started. |

A job is labelled `job_name`, not `job`: Prometheus sets `job` and `instance` on every series itself.

## Updating and removing

A new dashboard or a new version of the stack comes with the repository: ship it with `deploy/offline.sh`, then run `deploy/grafana.sh` again. To remove it, on the server:

```bash
cd veeam-monit/deploy/grafana
docker compose down        # add -v to delete what Prometheus and Grafana stored
```
