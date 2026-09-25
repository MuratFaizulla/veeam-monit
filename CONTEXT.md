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

Evidence is either **ready** or **pending**, and pending carries the reason a
slot can show. There is no third state and no sentinel: "never scanned" and
"Veeam did not answer this cycle" are both pending, with different reasons.

Owned by `src/monitor/backup-evidence.service.ts`. Readers take it as
an argument; nothing reads it out of a field.

Refreshed once per cycle, as its own step, right after the job list is read
and before anything reads it — the alerts as much as the live slots. It used
to be refreshed by the live step, which runs last, so the alerts read the
previous cycle's evidence; after a cycle Veeam did not answer that was
pending, and the first alert after the outage lost the job's retry policy.

## Run

One execution of a Veeam job, *including its automatic retries*. Not a session.

Veeam retries a failed job on its own and each attempt is a separate session, so
a job with the default three retries reports four failed sessions for one failed
Run. Everything the bot counts — failure streaks, missed backups, retained
history — counts Runs.

A Run **succeeded** if the attempt that finished it succeeded, whatever the
earlier attempts did. One that ended in a warning did not succeed.

Which sessions are one Run is decided in one place, `src/monitor/runs.ts`,
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

Owned by `src/monitor/job-standing.ts`.

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

Owned by `src/monitor/repository-capacity.ts`. The 💾 slot renders what
it is given, like every other live slot.

## Live slot

A topic holding exactly one message, edited in place rather than appended to.
State, not events. 🗂 Restore points is the exception that holds two, because
the list does not fit in Telegram's limit.

Declared once in `src/live/slots.ts`: whether it is **pinned**,
whether it gets a **heartbeat** rewrite when its content has not changed, and
whether it addresses a thread somebody created by hand. The slot names come from
that declaration, including the type and the config record.

Pinned and heartbeat are opposites today and should stay that way: rewriting a
pinned message to move its timestamp is churn the whole room sees.

Every slot ends on one footer line, "Обновлено …", written by `footerOf` and
recognised by `isFooter` in `src/live/format.ts`. The live module leaves that
line out when deciding whether a slot changed, so a renderer that spelled the
footer itself would rewrite its message every cycle. Fitting a slot under
Telegram's limit is `fitted` or `paged`, never a loop of the renderer's own.

What every slot says after a cycle is decided in one place,
`src/live/snapshots.service.ts`: a cycle's jobs, repositories, token and the
monitor's own health go in, one page per slot comes out, in publishing order.
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

What a command needs from the monitor — its health, a pass on demand, the
**Summary** and a **Job card** — it asks through `Monitor` in
`src/monitor/monitor.ts`, not through the monitor class. The HTTP surface does
the same. Two adapters sit behind that seam: `MonitorService`, and the idle
monitor the tests use for a world with no Veeam, which a test keeps in step
with the real one.

Owned by `src/telegram/updates.service.ts`.

## Attempt

Veeam retries a failed job by starting another session, so one bad night is
three or four sessions. Two of them are the same **Run** when the newer started
inside the retry window of the older finishing — the job's own `awaitMinutes`
plus an allowance for how long the failing attempt took.

The alert says which attempt it is ("2 из 4"), because three messages a night
with identical text were three attempts at one run and nothing said so.

Distinct from the remembered result, which is what stops the repeats: a job
reports `none` while a retry runs, and recording that over `failed` made the
next failure look like a new one. `none` is not a result — see
`rememberedResult`. The same mistake lost every recovery, whose definition is
"the previous result was bad".

Owned by `src/monitor/runs.ts`, with the **Run** it is an attempt at.

## Transition

A job's result changing from what the monitor remembers, and the alert that
change is worth: into `failed` is critical, into `warning` is a warning, and
into `success` is worth a message only as a recovery from something bad. A
running retry reports `none`, which is not a result and changes nothing.

Deciding is separate from sending. `src/monitor/transitions.ts` says what is
owed and what to remember; the monitor sends it and records the result only
once the alert was delivered — a delivery that reached nobody has not dealt
with anything, so the transition stays pending and is tried again next cycle.

Repositories have the same split in `src/monitor/repository-alarms.ts`: below
the threshold warns, below half of it is critical, back above it re-arms. The
hour the daily **Summary** goes out is `digestDue`, in `TELEGRAM_TIMEZONE`.

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
same estate at the same moment.

Owned by `src/monitor/digest.ts`.

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

Every live slot is an aggregate; this is the only thing in the service that
answers about a single job. The name is matched approximately — whole name,
then containment, then every word of the query appearing somewhere — because
the name arrives half-remembered. Several matches are listed, never resolved by
guessing.

Owned by `src/monitor/job-card.ts`.

## Inventory

The names behind the ids a job points at — repositories and proxies. A job
configuration says `backupRepositoryId: 60df9772-…` and nothing else, and no
part of that is worth showing anybody.

Read once and kept for half an hour, because this is the part of the estate
that does not change. A failed read keeps the previous names rather than
clearing them: last month's name is far closer to the truth than a GUID.

Owned by `src/veeam/inventory.service.ts`.

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

The message ids of **Answers** the bot has sent, per chat and topic, so
`/clear` has something to take back.

It exists because the Bot API offers no way to clear a chat: a bot can delete a
message only by id, cannot enumerate history, and loses the right after 48
hours. The set it can ever remove is therefore exactly the set it wrote down as
it sent — which is why only `TelegramUpdatesService.send` records, and alerts
and **Live slot** messages, sent by other modules, are structurally out of
reach rather than excluded by a rule somebody has to remember.

Scoped by thread: clearing one topic must not reach into the next, where
somebody may be mid-conversation.

Newest 500 per chat, entries older than 48 hours dropped on read.

Owned by `src/telegram/answer-log.ts`. It is persisted in the state file
like everything else, but the state store only hands it its part of the file
and a way to save; the rules above live in the answer log. Job results,
cooldowns and live messages are split out the same way — `store.jobResults`,
`store.cooldowns`, `store.liveMessages` — and the store itself keeps only the
file, the chats and the forum topics.

## Button

One offered next step under an answer. What it means travels in Telegram's
`callback_data`, capped at 64 bytes — so a job is addressed by its GUID and
never by its name, and a button opens the job it was labelled with even if the
estate changed between the message and the press.

The encoding and its reader are one module, `src/telegram/keyboard.ts`, because
they are one decision seen twice. Written apart they drift, and nothing fails
until somebody presses one in production. An action the running version does
not recognise — a button on an older message — is acknowledged and ignored
rather than answered by guess.

The **command menu** is the neighbouring idea: the list registered with
`setMyCommands` at startup, which Telegram shows beside the input field. It is
the only place the bot's commands are discoverable without reading `/help`.

## Orphaned chain

A backup chain no live job owns — the job was deleted, what it produced stayed.
Not automatically garbage: a chain kept deliberately after a job was retired
looks exactly like one nobody remembers.
