# Grafana: what the bot reads, charted

[← README](../README.md) · [Documentation](README.md)

The bot reads every Veeam server once a minute. With `METRICS_TOKEN` set it also serves what it read at `/api/metrics`, in the format Prometheus scrapes, and `deploy/grafana/` runs a Prometheus and a Grafana beside it with two ready dashboards.

**«Veeam — обзор»** (Veeam overview), every server on one page, the verdict first:

- a row of tiles: the bot, the servers that did not answer, the jobs that failed or warned, what runs now, the configuration backups with a problem and the fullest repository;
- every server on one line: whether it answered, its failed, warned and running jobs, its configuration backup and its fullest repository; a click shows that server alone;
- what is broken now, errors first and the newest on top: how long ago, how many machines failed and what Veeam said;
- what runs now, each with its progress and how long it has been running;
- the fullest repositories and how fast their free space goes;
- jobs a schedule should run that have not run for more than a week;
- failed jobs and running jobs per server over time: the backup window and where it is crowded;
- folded at the bottom: jobs long in error, every job, every repository of every server.

A failed or warned job counts when it is enabled and alive: it ran within the week, or it has a next run scheduled. A disabled job is not counted, nor one that failed long ago and has neither run since nor a run ahead: those are under «Давно в ошибке» (long in error), folded. A storage that several Veeam servers use is shown once, by its name; every server's Default Backup Repository is its own.

**«Veeam — задание»** (one job), opened by clicking a job's name in any of those tables, or picked by server and name at the top:

- how its newest ended session went, and beside it what Veeam said of it;
- how long ago it ended and how long it ran, its machines by how they ended, its next run, and its progress when it runs now;
- every machine of that session, the failed first, with the reason in Veeam's words when it did not succeed;
- what it read and sent on, its speed and its bottleneck;
- every run's result, length, size and speed over time.

A scrape asks Veeam nothing: it reads what the bot already read. For the job page the bot reads, every two minutes and only while `METRICS_TOKEN` is set, the sessions begun since its last read: one page, beside its cycle rather than in it. The first read after a start reaches back a month to find each job's newest session. Each new ended session's machines are then read once. Prometheus keeps 90 days.

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

The dashboards are provisioned from `deploy/grafana/grafana/dashboards/` and cannot be saved over in Grafana's editor: a change made there is lost at the next start. Save a copy under another name, or change them for good: they are written by `deploy/grafana/dashboards.py`, so change that, run `python3 deploy/grafana/dashboards.py` and deploy again.

A snapshot (Поделиться → Снимок) stays in this Grafana: publishing one to grafana.com is turned off, as it would carry the jobs' and machines' names out.

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
| `veeam_job_last_session_start_timestamp_seconds`, `_end_timestamp_seconds`, `_duration_seconds` | the same | Its newest ended session: an attempt, the last one when Veeam retried. |
| `veeam_job_last_session_result` | the same | How that session ended: 2 failed, 1 warning, 0 success. |
| `veeam_job_last_session_message` | the same, `message` | 1, with what Veeam said of it when it failed or warned: the machine and the reason, without the account it logged on with. |
| `veeam_job_last_session_read_bytes`, `_transferred_bytes`, `_processed_bytes` | the same | Read from the machines' disks; sent on after compression and deduplication; gone through, skipped blocks included. Absent on REST API 1.1, which keeps no task sessions. |
| `veeam_job_last_session_bottleneck` | the same, `bottleneck` | 1, with the stage that held most of its machines back: Source, Proxy, Network or Target. |
| `veeam_job_last_session_machines` | the same, `result` | Its machines by how they ended. |
| `veeam_job_last_session_machine_result` | the same, `machine`, `reason` | Each machine: 2 failed, 1 warning, 0 success, -1 none; `reason` when it did not succeed. |
| `veeam_job_session_progress_percent`, `veeam_job_session_running_since_timestamp_seconds` | the same | The session it runs now: how far it has got, and since when. |
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
