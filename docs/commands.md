# Commands and the menu

[← README](../README.md) · [Documentation](README.md)

## Commands

| Command | What it does |
| --- | --- |
| `/status` | Whether Veeam can be reached, sign-in, the number of jobs, the time of the last check. `/chatid` is the same plus the chat's ID. |
| `/menu` | Shows the menu under the input field if it has gone. `/start` does the same. |
| `/servers` | Veeam servers and their state; a button picks the server for the live topics, `/digest`, `/job` and `/points`. |
| `/check` | Poll Veeam now, unless a cycle is already running. At most once every 30 seconds. |
| `/digest` | A summary of all jobs and a list of the ones with problems. Jobs disabled in Veeam are counted on a line of their own. |
| `/job part of a name` | A job's card: last result, runs, schedule, settings, restore points, which machines failed, and ⚡ the speed of the last run: how much was read and in how long, the bottleneck (Source, Proxy, Network, Target) and what it means, the disk transport mode (NBD, HotAdd), the proxies, the repository gateway and the machines that took longest. |
| `/points part of a name` | A job's restore points: whether it keeps to its schedule, a calendar of the last weeks (█ Full, ▒ increment, · no point), how many moments each machine can be rolled back to, the current chain, the scheduled Active Full and the dates missed, retention, the size of a Full and of a typical increment, and how much it all takes up on disk. Without a name: buttons for the jobs that need attention. |
| `/topics` | The forum topics the bot knows. |
| `/clear` | Clears General: deletes everything said there in the last 48 hours and posts a fresh menu. Leaves the topics alone. |
| `/help` | Help. |

In a forum group the commands work only in **General**; the bot ignores them in other topics. `/digest` and `/job` read Veeam when asked. `/points` reads the list of jobs and the job's backup files when asked (one request per backup), and takes the points from the last scan (hourly). For ⚡, `/job` reads the log of the last run and the logs of up to 30 of its slowest machines, five at a time; when there were more, the card says how many machines it judges by.

## The menu under the input field

The keys are labelled in Russian; the English meaning is in brackets.

| Key | What it does |
| --- | --- |
| 🖥 Серверы (Servers) | The list of servers; the keyboard turns into the server buttons and «⬅️ На главную» (back to the main menu). Pressing one selects that server. |
| 📊 Сводка (Digest) | The same as `/digest` |
| 🔄 Проверить (Check) | The same as `/check` |
| 📦 Задание (Job) | The same as `/job` without a name: buttons for the jobs that are not fine right now |
| 🗂 Точки (Points) | The same as `/points` without a name: buttons for the jobs that need attention |
| 🩺 Статус (Status) | The same as `/status` |
| 📑 Темы (Topics) | The same as `/topics` |
| 🧹 Очистить (Clear) | First asks «Очистить General?» (clear General?); the «🧹 Да, очистить» (yes, clear) button under the question does the clearing. A typed `/clear` clears at once |
| 🤖 Помощь (Help) | The same as `/help` |

The menu lives in the «Меню Veeam Monitor» message in General. The bot checks it every `TELEGRAM_LIVE_REFRESH_MIN` minutes and posts it again if it was deleted. The server menu changes the keyboard only for the person who pressed. The bot sees a pressed key because it is an administrator of the group; otherwise privacy mode has to be turned off in BotFather.

## What `/clear` does

- Deletes everything the bot saw in General: commands, key presses, people's messages, its own answers, the menu and events. Last, it posts a fresh menu with a summary.
- Only messages younger than 48 hours can be deleted, and only those the bot saw itself. Delete older ones by hand.
- Other people's messages are deleted only if the bot has the administrator right to delete messages. Otherwise the summary says how many messages could not be deleted.
- `/clear` leaves the topics with alerts and live messages alone: they are a record of events.

## Who can talk to the bot

Anybody can find the bot by its name, write to it or add it to their own group. So:

| Who | What they get |
| --- | --- |
| A group in `TELEGRAM_CHAT_IDS` | Everything: alerts, live topics, commands, the menu |
| A private chat with a member of such a group | The menu and commands. Alerts do not go there. Membership is checked with Telegram and remembered for 10 minutes. |
| Any other group | Nothing: the bot leaves it by itself |
| Any other private chat | Nothing, not even a refusal |

While `TELEGRAM_CHAT_IDS` is empty, the bot answers in any chat only to `/chatid`, `/start` and `/status`, and only with that chat's ID, with no Veeam data.
