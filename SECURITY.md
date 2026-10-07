# Security

## Reporting a vulnerability

Please do not describe a vulnerability in Issues, pull requests or commits: they are public. Report it privately instead, through GitHub: the repository's **Security** tab → **Report a vulnerability** ([direct link](https://github.com/MuratFaizulla/veeam-monit/security/advisories/new)). Say what you found, how to reproduce it and what it lets an attacker do. Only the maintainer sees the report, and you will get an answer within a few working days.

Fixes are made for the latest version only: the server always runs the latest release from the `main` branch.

## If a secret leaks

All secrets live in `.env` on the server. After replacing any of them, run `docker compose up -d --force-recreate`; a plain `restart` does not re-read `.env`.

| What leaked | What to do |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | In [@BotFather](https://t.me/BotFather): `/revoke`, pick the bot, put the new token in `.env`. The old one stops working at once. |
| `VEEAM_MONITOR_PASSWORD` | Change the password of the Veeam service account and put the new one in `.env`. |
| `TELEGRAM_ADMIN_KEY` | `openssl rand -hex 32`, then put the new value in `.env`. |
| `TELEGRAM_WEBHOOK_SECRET` | The same. If the webhook is in use, the bot registers it again with the new secret when it starts. |
| The Veeam certificate changed | The bot stops connecting with `CERT_NOT_PINNED`. This is the protection working, not a fault. Check the new certificate's fingerprint against the Veeam server and put the file in `certs/`. |

A secret that reached a commit counts as leaked even if the commit was later removed: replace it.

## What is already in place

How the bot is protected (access to the bot, keys, certificate pinning, an unprivileged container) is described in the [Security](README.md#security) section of the README and in [docs/](docs/README.md).
