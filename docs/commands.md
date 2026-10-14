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
| `/points part of a name` | A job's restore points: first what 🛡 says of the job, in the same words («🟢 В порядке», or what is wrong and the facts under it), then a calendar of the last weeks (█ Full, ▒ increment, · no point), how many moments each machine can be rolled back to, the current chain, the scheduled Active Full and the dates missed, retention, the size of a Full and of a typical increment, and how much it all takes up on disk. Without a name: buttons for the jobs 🛡 lists, the worst first. |
| `/repos`, `/repos part of a name` | The Repository report as a PDF, of every server at once. A cover with what needs action now, what to do first and where a new job fits on each site; every repository as a card; which server attaches which repository, and the settings that do not add up (a repository named after a share it does not point at, one share attached twice to one server). Then each repository: how full it is and how much of that is backups no job owns, how many jobs write at once hour by hour over the week, every job on a 24-hour chart with its usual and longest run, errors and bottleneck, and what to do — down to which starts to move where so the whole run stays in the 18:00–07:00 window. With a name, that repository's pages alone. |
| `/topics` | The forum topics the bot knows. |
| `/clear` | Clears General: deletes everything said there in the last 48 hours and posts a fresh menu. Leaves the topics alone. |
| `/help` | Help. |

In a forum group the commands work only in **General**; the bot ignores them in other topics. `/digest` and `/job` read Veeam when asked. `/points` reads the list of jobs and the job's backup files when asked (one request per backup), and takes the points from the last scan (hourly). For ⚡, `/job` reads the log of the last run and the logs of up to 30 of its slowest machines, five at a time; when there were more, the card says how many machines it judges by.

`/repos` reads every server, whichever is selected — a share is attached to several of them: the repositories, every job's configuration, the sessions of the last `REPORT_DAYS` days, the log of each job's two newest finished runs, what is running, and the files of every backup. That is a few hundred requests, six at a time per server, and a minute or two. So the bot first says at once that the report is coming and how long it takes («⏳ Готовлю отчёт: BKP03 … это 1–2 минуты»: preparing the report, a minute or two), then sends the PDF when it is ready; meanwhile the chat shows the bot sending a file, and the bot answers other commands. A name that matches no repository is answered at once, with the names there are. The reading is kept for 30 minutes, so `/repos bkp03` after `/repos` asks Veeam nothing and takes seconds. One PDF is printed at a time. A server that does not answer is said on the cover, and its repositories show their space and nothing else. The PDF is printed by the headless Chromium in the image (`REPORT_BROWSER`).

## The Job report

Under every job card, beside «🔄 Обновить», «🗂 Точки» and «📊 Сводка», is «📄 Отчёт PDF» (report as a PDF): that job's last 30 days in three pages.

1. **Overview.** The schedule, retries, retention, periodic Full and repository; a verdict; how many runs went well, how many machines are saved, the newest restore point and how far back it goes, the usual run and the longest, the size on disk. Then every run of the month as a bar: its height is how long it took, the first attempt at the bottom and Veeam's retries above, coloured by result, with how many machines were saved under the date; a scheduled start no run came for is a hatched bar.
2. **Machines.** Every machine, by run: saved, saved with a warning, failed or not processed, how often it was saved, its points and since when, when it was last saved, its usual time, what it sent, and the last error or warning — «повтор помог» (the retry helped) when a retry of the same run saved it. The machines never saved come first.
3. **Storage and what to do.** The chain on disk a day a row, Full or increment, and the repository's free space; what Veeam said went wrong, grouped by meaning; who else wrote to the same repository during the newest run, on a noon-to-noon scale; and what to do: exclude NSX service machines Veeam cannot snapshot (`vShield_SVM`), check DNS on the proxy, move the start or check vCenter when the first attempt times out and the retry passes, free space before the next Full when three such Fulls would not fit, spread the start when five or more jobs write at once.

Pressing the button is answered at once with «⏳ Готовлю отчёт по заданию» (preparing the job report) and the PDF follows in 20–30 seconds; the bot answers other commands meanwhile. It reads the job's sessions of the month and the machines of the newest 60 of them, the logs of the newest six finished runs, the repository, the job's backups and their files, the server's restore points, and the other jobs on the repository with their sessions around the newest run: a few dozen requests to the job's own server. A server whose REST API is 1.1 lists no machines; the report says so and shows the rest. Something that could not be read is said at the top of the report, and the rest is kept.

## The menu under the input field

The keys are labelled in Russian; the English meaning is in brackets.

| Key | What it does |
| --- | --- |
| 🖥 Серверы (Servers) | The list of servers; the keyboard turns into the server buttons and «⬅️ На главную» (back to the main menu). Pressing one selects that server. |
| 📄 Отчёт (Report) | The repositories by site, with their free space; the keyboard turns into «📚 Все репозитории» (every repository), a «🗄 BKP03» button per repository and «⬅️ На главную». Pressing one is `/repos` for it, or for all; the main menu comes back. The list is what the last minute's check read, so it opens at once |
| 📊 Сводка (Digest) | The same as `/digest` |
| 🔄 Проверить (Check) | The same as `/check` |
| 📦 Задание (Job) | Every job of the selected server to pick from, so nobody has to type a name: the keyboard turns into a key per job marked 🔴 failed, 🟡 warning, ▶️ running, 🟢 fine, ⚪ never run or ⏸ switched off — the ones not in order first, then by name — 50 to a page with «➡️ Дальше» (next) and «⬅️ Назад» (back), and «⬅️ На главную». Pressing a job opens its card; the keyboard stays, so the next job is one press away. `/job` typed without a name still offers the failing jobs as buttons under the message |
| 🗂 Точки (Points) | The same as `/points` without a name: buttons for the jobs 🛡 lists |
| 🩺 Статус (Status) | The same as `/status` |
| 📑 Темы (Topics) | The same as `/topics` |
| 🧹 Очистить (Clear) | First asks «Очистить General?» (clear General?); the «🧹 Да, очистить» (yes, clear) button under the question does the clearing. A typed `/clear` clears at once |
| 🤖 Помощь (Help) | The same as `/help` |

The menu lives in the «Меню Veeam Monitor» message in General. The bot checks it every `TELEGRAM_LIVE_REFRESH_MIN` minutes and posts it again if it was deleted. The server, report and job menus change the keyboard only for the person who pressed. The bot sees a pressed key because it is an administrator of the group; otherwise privacy mode has to be turned off in BotFather.

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
