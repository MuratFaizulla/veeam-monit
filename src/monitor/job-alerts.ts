import { Logger } from '@nestjs/common';
import { Evidence } from '../estate/evidence';
import { FailedObject, JobSession } from '../estate/job-card';
import { isBadResult, isDisabled, isRunning } from '../estate/job-state';
import { RunStanding, standingOf } from '../estate/runs';
import { ServerEstate } from '../estate/server-estates';
import { JobMemory, RetryingRun } from '../telegram/job-memory';
import { escapeHtml } from '../telegram/format';
import { DeliveryReport } from '../telegram/telegram.service';
import { Clock, dayOfEn, durationEn } from '../telegram/time';
import { NotificationEvent, NotificationSeverity } from '../telegram/types';
import { jobTypeWordEn } from '../telegram/words';
import { Job } from '../veeam/estate';
import { VeeamSchedule } from '../veeam/types';
import { jobTransitions, Transition } from './transitions';

/**
 * Job alerts: everything the bot says about one server's jobs in 🚨 Alerts and
 * 🟢 Recovered, and when.
 *
 * A cycle hands over the job list and the Evidence; out of it come the
 * alerts, sent, and what to remember once each is delivered. What is behind
 * that one call — which change is worth a message (a **Transition**), which
 * failed run Veeam is still retrying and how it ended (a **Retrying run**),
 * where the job's retry policy comes from, the attempt line, the machines that
 * went wrong — used to be private methods of the monitor and a handful of
 * modules around them, reachable only through a whole monitor cycle. A script
 * that wanted to show what an alert looks like had to copy the field list by
 * hand, and the copy drifted within the day.
 *
 * Sending is handed in, so the rule "remember only what was delivered" lives
 * here, beside what is remembered. A delivery that reached nobody has not
 * dealt with anything, and is tried again next cycle.
 *
 * One per Veeam server, built by the monitor beside the server it watches.
 */
export class JobAlerts {
  private readonly logger = new Logger(JobAlerts.name);
  private readonly now: () => number;

  constructor(
    private readonly server: Pick<ServerEstate, 'name' | 'jobs'>,
    private readonly memory: JobMemory,
    private readonly send: Send,
    private readonly settings: JobAlertsSettings,
  ) {
    this.now = settings.now ?? Date.now;
  }

  /** Announces what changed since what is remembered about this server's jobs. */
  async check(jobs: Job[], evidence: Evidence): Promise<void> {
    const { memory } = this;
    // Nothing remembered means this server has never been observed: a new
    // installation, or a server just added to the list.
    const seeding = !memory.seeded();
    const transitions = jobTransitions(jobs, (id) => memory.resultOf(id), seeding);

    for (const transition of transitions) {
      const { job, severity, remember } = transition;
      if (severity) {
        const followed = memory.retryingOf(job.id);
        // A recovery needs no attempt, unless it is a retry that worked.
        const run = severity === 'success' && !followed ? undefined : await this.runOf(job, evidence);
        const report = await this.send(await this.eventOf({ ...transition, severity }, run));
        // Advancing the remembered result is the record of "this transition has
        // been dealt with". A delivery that reached nobody has not dealt with
        // anything, so the transition stays pending and is retried next tick.
        if (report.outcome === 'failed') continue;
        // Followed while Veeam has attempts left; any other change of result
        // ends the run, and this alert has said how.
        const next = severity === 'critical' ? run && retryingRunOf(job, run.standing) : undefined;
        if (next) memory.follow(job.id, next);
        else memory.unfollow(job.id);
      }
      memory.remember(job.id, remember);
    }

    memory.keepOnly(new Set(jobs.map((job) => job.id)));
    for (const job of jobs) await this.followRetry(job, evidence);

    if (seeding) {
      this.logger.log(
        `Veeam monitor seeded with ${jobs.length} job states on ${this.server.name}, alerts start next cycle`,
      );
    }
  }

  /**
   * Says how a failed run ended, once Veeam has stopped retrying it.
   *
   * The job list shows nothing of a retry that failed: the result was
   * "failed" and stays "failed". What moves is the job's last run, when the
   * next attempt starts — so the run is read again only then, or once the
   * wait for an attempt has run out without one, and costs nothing between.
   */
  private async followRetry(job: Job, evidence: Evidence): Promise<void> {
    const { memory } = this;
    const followed = memory.retryingOf(job.id);
    // Any other result is a change the alerts have already dealt with, and
    // an attempt in flight has nothing to say yet.
    if (!followed || job.result !== 'failed' || isRunning(job)) return;
    const waiting = followed.retryBy !== undefined && this.now() <= followed.retryBy;
    if (job.lastRun === followed.lastRun && waiting) return;

    // Whichever run is newest now: should the one followed have ended out of
    // sight — the bot down through a whole night — the job list shows the
    // next one's failure, and that is the run to finish the story of.
    const run = await this.runOf(job, evidence);
    if (run.sessions[0] && !run.sessions[0].endedAt) return;
    const next = retryingRunOf(job, run.standing);
    if (next) {
      memory.follow(job.id, next);
      return;
    }
    const report = await this.send(await this.eventOf({ job, result: 'failed', severity: 'critical' }, run, true));
    if (report.outcome !== 'failed') memory.unfollow(job.id);
  }

  /**
   * One job alert. `run` is the job's newest run as `runOf` read it; a
   * recovery goes without one unless it came from a retry. `final` is the
   * word on a run already announced, once Veeam has stopped retrying it.
   */
  private async eventOf(
    transition: Pick<Transition, 'job' | 'result' | 'previous'> & { severity: NotificationSeverity },
    run: JobRun | undefined,
    final = false,
  ): Promise<NotificationEvent> {
    const { job, result, severity } = transition;
    const recovery = severity === 'success';
    // Written in the operator's zone, "today at 01:21" — not as Veeam's own
    // string, offset and fractions of a second included, which nobody reads
    // at three in the morning.
    const clock = { now: new Date(this.now()), timezone: this.settings.timezone };

    // The attempt the alert is about: the one that went wrong, or for a
    // recovery the one that worked; and how its machines ended, and why.
    const attempt = recovery
      ? run?.sessions[0]
      : run?.sessions.find((session) => isBadResult(session.result ?? '')) ?? run?.sessions[0];
    const objects = attempt && !recovery ? await this.server.jobs.objectsOf(attempt) : [];
    const outcome = recovery
      ? 'succeeded'
      : result === 'failed'
        ? final ? 'failed, no more retries' : 'failed'
        : 'finished with warnings';

    const details = detailsOf(job, attempt, clock);
    const machines = recovery ? [] : machineLines(objects, attempt?.message);
    // Veeam retries a failure only; after a warning or a success comes the schedule.
    const next = result === 'failed' ? nextLine(run?.standing, final, job.nextRun, clock) : undefined;
    // Under the title the details, then a blank line before each part that follows.
    const lines = [details ? [`<i>${escapeHtml(details)}</i>`] : [], machines, next ? [next] : []]
      .filter((part) => part.length > 0)
      .flatMap((part, index) => (index === 0 ? part : ['', ...part]));

    return {
      kind: 'job',
      severity,
      subject: job.name,
      title: `${job.name}${labelOf(run, attempt, objects)} — ${outcome}`,
      lines,
      // One message per job per transition; the cooldown only guards against a
      // job flapping between two results within the window.
      dedupeKey: `job:${job.id}:${result}${final ? ':final' : ''}`,
      cooldownMs: this.settings.cooldownMs,
    };
  }

  /**
   * The job's newest sessions and where its run stands. One read answers
   * both, and the reason the run failed besides.
   */
  private async runOf(job: Job, evidence: Evidence): Promise<JobRun> {
    const sessions = await this.server.jobs.recentSessions(job);
    const schedule = await this.retryPolicyOf(job, evidence);
    // A job switched off in Veeam keeps its schedule, and runs only because
    // somebody started it by hand — which Veeam never retries. Promising
    // "Veeam повторит" and then waiting half an hour to take it back was what
    // a failed manual run got.
    const retried = schedule && isDisabled(job) ? { ...schedule, runAutomatically: false } : schedule;
    return { sessions, standing: standingOf(sessions, retried, this.now()) };
  }

  /**
   * The job's schedule, retry policy included: from the Evidence when a scan
   * has finished, otherwise from the job's own configuration.
   *
   * The scan already reads every job configuration, so it is the free answer.
   * But after a restart the Evidence is pending until the first scan finishes,
   * a scan can fail outright, a job created since the last scan is not in it,
   * and a server nobody has selected is not scanned at all; the alert used to
   * lose "из 4" for as long as any of that lasted. One request per alert is
   * cheap next to that. Best effort: an alert without the policy is still an
   * alert.
   */
  private async retryPolicyOf(job: Job, evidence: Evidence): Promise<VeeamSchedule | undefined> {
    // A job created after the last scan is not in it, however ready it is.
    const scanned = evidence.status === 'ready' ? evidence.schedulesByJob.get(job.id) : undefined;
    return scanned ?? (await this.server.jobs.configurationOf(job))?.schedule;
  }
}

/** Sends one alert and says what became of it; only whether it reached nobody matters here. */
export type Send = (event: NotificationEvent) => Promise<Pick<DeliveryReport, 'outcome'>>;

export interface JobAlertsSettings {
  /** IANA zone the moments are written in, or empty for the server's own. */
  timezone: string;
  /** How long the same alert about the same job is not repeated. */
  cooldownMs: number;
  /** Epoch ms; the clock, for a test that needs the wait to have run out. */
  now?: () => number;
}

/** A job's newest sessions, newest first, and where its newest run stands. */
interface JobRun {
  sessions: JobSession[];
  standing: RunStanding;
}

/** The run to follow, when Veeam is retrying it or still due to. */
const retryingRunOf = (job: Job, standing: RunStanding): RetryingRun | undefined => {
  // Nothing to wait for while an attempt runs: it is read again as soon as
  // the job stops running.
  if (standing.inFlight) return { attempt: standing.attempt, lastRun: job.lastRun };
  if (standing.retryBy === undefined) return undefined;
  return { attempt: standing.attempt, lastRun: job.lastRun, retryBy: standing.retryBy };
};


/** Machines listed per kind; the rest are counted. */
const OBJECTS_SHOWN = 5;

/** A reason longer than this is cut: the head of it is what says what broke. */
const REASON_SHOWN = 300;

/**
 * "(retry 1)", "(Full)", "(Full, retry 2)", as Veeam's console names the
 * session; nothing for the first attempt at an incremental run.
 *
 * "Попытка: 1 из 4" was on every failure alert, because a failure is announced
 * after its first attempt, and it said nothing anybody acted on.
 */
const labelOf = (run: JobRun | undefined, attempt: JobSession | undefined, objects: FailedObject[]): string => {
  const parts: string[] = [];
  if (isFull(objects)) parts.push('Full');
  const retry = run && attempt ? attemptNumberOf(run, attempt) - 1 : 0;
  if (retry > 0) parts.push(`retry ${retry}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
};

/**
 * Which attempt of its run `attempt` was. The standing counts the newest
 * session; the one an alert is about can be the one before it, when the next
 * attempt is already going.
 */
const attemptNumberOf = ({ sessions, standing }: JobRun, attempt: JobSession): number =>
  Math.max(1, standing.attempt - Math.max(0, sessions.indexOf(attempt)));

/**
 * A run is a Full when most of its machines took one: a machine added to a
 * job takes its first Full on an incremental night, and that night was not
 * one. Only where Veeam said; a server whose REST API has no task sessions
 * (1.1) does not.
 */
const isFull = (objects: FailedObject[]): boolean => {
  const known = objects.filter(({ algorithm }) => algorithm === 'full' || algorithm === 'increment');
  return known.length > 0 && known.filter(({ algorithm }) => algorithm === 'full').length * 2 > known.length;
};

/** "VM backup · started today at 03:02 · ran 42 min", and that the job is switched off when it is. */
const detailsOf = (job: Job, attempt: JobSession | undefined, clock: Clock): string => {
  const startedAt = attempt?.startedAt ?? job.lastRun;
  const ran = Date.parse(attempt?.endedAt ?? '') - Date.parse(attempt?.startedAt ?? '');
  return [
    jobTypeWordEn(job.type),
    startedAt ? `started ${dayOfEn(startedAt, clock)}` : undefined,
    Number.isFinite(ran) && ran >= 0 ? `ran ${durationEn(ran)}` : undefined,
    // It runs only when somebody starts it, and Veeam never retries that.
    isDisabled(job) ? 'disabled in Veeam' : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
};

/**
 * A line for each machine that went wrong, and why in Veeam's words; or
 * `message`, the session's own, when Veeam named none: a run that never
 * reached its machine starts no task for it, and then the session message is
 * the whole story. That message, for a machine that failed, is "Processing
 * APPDB1-T3Q4": its name, and not a word about why — which is why the
 * machines are listed.
 */
export const machineLines = (objects: FailedObject[], message?: string): string[] => {
  const failed = objects.filter((object) => object.result === 'failed');
  const warned = objects.filter((object) => object.result === 'warning');
  if (failed.length + warned.length === 0) return message ? [escapeHtml(clip(message))] : [];

  const lines: string[] = [];
  const list = (icon: string, which: FailedObject[], more: string): void => {
    for (const object of which.slice(0, OBJECTS_SHOWN)) {
      const why = object.message ? ` — ${escapeHtml(clip(object.message))}` : '';
      lines.push(`${icon} <b>${escapeHtml(object.name)}</b>${why}`);
    }
    if (which.length > OBJECTS_SHOWN) lines.push(`… and ${which.length - OBJECTS_SHOWN} more ${more}`);
  };
  list('❌', failed, 'failed');
  list('⚠️', warned, 'with warnings');
  const fine = objects.length - failed.length - warned.length;
  if (fine > 0) lines.push(`✅ ${fine} other ${fine === 1 ? 'machine' : 'machines'} — no errors`);
  return lines;
};

/**
 * What happens next to a failed run: "🔁 Veeam will retry ≈ today at 03:54
 * (retry 1).", "🔁 Retry 1 is running now.", "⛔ No more retries. Next
 * scheduled run: today at 22:00." — or the next scheduled run alone, when
 * Veeam does not retry the job or its policy could not be read.
 *
 * Whether Veeam will try again is what decides between waiting and going to
 * look, so it closes the alert, apart from the rest.
 */
export const nextLine = (
  standing: RunStanding | undefined,
  final: boolean,
  nextRun: string | undefined,
  clock: Clock,
): string | undefined => {
  const scheduled = nextRun ? `Next scheduled run: ${dayOfEn(nextRun, clock)}.` : '';
  if (standing?.allowed && !final) {
    if (standing.inFlight) return `🔁 Retry ${standing.attempt - 1} is running now.`;
    if (standing.retryAt !== undefined) {
      const at = dayOfEn(new Date(standing.retryAt).toISOString(), clock);
      return `🔁 Veeam will retry ≈ ${at} (retry ${standing.attempt}). If it succeeds, a recovery message follows.`;
    }
  }
  if (final || standing?.allowed) return `⛔ No more retries.${scheduled ? ` ${scheduled}` : ''}`;
  return scheduled ? `⏭ ${scheduled}` : undefined;
};

const clip = (text: string): string =>
  text.length <= REASON_SHOWN ? text : `${text.slice(0, REASON_SHOWN - 1).trimEnd()}…`;
