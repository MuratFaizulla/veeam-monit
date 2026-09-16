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

## Run

One execution of a Veeam job, *including its automatic retries*. Not a session.

Veeam retries a failed job on its own and each attempt is a separate session, so
a job with the default three retries reports four failed sessions for one failed
Run. Everything the bot counts — failure streaks, missed backups, retained
history — counts Runs.

A Run **succeeded** if the attempt that finished it succeeded, whatever the
earlier attempts did.

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

Owned by `src/telegram/updates.service.ts`.

## Summary

Where every job stands, counted in one pass over the job list: how many
succeeded, warned, failed, are running, have never run, and which jobs are
behind the bad numbers.

It is a **standing**, not a period. "Сводка за сутки" was the old name and the
wrong claim: nothing is windowed, every figure comes from each job's own
`lastResult`, and a job that failed on Friday and has not run since is still
counted as failed on Monday. That is the point of it — 🚨 Alerts reports
**transitions**, so a permanently broken job appears there once and never again.

Counted in `src/monitor/digest.ts`, seen twice: pushed as an event at
`TELEGRAM_DIGEST_HOUR`, and pulled by `/digest`.

## Job card

Everything known about one job, gathered for somebody who asked about it by
name: its last result and the reason, its next scheduled run, its restore-point
depth and cadence from the last **Evidence** scan, and its recent **Runs**.

Every live slot is an aggregate; this is the only thing in the service that
answers about a single job. The name is matched approximately — whole name,
then containment, then every word of the query appearing somewhere — because
the name arrives half-remembered. Several matches are listed, never resolved by
guessing.

Owned by `src/monitor/job-card.ts`.

## Answer

What a command produces, as opposed to an **event**. An answer is sent back to
the chat and thread the question was asked in; an event goes through routing to
the topic its kind and severity imply.

The distinction is load-bearing for `/digest`: routed as an event, a summary
with nothing wrong in it would be delivered to the recoveries topic by its
severity, nowhere near whoever asked.

## Orphaned chain

A backup chain no live job owns — the job was deleted, what it produced stayed.
Not automatically garbage: a chain kept deliberately after a job was retired
looks exactly like one nobody remembers.
