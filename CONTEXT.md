# Domain language

Terms this codebase uses in a specific way. When a term is here, use it — in
code, in comments, and in the Russian text the bot sends.

## Evidence

What one reading of the Veeam estate established: every restore point the server
holds, every session that wrote one, and every job configuration saying whether
a job was supposed to run at all.

Three live slots — 🛡 Protection, 🗂 Restore points, 🧹 Orphaned backups — are
three questions about one Evidence. Reading it costs around twenty requests and
about forty seconds, so it happens on its own cadence
(`TELEGRAM_PROTECTION_INTERVAL_MIN`) and the answer is kept until the next one.
Only the selected server's Evidence is read. A server that is selected again is
read again at once, unless its Evidence is less than ten minutes old.

A point written by a failed run is discarded only when its own machine failed
in that run: Veeam marks the whole run failed when one machine of fifteen does.
The machine outcomes come from the task sessions, or from the session log on a
Veeam whose REST API has none (1.1). Replicas and other jobs whose points are
not in the restore point list are **proven by runs**: judged by the runs that
worked.

The **Session history** behind the Evidence is read whole on start and once a
day. In between, a scan reads only the sessions begun in the two days before
the previous read, which is one page instead of twenty, and merges them in by id.

Evidence is either **ready** or **pending**, and pending carries the reason a
slot can show. There is no third state and no sentinel: "never scanned" and
"Veeam did not answer this cycle" are both pending, with different reasons.

Owned by `src/estate/backup-evidence.service.ts`. Readers take it as
an argument; nothing reads it out of a field.

Refreshed once per cycle, as its own step, right after the job list is read
and before anything reads it — the alerts as much as the live slots. It used
to be refreshed by the live step, which runs last, so the alerts read the
previous cycle's evidence; after a cycle Veeam did not answer that was
pending, and the first alert after the outage lost the job's retry policy.

Two readers are outside any cycle and take the current value from
`evidence` instead: a **Job card** asked for between cycles, and an alert
whose Evidence is still pending, which reads the job's own configuration for
its retry policy rather than going without "из 4" until a scan succeeds.

## Run

One execution of a Veeam job, *including its automatic retries*. Not a session.

Veeam retries a failed job on its own and each attempt is a separate session, so
a job with the default three retries reports four failed sessions for one failed
Run. Everything the bot counts — failure streaks, missed backups, retained
history — counts Runs.

A Run **succeeded** if the attempt that finished it succeeded, whatever the
earlier attempts did. One that ended in a warning did not succeed — it
continues a failure streak — but the restore points it wrote still count:
Veeam finished the backup, with complaints. Only a session that *failed* has
its points set aside (see **Restore point**). Two questions, two answers.

Which sessions are one Run is decided in one place, `src/estate/runs.ts`,
and read by all three things that need it: the alert's **Attempt** label, the
failure streak in 🛡 Protection, and the run list on a **Job card**. They used
to fold sessions by rules of their own, and the streak's — start to start —
counted a Run whose attempts took longer than the allowance as several: one
night the alert called "3 из 4" was, to 🛡, three failed Runs in a row.

A session is an attempt, not a Run; in code it is `JobSession`.

## Restore point

One recoverable state of one machine. Veeam creates one per protected machine
per Run, so a job covering eight VMs produces eight restore points offering the
same single moment to restore to.

A restore point **counts** only if the Run that wrote it succeeded. A failed Run
leaves one behind anyway, and the point it leaves is a file on a repository, not
a state anybody should plan to restore to.

Which Run wrote a point is decided by *when the point appeared*, not by the
session id the point carries: Veeam stamps a point with the session that opened
the Run, and a retried Run keeps writing into the same point.

## Standing

What one job is owed and what it has: whether it is **excused** from producing
restore points at all, and if not, its recent Runs, its Cadence, its failure
streak and its retained history.

A job is excused only on positive evidence — switched off in Veeam, or
configured to start by hand. A job whose configuration could not be read is
judged: an unknown schedule is treated as a real one, because the failure mode
of the other choice is silently dropping a job from every check.

Standings are worked out once per cycle and read by both 🛡 Protection and
🗂 Restore points, so the two messages cannot disagree about which jobs are in
scope or how many were left out.

A Standing deliberately says nothing about whether a job is *late*. The two
slots ask different questions of the same Standing — "how many Runs has it
skipped" and "is this past the deadline worth reporting" — and those are
decisions about what to alarm on.

Owned by `src/estate/job-standing.ts`.

## Cadence

How often a job actually runs, in days: the median gap between its recent Runs.
Median rather than mean, so one long outage does not redefine a nightly job as a
monthly one. Null when there is too little history to tell, and then nothing is
claimed about missed Runs.

Inferred, never read from the schedule. Computed once, in the Evidence, because
two modules deriving it from the same timestamps is two chances to disagree.

## Repository capacity

How full one repository is, worked out once from what Veeam reports.

What is occupied is **capacity − free**, not `usedSpaceGB`: on some VBR/storage
combinations that field counts logical or deduplicated data and can exceed
capacity outright. `usedSpaceGB` is the fallback, used only when free space was
not reported.

The two percentages are not interchangeable. **usedPercent** draws the bar and
may rest on the fallback, so it is an illustration. **freePercent** raises the
low-space alarm and exists only when Veeam actually reported free space — a
guess is not grounds for waking somebody up, and an unknown percentage is never
zero.

Owned by `src/estate/repository-capacity.ts`. The 💾 slot renders what
it is given, like every other live slot.

## Live slot

A topic holding exactly one message, edited in place rather than appended to.
State, not events. 🗂 Restore points is the exception that holds two, because
the list does not fit in Telegram's limit.

Declared once in `src/live/slots.ts`, with whether it addresses a thread
somebody created by hand. The slot names come from that declaration, including
the type and the config record.

Every slot gets the **heartbeat**: an unchanged message is still rewritten every
few minutes, so a frozen "Обновлено" means the monitor stopped, and a message
somebody deleted is noticed. Nothing is pinned. A slot posts a fresh message
every 36 hours, and each pin left a "pinned …" notice in the topic that
outlived its message and could not be removed by the bot.

Every slot ends on one footer line, "Обновлено …", written by `footerOf` and
recognised by `isFooter` in `src/live/format.ts`. The live module leaves that
line out when deciding whether a slot changed, so a renderer that spelled the
footer itself would rewrite its message every cycle. Fitting a slot under
Telegram's limit is `fitted` or `paged`, never a loop of the renderer's own.

What every slot says after a cycle is decided in one place,
`src/live/snapshots.service.ts`: a cycle's jobs, Working sessions,
repositories, whether the account signed in and the monitor's own health go
in, one page per slot comes out, in publishing order.
The monitor adds the health — the one input only it has — and sends the pages.
It used to build each slot's input itself, in private methods no test could
reach without running a whole cycle.

A slot outlives its message. Telegram stops letting a bot edit or delete its own
message about two days after it was *sent*, however recently it was last
written, so the message is retired and replaced after 36 hours — while deleting
it is still allowed. Left later, the slot meets an edit that fails and a
deletion that fails with it, and is left with one message frozen at its last
good content and a second posted beside it, which is what the ▶️ topic did. A
ref whose `createdAt` is unknown is retired at once: betting on it being young
is the same bet that produced the frozen message.

## Delivery

Turning one notification event into one message per chat it belongs in, and
saying what became of it. Routing, the severity filter, the cooldown, the retry
in General and the eviction of a chat that removed the bot are all inside it.

A **DeliveryReport** names the outcome rather than reducing it to "sent or not":
`cooldown`, `severity-filtered` and `dropped-by-rule` are three different
reasons an alert never arrived, and an operator asking "why did nothing come"
needs to be able to tell them apart without reading the log.

Owned by `src/telegram/telegram.service.ts`.

## Update

One thing Telegram tells the bot: a message, a command, or a change to the bot's
own membership. How it arrives — a webhook callback or long polling — is chosen
by whether `TELEGRAM_WEBHOOK_URL` is set, and nothing downstream knows which.

Hearing and sending are separate modules. They share the transport and the chat
registry and nothing else, and no caller of one ever wants the other.

Hearing an Update and interpreting it are separate too. **Intake** first
decides whether the chat may be spoken to at all (**Access**), then registers
the chat and any topic a message mentions, publishes the command menu and sets
up the webhook or the polling loop at startup. Both transports end in its
`handleUpdate`: the webhook endpoint in the controller and the polling loop are
two adapters of that one seam. What the Update *means* — a command or a
**Button** in General, answered — is decided after it, by a module with no
lifecycle, so a test of a command never constructs the polling loop. One that
did once hung the whole test run.

What a command needs from the monitor — its health, a pass on demand, the
**Summary** and a **Job card** — it asks through `Monitor` in
`src/monitor/monitor.ts`, not through the monitor class. The HTTP surface does
the same. Two adapters sit behind that seam: `MonitorService`, and the idle
monitor the tests use for a world with no Veeam, which a test keeps in step
with the real one.

**Access** is who the bot talks to, because anybody can find it by name: a
chat in `TELEGRAM_CHAT_IDS` is a *recipient* — the only kind anything is ever
sent to; a private chat with somebody in one of those is a *member*, answered
but never sent alerts; with nothing configured it is *setup*, told only its own
id; anybody else is *none* — a private chat is not answered, and a group is
left. Membership is asked of Telegram and remembered for ten minutes. The chat
registry holds recipients only: it used to take any chat an update came from,
so a stranger who pressed Start was sent every alert from then on. Owned by
`src/updates/chat-access.ts`; the registry's half by the state store.

Intake is owned by `src/updates/updates.service.ts`; commands and Buttons by
`src/updates/commands.service.ts`, declared in `src/updates/commands.ts`.

## Attempt

Veeam retries a failed job by starting another session, so one bad night is
three or four sessions. Two of them are the same **Run** when the newer started
inside the retry window of the older finishing — the job's own `awaitMinutes`
plus an allowance for how long the failing attempt took.

The alert says which attempt it is ("2 из 4"), because three messages a night
with identical text were three attempts at one run and nothing said so — and
what comes next, which is what decides between waiting and going to look:
"Veeam повторит ≈ сегодня в 04:33" while the job has attempts left and the
wait since the last one has not run out, "повторов больше не будет" once
either has, and "повтор уже идёт" when the next attempt is running as the
failure is read. That answer is `standingOf`, by the same rule that folds the
attempts; an attempt with no end yet is the next attempt of the failed run
it follows, never the end of it. Veeam retries only the runs it starts
itself, so a job set to start by hand, or switched off in Veeam, has no
attempts to promise whatever its retry settings say (`retriesAllowed`). A
scheduled job somebody started by hand cannot be told apart: the REST API does
not say who started a session.

A failure is announced when the result changes, which is after the first
attempt, so that alert alone always said "1 из 4". A run announced while
Veeam still had attempts left is a **Retrying run**: it is followed until the
job's result changes — a retry that worked is a recovery, and says which
attempt did it — or Veeam stops trying, which is one more alert, "ОШИБКА,
повторов больше не будет". The attempts in between say nothing. Following
costs no request until the job's last run moves, which is when Veeam starts
another attempt. Kept in the state file, so a restart between two attempts
does not lose the last word; remembered by the **Job memory**, followed by
the **Job alert** module.

Every failure alert lists the machines that went wrong, each with Veeam's
reason, instead of the session's message — which for a failed machine is
"Processing APPDB1-T3Q4", its name and not a word about why. The reason comes
from the task sessions, or on REST API 1.1 from the session log (`machineResults`),
with Veeam's "Processing <machine> Error:" and the line that repeats the
connection parameters taken off (`machineLine`). The job card reads the same.

Distinct from the remembered result, which is what stops the repeats: a job
reports `none` while a retry runs, and recording that over `failed` made the
next failure look like a new one. `none` is not a result — see
`rememberedResult`. The same mistake lost every recovery, whose definition is
"the previous result was bad".

Owned by `src/estate/runs.ts`, with the **Run** it is an attempt at.

## Transition

A job's result changing from what the monitor remembers, and the alert that
change is worth: into `failed` is critical, into `warning` is a warning, and
into `success` is worth a message only as a recovery from something bad. A
running retry reports `none`, which is not a result and changes nothing.

Deciding is separate from sending. `src/monitor/transitions.ts` says what is
owed and what to remember; the **Job alert** module sends it and records the
result only once the alert was delivered — a delivery that reached nobody has
not dealt with anything, so the transition stays pending and is tried again
next cycle.

Repositories have the same split in `src/monitor/repository-alarms.ts`: below
the threshold warns, below half of it is critical, back above it re-arms. The
hour the daily **Summary** goes out is `digestDue`, in `TELEGRAM_TIMEZONE`.

## Job alert

Everything the bot says about a server's jobs in 🚨 Alerts and 🟢 Recovered, and
when: a failure, a warning, a recovery, and the last word on a **Retrying
run**. One module per **Server**, built by the monitor beside it and called
once a cycle with the job list and the **Evidence**; the alerts come out sent,
and what is remembered is advanced only for those that were delivered.

Behind that one call: which change is worth a message (**Transition**), which
failed run Veeam is still retrying and how it ended, where the job's retry
policy comes from — the Evidence when a scan has finished, the job's own
configuration otherwise — the **Attempt** line, and the machines that went
wrong. They used to be private methods of the monitor and the modules around
them, reachable only through whole monitor cycles; a script that wanted to show
what an alert looks like copied the field list by hand, and the copy drifted
within the day. Sending is handed in — the monitor's, which names the server
and counts deliveries — and so is the clock.

Not in it: the server not answering, the account not signing in, repository
space and the daily **Summary**, which are the monitor's own.

Owned by `src/monitor/job-alerts.ts`.

## Job memory

What the bot remembers about one server's jobs across cycles and restarts: the
result each job was last reported with, and the **Retrying run** of each job
Veeam is still retrying. One module per server, handed its part of the state
file; a job deleted in Veeam, or a server taken off the list, takes both
along. They were two modules once, and the second, copied from the first,
missed being pruned with its server.

The file keeps the two parts where older versions wrote them, `jobResults`
and `retrying`, so a version rolled back to reads what it knows. They are
checked entry by entry on the way in: an entry this version would not have
written is left out and said, rather than failing the file — which would
cost the chats, topics and live messages beside it for the sake of one job.

Owned by `src/telegram/job-memory.ts`.

## Summary

Where every job stands, counted in one pass over the job list: how many
succeeded, warned, failed, are running, have never run, and which jobs are
behind the bad numbers.

It is a **standing**, not a period. "Сводка за сутки" was the old name and the
wrong claim: nothing is windowed, every figure comes from each job's own
`lastResult`, and a job that failed on Friday and has not run since is still
counted as failed on Monday. That is the point of it — 🚨 Alerts reports
**transitions**, so a permanently broken job appears there once and never again.

One event, two deliveries: `digestEvent` builds it, the daily message routes it
at `TELEGRAM_DIGEST_HOUR`, and `/digest` renders the same event straight back to
whoever asked. They were briefly two renderings of one set of figures and began
to differ within a day; there is now nothing that can differ.

The running count comes from the union of job status and Working sessions, not
from the status alone — see `isRunningNow`. Counting it separately here is what
let the ▶️ slot and the summary report different numbers of running jobs on the
same estate at the same moment. The Working sessions are one read a cycle,
`workingSessions` on the **Estate reader** — every page, then the active-state
check — shared by ▶️, 📈 and the daily Summary; `/digest` makes the same read.
They used to be read twice a cycle with two ideas of "Working".

When that read fails the count falls back to job status alone, and the
Summary says so beside the figure ("только по статусу заданий") instead of
sending the smaller number as the whole truth; the cycle's health carries the
error too.

Owned by `src/estate/digest.ts`.

## Job card

Everything known about one job, gathered for somebody who asked about it by
name. Five sources, one message: its runtime state, its **configuration**
(schedule, retry, repository, proxies, retention, mode, the machines it
protects), its recent **Runs**, the per-object detail of the newest bad run,
and its restore-point depth and **Cadence** from the last **Evidence** scan.

The per-object detail is the part nothing else in the service has: Veeam
reports a failure against the *job*, and "which machine" is the next question
every single time. It is read only while the job is actually failing — a
recovered job's failures are already in its run list — and comes back empty
when the run never reached an object at all, which is itself the answer.

The **Settings** are strings by the time they reach the card: deciding that
`dailyKind: SelectedDays` with three days means "пн, ср, пт в 03:12" is a
reading of Veeam's schedule model and lives with the module that models
schedules.

Its Runs come from the job's newest thirty sessions — the alert counts its
**Attempt** from the same read. When the read stops at that limit, the oldest
Run in it may be cut short, and is left out rather than listed with fewer
attempts than it had. Six sessions used to be read: one night of a job that
retries, and half of the night before.

Every live slot is an aggregate; this is the only thing in the service that
answers about a single job. The name is matched approximately — whole name,
then containment, then every word of the query appearing somewhere — because
the name arrives half-remembered. Several matches are listed, never resolved by
guessing.

Owned by `src/estate/job-card.ts`.

## Inventory

The names behind the ids a job points at — repositories and proxies. A job
configuration says `backupRepositoryId: 60df9772-…` and nothing else, and no
part of that is worth showing anybody.

Read once and kept for half an hour, because this is the part of the estate
that does not change. A failed read keeps the previous names rather than
clearing them: last month's name is far closer to the truth than a GUID.

Owned by `src/veeam/inventory.service.ts`, which keeps what the **Estate
reader**'s `inventoryNames` reads.

## Server

One Veeam Backup & Replication server the bot watches, listed in
`VEEAM_SERVERS`. It has a **name** — what the alerts, the server menu and the
**Live slots** say — and a **key**: short, ASCII, derived from the name, and
what a **Button** and the state file address the server by. Renaming a server
changes its key, and the bot learns its jobs again, quietly.

Everything a server is read with is its own: token, **Estate reader**,
**Inventory**, **Evidence**, and the job results a **Transition** is decided
against. Nothing is shared but the monitor account and the API version. A
server that has never been observed is seeded quietly, whatever the others
remember: a job that was already failing when the server was added is not news.

Servers of one estate run different Veeam builds. Each is spoken to in the
REST API version of its own build: the configured one, until the server refuses
it and names the ones it speaks, and then the newest of those. An old one may
also insist on SHA-1 signatures in the TLS handshake and reset the connection
without them; `VEEAM_LEGACY_TLS` names the servers that are offered them.

Every server is watched every cycle — reachability, sign-in, job states,
repositories — and its alerts carry its name first in the title, when there is
more than one: `BAAS · Files: ОШИБКА`. The daily **Summary** goes out once per
server.

Owned by `src/veeam/servers.ts` (`VeeamServers`) and, with its Evidence and
job answers, `src/estate/server-estates.ts` (`ServerEstates`).

## Selected server

The one **Server** the **Live slots**, `/digest` and `/job` show. The first in
the list until somebody picks another with `/servers`; one for the whole group,
and kept across a restart. Selecting redraws the slots at once rather than at
the next tick.

It decides what is shown, never what is watched: alerts come from every server
whichever is selected. What it does decide is which server pays for the reads
only the slots need — the **Evidence** scan and the Working sessions. A server
not selected keeps the Evidence of its last scan, and an alert's retry policy
comes from the job's own configuration when there is none.

A job's **Button** names the server the job is on, so pressing it after another
server was selected still opens the job it was labelled with. A Button from
before there was a list names none, and opens the job on the Selected server.

## Estate reader

Everything the service reads from Veeam, by name: the job states, one job's
recent sessions, the Working sessions, a session's tasks, one job's
configuration and all of them, repository states, backups, restore points,
every session (the **Evidence**'s), and the **Inventory** names. The paths, the
parameters, paging and the monitor account's token are inside; no caller builds
a path or holds a token. What it hands out is translated once — a **Job**, and
every session's result lower-cased.

Every request asks the auth service for its token, which is cached. The token
used to be a string fetched at the start of a cycle and passed from reader to
reader: a refused call was retried with a fresh one, but everything after it
still carried the refused string, and the login-storm guard (one forced sign-in
a minute) then declined to fetch another. One 403 cost the rest of the cycle.

When Veeam refuses a token: if the auth service already holds a different one,
that is used and the guard is not spent; otherwise the guard is asked, and a
request refused alongside one that got there first uses the token that one is
fetching. Exactly one retry. The monitor still decides, once a cycle, whether
the account signs in at all, and passes that on as a yes or no.

Owned by `src/veeam/estate-reader.service.ts`; what it hands out is
`src/veeam/estate.ts`.

## Job

One Veeam job as the service reads it: always an id, one name, one spelling of
its result. A job Veeam gave no name is called by its id — in the alert and the
topic it is routed to, the **Summary**, every **Live slot**, the **Job card**
and its **Button**. `result` is lower-cased, and `none` while a run is going or
before the first; `none` is not a result (see **Attempt**). A job with no id is
left out at the read: nothing could address it, remember it or match a session
to it.

Every reader of Veeam's job state used to decide these for itself: seven
decisions of a name with three answers — "неизвестное задание", "без имени",
the bare id — and `!job.id` guarded against in seven places.

Translated by `jobOf` in `src/veeam/estate.ts`, once, when the **Estate
reader** reads the job states.

## Answer

What a command or a **Button** produces, as opposed to an **event**. An answer
is sent back to the chat and thread the question was asked in; an event goes
through routing to the topic its kind and severity imply.

The distinction is load-bearing for `/digest`: routed as an event, a summary
with nothing wrong in it would be delivered to the recoveries topic by its
severity, nowhere near whoever asked.

An answer carries the ids of whatever it lets the reader ask about next, not
only its text. That is what a **Button** is built from: a rendered job name is
not an address.

## Answer log

The message ids of everything said in General, per chat, so `/clear` has
something to take back. Named for what it first held — the bot's **Answers** —
it now also holds what people type there, the menu keys they press, the
messages that carry the **Menu**, and events the notifier posts to General.
`/clear` used to take back the Answers alone, and left a column of "/digest"
and "/status" with nothing after them.

It exists because the Bot API offers no way to clear a chat: a bot can delete a
message only by id, cannot enumerate history, and loses the right after 48
hours. The set it can ever remove is therefore exactly the set it wrote down as
it went. Three places write: the commands module for what is said in General
and what it answers there, and the notifier for an event that landed in
General. An alert in its topic and a **Live slot** message are never written,
so they are out of reach rather than excluded by a rule somebody has to
remember.

Scoped by thread: General is its own scope, not "everything".

Newest 500 per chat, entries older than 48 hours dropped on read.

Owned by `src/telegram/answer-log.ts`. It is persisted in the state file
like everything else, but the state store only hands it its part of the file
and a way to save; the rules above live in the answer log. The **Job
memory**, cooldowns and live messages are split out the same way —
`store.jobMemoryOf`, `store.cooldowns`, `store.liveMessages` — and the store
itself keeps only the file, the chats and the forum topics.

## Button

One offered next step under an answer. What it means travels in Telegram's
`callback_data`, capped at 64 bytes — so a job is addressed by its GUID and
never by its name, and a button opens the job it was labelled with even if the
estate changed between the message and the press.

The encoding and its reader are one module, `src/updates/keyboard.ts`, because
they are one decision seen twice. Written apart they drift, and nothing fails
until somebody presses one in production. An action the running version does
not recognise — a button on an older message — is acknowledged and ignored
rather than answered by guess.

The **Menu** is the other neighbour: the keyboard under the input field,
which stays until another replaces it. A key sends its label as an ordinary
message, so the label is the address, declared once in `src/updates/menu.ts`
and read back there. The main menu stands for commands; the server menu is a
key per **Server** and one back. A key pressed by one person changes only that
person's keyboard: the answer replies to the key's message and is selective.
The bot sees these ordinary messages because it administers the group. The
keyboard lives as long as the message that put it there, so the bot keeps that
message: it remembers the newest menu for everybody and looks at it every few
minutes. When Telegram says it is gone, or the layout changed, the menu is
posted again; a restart or a failed look posts nothing. `/clear` takes the old
menus with everything else in General and ends by posting a fresh one.

The **command menu** is the neighbouring idea: the list registered with
`setMyCommands` at startup, which Telegram shows beside the input field. It is
the only place the bot's commands are discoverable without reading `/help`.

Each command is declared once, in `src/updates/commands.ts`: its name, the
hidden spellings (`/start`, `/chatid`), its menu line, its `/help` paragraph,
the Answer it gives and the Button that stands for it. The menu and `/help`
are derived from that list and the dispatch reads it. They were four lists
once, and drifted: the menu said `/clear` worked "в этой теме" while `/help`
said General — the only place any command is answered. A Button kind no
command claims fails the build; a job's own Button carries an id and is the
one that is not a command.

## Setting

One environment variable and the value the service runs on, declared once in
`readConfig`: the variable, its kind, its bounds, its default. Startup's check
(`validateEnvironment`, the `validate` hook) and the config every module reads
(`configuration`, the `load` factory) are the same reading of that declaration.
They used to be two parsers, and startup refused `Single` and `critical,` that
the service would have read fine, and passed `1e3` that it then read as 1.

Harmless variants are read as meant — any case for a fixed choice, surrounding
spaces, an empty item in a list — and a blank variable means its default.
Anything else stops startup, every wrong variable named at once. An integer is
digits with an optional leading minus and nothing else — `TELEGRAM_DIGEST_HOUR=-1`
is how the daily summary is switched off; `1e3`, `12abc` and `1.0` are refused.

The declaration is `src/config/configuration.ts`; the kinds of setting are
`src/config/settings.ts`. The monitor's Veeam account is a Veeam setting and
lives in the `veeam` block; the `telegram` block is Telegram's alone.

## Orphaned chain

A backup chain no live job owns — the job was deleted, what it produced stayed.
Not automatically garbage: a chain kept deliberately after a job was retired
looks exactly like one nobody remembers.
