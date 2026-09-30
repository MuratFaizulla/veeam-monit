# 1. Three session filters answer three questions; schedules live in the Evidence

Date: 2026-09-30 · Status: accepted

## Context

An architecture review proposed one module for "a job's Runs with its retry
policy", on the grounds that sessions are turned into attempts in three places
with three different filters, and that the retry policy is read from the
Evidence by some readers and from the job's configuration by others. It also
proposed taking `schedulesByJob` off the Evidence as configuration that does
not belong there.

The one harm behind it was real: an alert that read a run whose newest attempt
was still going called the run over ("повторов больше не будет"). That was
fixed where the rule lives, in `standingOf` (`src/estate/runs.ts`): an attempt
with no end is the next attempt of the failed run it follows, never its end.

## Decision

The filters stay different, because each answers a different question:

- **Placing restore points** (`jobRuns`, `runWindows` in the Evidence) keeps
  sessions that have not ended: a point is written by a session while it runs,
  and must be placed in it.
- **The failure streak** in 🛡 counts finished Runs of the last seven days: it
  is about a job that is broken now, and a run still going has not failed.
- **The Job card's run list** shows finished Runs; the one going is the ▶️ line
  above it.

Folding them into one filter would make one of the three answers wrong. What is
shared is already shared: which sessions are one Run is `runsOf`, and the
retry window is `retryWindowOf`.

The retry policy is read where it is cheapest for each reader: the Job card
reads the job's configuration anyway, for its settings; an alert takes the
Evidence's copy when a scan has finished, and the configuration otherwise.
Both are the same Veeam data.

`schedulesByJob` stays on the Evidence. The Evidence is defined (CONTEXT.md) as
what one reading of the estate established, job configurations included —
whether a job was supposed to run at all is part of it.

## Consequences

A future review that finds three session filters should read them as three
questions before proposing one. A reader that needs "the Runs of a job" writes
its own filter and hands the result to `runsOf`; a new rule about what an
attempt *is* — like the unfinished one — goes in `runs.ts`, where all three
readers get it.

The streak re-grouping sessions rather than reusing the Evidence's own Runs is
left to the Evidence's internal seams, if they are ever named.

Update, 2026-09-30: they were (`src/estate/evidence.ts`). The placing of
points and the streak now start from one grouping of a job's sessions, newest
first, and each keeps its own filter: every attempt for the placing, finished
attempts of the last seven days for the streak.
