import { Logger } from '@nestjs/common';
import { Evidence } from '../estate/backup-evidence.service';
import { FailedObject, JobSession } from '../estate/job-card';
import { iconOf, isBadResult, isDisabled, isRunning, statusOf } from '../estate/job-state';
import { RunStanding, standingOf } from '../estate/runs';
import { ServerEstate } from '../estate/server-estates';
import { JobResults } from '../telegram/job-results';
import { RetryingRun, RetryingRuns } from '../telegram/retrying-runs';
import { DeliveryReport } from '../telegram/telegram.service';
import { dayOf, momentOf } from '../telegram/time';
import { NotificationEvent, NotificationSeverity } from '../telegram/types';
import { jobStatusWord, jobTypeWord, resultWord } from '../telegram/words';
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
    const { results, retrying } = this.memory;
    // An empty record means this server has never been observed: a new
    // installation, or a server just added to the list.
    const seeding = !results.seeded();
    const transitions = jobTransitions(jobs, (id) => results.of(id), seeding);

    for (const transition of transitions) {
      const { job, severity, remember } = transition;
      if (severity) {
        const followed = retrying.of(job.id);
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
        if (next) retrying.follow(job.id, next);
        else retrying.forget(job.id);
      }
      results.record(job.id, remember);
    }

    const ids = new Set(jobs.map((job) => job.id));
    results.keepOnly(ids);
    retrying.keepOnly(ids);
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
    const { retrying } = this.memory;
    const followed = retrying.of(job.id);
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
      retrying.follow(job.id, next);
      return;
    }
    const report = await this.send(await this.eventOf({ job, result: 'failed', severity: 'critical' }, run, true));
    if (report.outcome !== 'failed') retrying.forget(job.id);
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
    const { job, result, previous, severity } = transition;
    const { name } = job;
    const recovery = severity === 'success';
    const title = recovery
      ? `${name}: задание восстановлено`
      : final
        ? `${name}: ОШИБКА, повторов больше не будет`
        : `${name}: ${result === 'failed' ? 'ОШИБКА' : 'предупреждение'}`;

    // Written as every other message writes a moment — "сегодня в 01:21", in
    // the operator's zone — not as Veeam's own string, offset and fractions of
    // a second included, which nobody reads at three in the morning.
    const clock = { now: new Date(this.now()), timezone: this.settings.timezone };
    const when = (iso: string | undefined): string | undefined => (iso ? dayOf(iso, clock) : undefined);

    // The attempt that went wrong, and which of its machines did and why.
    const bad = recovery ? undefined : run?.sessions.find((session) => isBadResult(session.result ?? ''));
    const objects = bad ? await this.server.jobs.objectsOf(bad) : [];

    return {
      kind: 'job',
      severity,
      subject: name,
      title,
      fields: [
        ['Результат', resultWord(result)],
        // The last word on a run already announced: what came before is in that alert.
        ['Было', final ? undefined : resultWord(previous) ?? '—'],
        ['Попытка', run ? attemptLine(run.standing, result, (at) => momentOf(at, clock)) : undefined],
        ['Тип', jobTypeWord(job.type)],
        // Not running is what every job an alert is about is doing; only
        // another status — switched off, say — tells anybody anything.
        ['Статус', IDLE.has(statusOf(job)) ? undefined : jobStatusWord(job.status)],
        ['Последний запуск', when(job.lastRun)],
        ['Следующий запуск', when(job.nextRun)],
        ['Объектов', job.objectsCount],
      ],
      body: recovery ? undefined : objectsBody(objects, (bad ?? run?.sessions[0])?.message),
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

/** What is remembered about one server's jobs, from one cycle to the next and across a restart. */
export interface JobMemory {
  /** The result each job was last reported with. */
  results: JobResults;
  /** The failed runs Veeam was still retrying when announced. */
  retrying: RetryingRuns;
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

/** Statuses of a job that is simply not running, lower-cased: nothing an alert needs to say. */
const IDLE = new Set(['inactive', 'stopped']);

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

/** Objects listed per group; the rest are counted. */
const OBJECTS_SHOWN = 5;

/** A reason longer than this is cut: the head of it is what says what broke. */
const REASON_SHOWN = 300;

/**
 * "2 из 4 · Veeam повторит ≈ сегодня в 04:33", "4 из 4 · повторов больше не
 * будет", or nothing when there is nothing to count.
 *
 * "Попытка: 1 из 4" was on every failure alert, because a failure is announced
 * after its first attempt; whether Veeam would try again, and when, was not.
 * `when` writes an epoch-ms moment as the rest of the message writes moments.
 */
export const attemptLine = (
  standing: RunStanding,
  result: string,
  when: (at: number) => string,
): string | undefined => {
  const { attempt, allowed, retryAt } = standing;
  const count = allowed ? `${attempt} из ${allowed}` : String(attempt);
  // Veeam retries a failure only. A warning or a success ends the run, and its
  // count is worth saying only when retries came before it; so is a failure's
  // when the job's policy could not be read and nothing is known of what next.
  if (result !== 'failed' || !allowed) return attempt > 1 ? count : undefined;
  if (standing.inFlight) return `${count} · повтор уже идёт`;
  if (retryAt !== undefined) return `${count} · Veeam повторит ≈ ${when(retryAt)}`;
  return `${count} · повторов больше не будет`;
};

/**
 * The machines that went wrong, each with its reason, or `message` — the
 * session's own — when Veeam named none: a run that never reached its machine
 * starts no task for it, and then the session message is the whole story.
 * That message, for a machine that failed, is "Processing EMMDB1-T3Q4": its
 * name, and not a word about why — which is why the machines are listed.
 *
 * Plain text: it is sent as the alert's preformatted block, which is also what
 * lets an error be copied whole into a search or a ticket.
 */
export const objectsBody = (objects: FailedObject[], message?: string): string | undefined => {
  const failed = objects.filter((object) => object.result === 'failed');
  const warned = objects.filter((object) => object.result === 'warning');
  if (failed.length + warned.length === 0) return message;

  const lines: string[] = [];
  const group = (title: string, list: FailedObject[]): void => {
    if (list.length === 0) return;
    if (lines.length > 0) lines.push('');
    lines.push(`${title}: ${list.length} из ${objects.length}`);
    for (const object of list.slice(0, OBJECTS_SHOWN)) {
      const why = object.message ? ` — ${clip(object.message)}` : '';
      lines.push(`${iconOf(object.result ?? '')} ${object.name}${why}`);
    }
    if (list.length > OBJECTS_SHOWN) lines.push(`… и ещё ${list.length - OBJECTS_SHOWN}`);
  };
  group('Не прошли', failed);
  group('С предупреждением', warned);
  return lines.join('\n');
};

const clip = (text: string): string =>
  text.length <= REASON_SHOWN ? text : `${text.slice(0, REASON_SHOWN - 1).trimEnd()}…`;
