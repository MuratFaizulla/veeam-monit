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

Under every job card, beside «🔄 Обновить», «🗂 Точки» and «📊 Сводка», is «📄 Отчёт PDF» (report as a PDF): that job's last 30 days — one page that says how the job stands, then every session the way Veeam's own session report prints them, so it reads like the report people already get from Veeam.

**The first page**, in the look of Veeam's own report — a header coloured by how the job stands, grey section bars, ruled tables, Veeam's green, yellow and red. The header has the job, its kind, machines, repository, schedule, retries, retention and periodic Full; under it the verdict, which opens with what 🛡 says of the job when it needs somebody, in 🛡's words («Нет бэкапа 5 дней», no backup for 5 days). «Сводка» (summary): runs that went well, failed, still going and missed; the newest restore point and how far back it goes, as `/points` has them from the last restore point scan — until the scan has read the server, the page says «Точки восстановления ещё не прочитаны.» (restore points not read yet) and claims nothing of them; the usual run and the longest; machines a run of the month saved, and those none did («Не сохранены», not saved); the size on disk. A replica is told by its runs — machines replicated, the last good run and what it sent — since its points are on the target host, where the bot does not read. Then every run of the month as a bar where it started, its height how long it took on a scale of 10 minutes, an hour, 6 hours, a day and 3 days, so a twenty-minute run and a three-day one both read; a cross where a scheduled start did not come. Beside it the three most urgent things to do; under it the machines, worst first, each by run with its last error; and who else wrote to the same repository during the newest run, or, when nobody did, Veeam's newest errors.

What to do names what it can: exclude NSX service machines Veeam cannot snapshot (`vShield_SVM`), find in vCenter a machine the job names that no run took on (deleted, renamed or made again with a new ID), check DNS on the proxy, check the network to an address Veeam could not reach, widen the backup window that stopped a run, move the start or check vCenter when the first attempt times out and the retry passes, free space before the next Full when three such Fulls would not fit, spread the start when five or more jobs write at once, and find out why a scheduled start did not come — Veeam does not start a job while its previous run is still going. A run still going counts for neither side: «all runs failed» is about the runs that ended.

**The sessions after it**, on pages of their own:

- **A block a session, newest first.** Its header is coloured by the result — green Success, yellow Warning, red Error, blue while it is still going — and says the job's kind and name, «(Full)» when most machines took a Full and «(Retry N)» for Veeam's retries — none for a job started by hand, which Veeam does not retry, and the first page does not count the start after its failure as a retry either — the job's description, and how many machines were processed.
- **Its numbers**, in Veeam's three rows: machines succeeded, warned and failed; start, end with «(+N)» for each whole day since the session started, as Veeam counts it, duration; total size, data read, transferred; backup size, dedupe and compression of the files it wrote — for a replica, which writes none, what a good session sent and nothing for a failed one, as Veeam says it. Beside them is what Veeam said about the session.
- **Details**: every machine in the order Veeam took it on, with its status, start and end, size, read, transferred, duration, and what its log says went wrong, each line once.

The sessions' labels are Veeam's, in English; the first page and the caption under the file are in Russian. What Veeam wrote is printed as it wrote it, but for the connection parameters it repeats after an error, which name the service account: those are cut from every line, as they are from the alerts and the job card.

Pressing the button is answered at once with «⏳ Готовлю отчёт по заданию» (preparing the job report) and the PDF follows in 20–30 seconds; the bot answers other commands meanwhile. It reads the job's sessions of the month and the machines of the newest 60 of them, the log of each machine that did not end in a success (up to 150), the logs of the newest six finished sessions, the repository, the job's backups and their files, and the other jobs on the repository with their sessions around the newest run: a few dozen requests to the job's own server, six at a time, a few hundred for a big job that fails every night. A server whose REST API is 1.1 has no task sessions: there a session's machines are what its log says of each, how it ended and why, without times or sizes. A session whose machines Veeam did not give says they were not read; on the first page a machine none of the read runs took on is «нет сведений» (no information) rather than never saved, and «Прочитано не всё: …» (not everything was read) says what was not. A backup size is known while the session's files are still on disk; before the oldest one it is «—». The restore points are not read again: they, the chain on disk — a day a Full when most of its run's points are, as `/points` says it — and the verdict are the last scan's.

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
- When Telegram does not answer at that moment (a dropped connection, a 429), the messages it could not delete are deleted a little later by themselves, and the summary says how many are left for then («2 удалю чуть позже», I will delete 2 a little later).
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
