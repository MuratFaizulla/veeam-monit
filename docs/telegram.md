# Telegram: topics, retries, live messages

[← README](../README.md) · [Documentation](README.md)

## Connecting

By default the bot uses **long polling**, so it needs no public address. When `TELEGRAM_WEBHOOK_URL` is set, the bot registers the webhook `<TELEGRAM_WEBHOOK_URL>/api/telegram/webhook`. That needs a public HTTPS address and `TELEGRAM_WEBHOOK_SECRET`, which Telegram sends in the `X-Telegram-Bot-Api-Secret-Token` header.

## Where alerts land

With the default `TELEGRAM_ROUTING_MODE=single`:

| Event | Topic |
| --- | --- |
| An error or a warning | 🚨 Alerts |
| A recovery | 🟢 Recovered |
| An informational event | General |

The other modes: `severity` gives a topic per severity, `kind` a topic per category, `job` a topic per job. The live topics stay separate in every mode. With `TELEGRAM_CREATE_TOPICS=false` the bot uses only the topics it knows and writes everything else to General.

For explicit rules, copy [telegram-routes.example.json](../telegram-routes.example.json), put its path in `TELEGRAM_ROUTES_FILE` and reload it with `POST /api/telegram/routes/reload`. Rules are checked top to bottom, and the first match wins.

## Veeam's retries

Veeam retries a failed job in a new session, so one bad night looks like three or four failures. The bot counts them as **one run**: two sessions are one run when the newer one started within the retry window after the earlier one ended (the job's `awaitMinutes` pause plus an allowance for the length of the attempt itself).

The **«Попытка»** (attempt) line says what happens next:

| Text | Meaning | When |
| --- | --- | --- |
| `1 из 4 · Veeam повторит ≈ сегодня в 03:54` | 1 of 4 · Veeam retries ≈ today at 03:54 | attempts are left and the pause has not passed yet |
| `2 из 4 · повтор уже идёт` | 2 of 4 · a retry is already running | the next attempt has started |
| `4 из 4 · повторов больше не будет` | 4 of 4 · no more retries | the attempts are used up, or the pause passed with no new one |

Veeam retries only the runs it started itself, so for jobs that are started by hand or disabled in Veeam the bot neither promises a retry nor waits for one.

**How the bot follows a retry**

- The bot reports a failure after the first attempt and then follows the run. Failed retries in between stay silent. A retry that succeeds sends «задание восстановлено» (job recovered); when the attempts run out, one «ОШИБКА, повторов больше не будет» (error, no more retries).
- Until the next attempt starts, following a run makes no requests to Veeam.
- While a retry runs, Veeam reports the result `none`. The bot does **not** write it over the result it knows: `none` means "I don't know right now". Otherwise a recovery would never come.
- The run being followed is kept in `data/telegram-state.json`, so restarting the bot between attempts does not lose the last message.
- The list of machines under an alert comes from the session's tasks (REST API 1.2) or from its log (1.1). Up to five machines of each kind are shown, the rest are counted. Veeam's internal lines (connection parameters with the user name, agent traces) are cut out.

## Live messages

Telegram lets a bot edit and delete its message for about two days **from when it was sent**, however many times it was edited since. So a live message is replaced with a new one after 36 hours, while the old one can still be deleted. If a topic already has frozen messages older than two days, delete them by hand: the bot cannot.

- **A deleted message or topic** is brought back by the bot itself: on the next cycle if its content changes, and no later than `TELEGRAM_LIVE_REFRESH_MIN` minutes (5 by default) otherwise. The 🚨 Alerts topic comes back with the next alert; the history of a deleted topic goes with it.
- **A one-off Telegram failure** (429, 5xx, a dropped connection) is no reason to post a new message: the old one stays, the bot edits it again on the next cycle and logs `was not refreshed, kept for the next cycle`.
- **A topic of several messages** (🗂, when its list does not fit in one) is numbered («· 1/3», «· 2/3»…). When one of its messages is posted again, the ones after it are posted again too, so the order in the topic does not turn upside down.
- **💾 Repositories** opens with where space is running out («🔴 Репозитории: 1 почти заполнен, 1 заполняется»), then gives each repository one line, by name (BKP01, BKP02 and on, Default last): how full it is, a bar, and how much is free. 🔴 from 90% in use, 🟠 from 80%, 🟢 below. When they do not all fit in one message, the ones left out are ones that are fine.
- **▶️ Running now** lists what is running, by name: how far each run has got, how long it has been going, how long the job's runs usually take and when this one should end («идёт 17 мин · обычно ~2 ч · закончит ≈ в 04:45»). Usually is the median of the job's last ten runs that went through at the first attempt. A run on a day a Full is owed is measured against the runs on such days, and the Full is named beside the job («Synthetic Full»). A run longer than every one of those runs and half as long again as the usual one is «⚠️ дольше обычного», and the first line counts such runs («▶️ Идут 5 заданий, 1 дольше обычного»). A job with fewer than three such runs gets no estimate.
- **Auto-delete** in the group must be **longer than 36 hours**, or a live message disappears before it is replaced. Keep in mind that it deletes live messages and alerts alike, so the 🚨 Alerts topic becomes a sliding window.

## Several Veeam servers

Servers are listed in `VEEAM_SERVERS`, comma-separated, and share one account. A server outside the domain, where the shared account is unknown, gets one of its own with `VEEAM_MONITOR_USERNAME_<NAME>` and `VEEAM_MONITOR_PASSWORD_<NAME>` (see [configuration](configuration.md#veeam)).

- **Alerts** come from every server into the same topics. With more than one server, the title starts with the server's name: `BAAS · Files: ОШИБКА` (error). The daily digest comes for each server.
- **The live topics, `/digest` and `/job`** show the selected server: the first in the list until somebody picks another with «🖥 Серверы» or `/servers`. The choice is shared by the whole group and survives a restart.
- 🩺 is about every server: its first line counts the ones that are fine («🟡 4 из 5 серверов в порядке»), a server in trouble comes first with the reason in Veeam's or the network's words, the selected one is 🔵 and leads the servers that are fine (in trouble it stays 🔴: trouble matters more), and the IP addresses of all of them are listed together under the list. The last line says when the message was written and how often the servers are checked.
- **Load.** Every cycle asks each server for its availability, job states and repositories. The restore point scan and the sessions in progress are read from the selected server only; after a switch the first refresh can take up to a minute.
- **A new server** is only remembered on its first cycle: jobs that had already failed on it do not come as alerts. The same goes for a renamed server.
