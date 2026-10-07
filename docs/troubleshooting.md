# Troubleshooting

[← README](../README.md) · [Documentation](README.md)

Where to look first: `/status` in General, the log (`docker compose logs --tail 200`, or `logs/backend.log`), and `curl http://127.0.0.1:3000/api/health` on the server. The messages quoted below are the ones the bot writes.

## The bot does not start

**What you see:** the container stops right away, and the log names variables.

A wrong setting stops the start, and every wrong one is named at once. Fix them in `.env` and run `docker compose up -d --force-recreate`; a plain `restart` does not re-read `.env`. Every setting and its form is in [configuration.md](configuration.md).

## Veeam cannot be reached

**`Failed to reach the Veeam server at … (ENOTFOUND)`**, or `ECONNREFUSED`, or **`The Veeam server did not respond within 30000 ms`**: the request never reached the REST API. Check from the bot's host, not from your own machine:

```bash
curl -k https://veeam01.example.com:9419/api/v1/serverTime -H "x-api-version: 1.2-rev1"
```

A JSON answer with `serverTime` means the network is fine. No answer means DNS, routing or a firewall between the two; the REST API listens on port `9419` of the Veeam server. Inside Docker, `localhost` is the container: a Veeam server on the same host is `host.docker.internal`.

**`(ECONNRESET)`** on an old Windows build of the Veeam server: it accepts only SHA-1 signatures in the TLS handshake. Name the server in `VEEAM_LEGACY_TLS`. That weakens TLS for that server only; the lasting fix is enabling TLS 1.2 on the server itself.

**`Veeam API responded with HTTP 403`**, or another status with no reason of Veeam's: something between the bot and Veeam answered instead of Veeam. A firewall with intrusion prevention, for example, can block the REST API for one source address and answer with its own HTML page. Run the `curl` above from the bot's host: if the answer is HTML rather than JSON, ask the network team for an exception from the bot's address to the Veeam server's port `9419`.

## Certificates

**`TLS handshake with … failed (DEPTH_ZERO_SELF_SIGNED_CERT)`**: Veeam ships with a self-signed certificate, which no CA vouches for. Pin it rather than turning verification off:

```bash
openssl s_client -connect veeam01.example.com:9419 -servername veeam01.example.com </dev/null | openssl x509 > certs/veeam01.pem
```

and add `veeam01=/app/certs/veeam01.pem` to `VEEAM_TLS_CERTS`. Compare the fingerprint (`openssl x509 -in certs/veeam01.pem -noout -fingerprint -sha256`) with the one the Veeam console shows, so that what you pinned is Veeam's and nobody else's.

**`TLS handshake with … failed (CERT_NOT_PINNED)`**: the server presented a certificate other than the pinned one. Usually Veeam renewed it; sometimes the server presents another certificate depending on the name it is asked by, so a certificate saved by IP address does not match the one given to the host name in `VEEAM_SERVERS`. Save it again with the same host name in `-connect` and `-servername` as in `VEEAM_SERVERS`, check its fingerprint, and recreate the container. Until then the bot does not send the password to that server: this is the protection working.

## The monitor account is refused

**`Your account has been locked out for 00:30:00 due to repeated failed log-in attempts`** in an alert, followed by **«Следующая попытка входа — через N мин.»** (next sign-in attempt in N minutes): Veeam refused the password, then locked the account.

After a refusal the bot waits at least 15 minutes before it signs in again, or until the lockout Veeam named is over, so it does not keep the account locked itself. Put the right password in `.env` (or the right `VEEAM_MONITOR_USERNAME_<NAME>` and `VEEAM_MONITOR_PASSWORD_<NAME>` for a server outside the domain) and recreate the container. A restart tries at once, so restart only once the password is right.

A server outside the domain does not know a domain account at all: give it a local one of its own; see [configuration.md](configuration.md#veeam).

## Telegram

**Every alert comes twice**, and the log shows **`Telegram polling error: getUpdates -> 409 Conflict: terminated by other getUpdates request`**: two instances of the bot share one token, say Docker and PM2, or an old container. Stop all but one.

**Topics are not created**, and the log says **`Cannot create Telegram topics in … Grant the bot "Manage topics" or pre-create them`**: make the bot an administrator of the group with **Manage topics**. Until then its messages go to General.

**The bot does not answer commands:**

- In a forum group, commands work in **General** only.
- The bot sees what people type because it is an administrator of the group. If it is not, turn privacy mode off in [@BotFather](https://t.me/BotFather) (`/setprivacy`).
- A group that is not in `TELEGRAM_CHAT_IDS` gets nothing, and the bot leaves it. To learn a group's ID, start the bot with `TELEGRAM_CHAT_IDS` empty and send `/chatid` there.
- In a private chat the bot answers only members of one of its groups.

**A live message stopped changing**, while its «Обновлено» (updated) time stays the same: the monitor itself has stopped. A live message is rewritten at least every `TELEGRAM_LIVE_REFRESH_MIN` minutes even when nothing changed, so a frozen time is the signal. Check `docker compose ps` and the log.

**Live messages disappear**: the group's auto-delete is shorter than 36 hours. A live message is replaced every 36 hours, so auto-delete must be longer than that.

**Old live messages stay in a topic**: Telegram lets a bot delete its own message only for about two days after it was sent. Delete older ones by hand.

**Every live topic appeared a second time, and old failures were reported again**: `data/` was lost, and with it the IDs of the live messages and the results the bot had already seen. Keep `data/` across updates, and copy `data/telegram-state.json` with its `.bak` somewhere else; see [getting-started.md](getting-started.md#running-on-a-server).

**Times are off by some hours**: set `TELEGRAM_TIMEZONE` to the IANA zone the messages should describe, `Europe/Berlin` say. When it is empty, the container's `TZ` decides.

## Partial answers

**⚡ on `/job` shows only the bottleneck and the load**, without how much was read, the transport modes and the proxies: the server speaks REST API 1.1, which has no task sessions to read them from.

**`/points` has no sizes**: Veeam did not give the job's backup files when asked. The rest of the answer stands, and the log says why: `Backup files could not be read: …`.

**🛡 or 🗂 says the points have not been read yet**: the restore point scan runs once an hour, and on the server selected in the menu only. After the bot starts, or after another server is selected, the first scan takes up to a minute.
