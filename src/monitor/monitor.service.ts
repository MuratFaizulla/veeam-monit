import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { Job, WorkingSessions, workingUnavailable } from '../veeam/estate';
import { DeliveryReport, TelegramService } from '../telegram/telegram.service';
import { TelegramLiveService } from '../live/live.service';
import { RETIRED_SLOTS } from '../live/slots';
import { LiveCycle, LiveSnapshotsService } from '../live/snapshots.service';
import { TelegramStateStore } from '../telegram/state.store';
import { NotificationEvent } from '../telegram/types';
import { capacities, RepositoryCapacity } from '../estate/repository-capacity';
import { addressable, digestDue, digestEvent, summarise } from '../estate/digest';
import { repositoryAlarms } from './repository-alarms';
import { JobAlerts } from './job-alerts';
import { escapeHtml, renderEvent } from '../telegram/format';
import { Answer } from '../estate/answer';
import { Monitor, MonitorHealth, Selection, ServerStatus } from './monitor';
import { ServerEstate, ServerEstates } from '../estate/server-estates';

const HOUR = 3_600_000;

export type { Answer, MonitorHealth } from './monitor';

/** What the monitor remembers about one server from one pass to the next. */
interface Watch {
  estate: ServerEstate;
  lastReachable?: boolean;
  lastAuthenticated?: boolean;
  lastCheckAt: string | null;
  reachable: boolean | null;
  authenticated: boolean | null;
  lastError: string | null;
  jobs?: ServerStatus['jobs'];
  /** What the bot says about this server's jobs. */
  alerts: JobAlerts;
}

/** What one server's pass found, for the live slots when it is the one shown. */
type Pass = Omit<LiveCycle, 'health' | 'server'>;

/**
 * Polls every Veeam server and turns what changed into notification events.
 *
 * Three independent signals are checked on each server, because they fail
 * independently and an operator needs to tell them apart: the API answering at
 * all, the monitor service account being able to log in, and the jobs
 * themselves. The previous version folded the second into the first, so an
 * expired monitor password looked exactly like a healthy server with no
 * failing jobs.
 *
 * Every server is watched every cycle, whichever one is selected: a failure on
 * a server nobody is looking at is exactly the one that must not wait until
 * somebody does. What the selection decides is which server the live slots and
 * the commands show — and so which server pays for the reads only they need,
 * the Evidence scan above all.
 */
@Injectable()
export class MonitorService implements Monitor, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MonitorService.name);
  private readonly config: AppConfig['telegram'];
  private readonly watches: Watch[];
  /** Whether messages say which server they are about: only when there are several. */
  private readonly named: boolean;
  private timer?: NodeJS.Timeout;
  private running = false;
  /** A pass was asked for while one was running, and must follow it. */
  private again = false;
  private delivered = 0;
  private undelivered = 0;
  private lastOutcome: MonitorHealth['lastOutcome'] = null;

  constructor(
    config: ConfigService,
    estates: ServerEstates,
    private readonly telegram: TelegramService,
    private readonly store: TelegramStateStore,
    private readonly live: TelegramLiveService,
    private readonly snapshots: LiveSnapshotsService,
  ) {
    this.config = config.getOrThrow<AppConfig['telegram']>('telegram');
    this.watches = estates.all.map((estate) => {
      const watch: Watch = {
        estate,
        lastCheckAt: null,
        reachable: null,
        authenticated: null,
        lastError: null,
        alerts: new JobAlerts(
          estate,
          store.jobMemoryOf(estate.key),
          // Through the monitor's own sending, which names the server and
          // counts what was delivered.
          (event) => this.emit(watch, event),
          { timezone: this.config.timezone, cooldownMs: this.config.jobAlertCooldownMs },
        ),
      };
      return watch;
    });
    this.named = this.watches.length > 1;
  }

  onModuleInit(): void {
    // A server taken off the list is forgotten, rather than kept in the state
    // file for good in case it comes back.
    this.store.keepServers(new Set(this.watches.map((watch) => watch.estate.key)));
    if (!this.telegram.enabled || this.config.monitorIntervalMs <= 0) return;
    this.timer = setInterval(() => void this.check(), this.config.monitorIntervalMs);
    this.timer.unref();
    void this.check();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get status(): MonitorHealth {
    const watch = this.shown();
    return {
      lastCheckAt: watch.lastCheckAt,
      reachable: watch.reachable,
      authenticated: watch.authenticated,
      lastError: watch.lastError,
      trackedJobs: this.store.jobMemoryOf(watch.estate.key).count(),
      delivered: this.delivered,
      undelivered: this.undelivered,
      lastOutcome: this.lastOutcome,
    };
  }

  servers(): ServerStatus[] {
    const shown = this.shown();
    return this.watches.map((watch) => ({
      key: watch.estate.key,
      name: watch.estate.name,
      selected: watch === shown,
      reachable: watch.reachable,
      authenticated: watch.authenticated,
      address: watch.estate.http.address,
      jobs: watch.jobs,
      lastError: watch.lastError,
    }));
  }

  select(key: string): Selection {
    const watch = this.watchOf(key);
    if (!watch) return 'unknown';
    if (watch === this.shown()) return 'already';
    this.store.selectServer(key);
    // Its restore points too: they were last read when it was last shown.
    watch.estate.evidence.renew();
    // Drawn now rather than at the next tick: somebody just pressed a button
    // and is looking at the topics to see it take. A pass already running
    // draws the server it started with, so another follows it.
    if (this.running) this.again = true;
    else void this.check();
    return 'selected';
  }

  /**
   * One monitoring pass. Never throws: a bad cycle must not kill the timer.
   *
   * Returns whether this call was the pass. A cycle already in flight is
   * declined, and a caller that asked for a pass on purpose — the timer does
   * not care, but POST /check does — has no other way to tell that the health
   * it is about to read belongs to somebody else's cycle.
   */
  async check(): Promise<'ran' | 'busy'> {
    if (this.running) {
      // A slow Veeam answer must not let two passes interleave and report the
      // same transition twice.
      this.logger.debug('Previous Veeam check is still running, skipping this tick');
      return 'busy';
    }
    this.running = true;
    try {
      const shown = this.shown();
      // In parallel: one server that takes thirty seconds to answer must not
      // hold up another's alerts by thirty seconds.
      const passes = await Promise.all(this.watches.map((watch) => this.pass(watch, watch === shown)));
      const pass = passes[this.watches.indexOf(shown)];
      // Last, so it reports what this cycle actually found — including the
      // cycles where Veeam answered nothing at all.
      await this.step(shown, 'live', () => this.publishLive(shown, pass));
      return 'ran';
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        setImmediate(() => void this.check());
      }
    }
  }

  /**
   * Where every job of the Selected server stands, as a message somebody can
   * be handed.
   *
   * The same counting as the daily digest, pulled instead of pushed. It is
   * rendered here rather than emitted as an event on purpose: an event goes
   * through the router to the topic its severity implies, and a clean summary
   * asked for in General would land in the recoveries topic, where nobody who
   * asked for it is looking. An answer belongs where the question was.
   */
  async summary(): Promise<Answer> {
    const watch = this.shown();
    const read = await watch.estate.jobs.jobsNow();
    if (!read.ok) return this.answered(watch, { text: read.message });
    const working = await this.working(watch.estate);
    const summary = summarise(read.jobs, working.byJob, working.unavailable);
    return {
      // The very same event the daily message sends, rendered instead of
      // routed. Two renderings of one set of figures began to differ within a
      // day of existing; there is now nothing that can differ.
      text: renderEvent(this.labelled(watch, digestEvent(summary))),
      // The jobs that are not well are exactly the ones somebody reading this
      // is about to ask about, so the summary offers them rather than making
      // them be typed back in.
      jobs: addressable(summary),
      server: watch.estate.key,
    };
  }

  async describeJob(query: string): Promise<Answer> {
    const watch = this.shown();
    return this.answered(watch, await watch.estate.jobs.describeJob(query));
  }

  async describeJobById(id: string, server?: string): Promise<Answer> {
    // A Button names its server. One from before there was a list does not,
    // and the only server there was then is the first.
    const watch = (server === undefined ? undefined : this.watchOf(server)) ?? this.shown();
    return this.answered(watch, await watch.estate.jobs.describeJobById(id));
  }

  async describePoints(query: string): Promise<Answer> {
    const watch = this.shown();
    return this.answered(watch, await watch.estate.jobs.describePoints(query));
  }

  async describePointsById(id: string, server?: string): Promise<Answer> {
    const watch = (server === undefined ? undefined : this.watchOf(server)) ?? this.shown();
    return this.answered(watch, await watch.estate.jobs.describePointsById(id));
  }

  /* ---------------------------------------------------------------- *
   * Servers
   * ---------------------------------------------------------------- */

  /** The Selected server: the one chosen, or the first while nobody has chosen one that exists. */
  private shown(): Watch {
    const chosen = this.store.selectedServer();
    return (chosen === undefined ? undefined : this.watchOf(chosen)) ?? this.watches[0];
  }

  private watchOf(key: string): Watch | undefined {
    return this.watches.find((watch) => watch.estate.key === key);
  }

  /**
   * A key that is this server's alone: a cooldown, a remembered repository
   * alarm. With one server the keys are what they always were, so an upgrade
   * forgets nothing.
   */
  private scoped(watch: Watch, key: string): string {
    return this.named ? `${watch.estate.key}:${key}` : key;
  }

  /**
   * The event, saying which server it is about. First in the title, because
   * the title is what a notification on a locked phone shows.
   */
  private labelled(watch: Watch, event: NotificationEvent): NotificationEvent {
    if (!this.named) return event;
    return {
      ...event,
      title: `${watch.estate.name} · ${event.title}`,
      dedupeKey: event.dedupeKey === undefined ? undefined : this.scoped(watch, event.dedupeKey),
    };
  }

  /** An answer about one server, naming it and carrying its key for the Buttons under it. */
  private answered(watch: Watch, answer: Answer): Answer {
    if (!this.named) return { ...answer, server: watch.estate.key };
    return {
      ...answer,
      text: `🖥 <b>${escapeHtml(watch.estate.name)}</b>\n\n${answer.text}`,
      server: watch.estate.key,
    };
  }

  /* ---------------------------------------------------------------- *
   * One server's pass
   * ---------------------------------------------------------------- */

  private async pass(watch: Watch, shown: boolean): Promise<Pass> {
    const { estate } = watch;
    const reachable = await this.checkReachability(watch);
    const authenticated = reachable && (await this.checkAuthentication(watch));
    // Each step is isolated: one hiccup on /jobs/states used to abort the
    // rest of the cycle, taking the repository check and the digest with it.
    const jobs = authenticated ? await this.step(watch, 'jobs', () => estate.reader.jobStates()) : undefined;
    if (jobs) {
      const { total, failed, warning } = summarise(jobs, new Set());
      watch.jobs = { total, failed, warning };
    }
    const digest = Boolean(jobs) && this.digestDue(watch);

    // Once, beside the job list it is united with, and shared by everything
    // that counts running jobs: ▶️, 📈 and the daily Summary. A server nobody
    // is looking at needs it only on the one cycle a day its Summary goes out.
    const working = authenticated && (shown || digest) ? await this.working(estate) : undefined;
    // Said in the health too, and only here: /digest reads the same thing, and
    // a command asking its own question must not overwrite the cycle's health.
    if (working?.unavailable) watch.lastError = working.unavailable;

    // Once, before anything reads it — the alerts as much as the live slots.
    // It used to be refreshed by the live step, which runs last, so the
    // alerts read the previous cycle's evidence: after one cycle Veeam did
    // not answer, that was "pending", and the first alert after the outage —
    // the likeliest alert of all — lost the job's retry policy and said
    // "Попытка: 2" instead of "2 из 4".
    //
    // Only for the server shown: the scan is the heaviest read there is, and
    // what else reads it — an alert's retry policy — asks the job's own
    // configuration when there is no scan to answer from.
    if (shown) await estate.evidence.refresh(authenticated, jobs);
    const evidence = estate.evidence.evidence;

    let repositories: RepositoryCapacity[] | undefined;
    if (authenticated) {
      if (jobs) await this.step(watch, 'alerts', () => watch.alerts.check(jobs, evidence));
      repositories = await this.step(watch, 'repositories', () => this.checkRepositories(watch));
      if (jobs && working && digest) {
        await this.step(watch, 'digest', () => this.sendDigest(watch, jobs, working));
      }
    }
    watch.lastCheckAt = new Date().toISOString();
    return { jobs, working, repositories, authenticated, evidence };
  }

  /**
   * What Veeam is running right now. Never throws.
   *
   * A failed read is an empty one with the reason, which is the safe direction:
   * a running count falls back to the job status alone and never invents a run,
   * and 📈 says why it has nothing to show.
   */
  private async working(estate: ServerEstate): Promise<WorkingSessions> {
    try {
      return await estate.reader.workingSessions();
    } catch (error) {
      this.logger.warn(`${estate.name}: working sessions unavailable: ${(error as Error).message}`);
      return workingUnavailable((error as Error).message);
    }
  }

  private async step<T>(watch: Watch, name: string, run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch (error) {
      watch.lastError = (error as Error).message;
      this.logger.error(
        `Veeam monitor step "${name}" failed on ${watch.estate.name}: ${(error as Error).message}`,
      );
      return undefined;
    }
  }

  private async checkReachability(watch: Watch): Promise<boolean> {
    const { http } = watch.estate;
    const { reachable, serverTime, error } = await http.reachability();
    const detail = (reachable ? serverTime : error) ?? '';
    if (!reachable) watch.lastError = detail;
    watch.reachable = reachable;

    // Starting up is not an event. It used to be announced every time, which
    // put six "монитор запущен" messages in the chat over one afternoon of
    // restarts; the live health message answers the same question, once.
    if (watch.lastReachable !== undefined && watch.lastReachable !== reachable) {
      await this.emit(watch, {
        kind: 'infrastructure',
        severity: reachable ? 'success' : 'critical',
        title: reachable ? 'Veeam is reachable again' : 'Veeam is unreachable',
        fields: [
          ['Server', http.baseUrl],
          [reachable ? 'Server time' : 'Error', detail],
        ],
      });
    }
    watch.lastReachable = reachable;
    return reachable;
  }

  /**
   * Whether the monitor account can sign in. The token itself stays with the
   * auth service; the estate reader asks it for one on every request.
   *
   * A broken service account is reported once per cooldown instead of every
   * tick, and the recovery is announced so nobody has to check the log.
   */
  private async checkAuthentication(watch: Watch): Promise<boolean> {
    const { auth, http } = watch.estate;
    if (!auth.configured) {
      watch.authenticated = null;
      await this.emit(watch, {
        kind: 'infrastructure',
        severity: 'warning',
        title: 'Job monitoring is off',
        body: 'VEEAM_MONITOR_USERNAME / VEEAM_MONITOR_PASSWORD are not set, so the jobs are not checked.',
        dedupeKey: 'veeam:auth:unconfigured',
        cooldownMs: 24 * HOUR,
      });
      return false;
    }

    try {
      await auth.getAccessToken();
      watch.authenticated = true;
      if (watch.lastAuthenticated === false) {
        this.store.cooldowns.clear(this.scoped(watch, 'veeam:auth:failed'));
        await this.emit(watch, {
          kind: 'infrastructure',
          severity: 'success',
          title: 'Veeam: the monitor account signs in again',
          fields: [['Account', auth.username]],
        });
      }
      watch.lastAuthenticated = true;
      return true;
    } catch (error) {
      watch.authenticated = false;
      watch.lastError = (error as Error).message;
      watch.lastAuthenticated = false;
      await this.emit(watch, {
        kind: 'infrastructure',
        severity: 'critical',
        title: 'Veeam: the monitor account cannot sign in',
        fields: [
          ['Account', auth.username],
          ['Server', http.baseUrl],
        ],
        body: `${(error as Error).message}\n\nUntil it signs in, changes in the jobs' results are not followed.`,
        dedupeKey: 'veeam:auth:failed',
        cooldownMs: this.config.authAlertCooldownMs,
      });
      return false;
    }
  }

  /* ---------------------------------------------------------------- *
   * Live status
   * ---------------------------------------------------------------- */

  /**
   * Refreshes every live slot for the server shown. They are state rather
   * than events, so they are edited in place and never queue up behind the
   * alert pipeline.
   *
   * What each slot says is decided by the snapshots module; the monitor adds
   * the one input only it has — its own health — and sends the result.
   */
  private async publishLive(watch: Watch, pass: Pass): Promise<void> {
    const { estate } = watch;
    const pages = await this.snapshots.pages({
      ...pass,
      server: estate,
      health: {
        reachable: watch.reachable === true,
        authenticated: watch.authenticated,
        serverUrl: estate.baseUrl,
        serverAddress: estate.http.address,
        error: watch.lastError,
        trackedJobs: this.store.jobMemoryOf(estate.key).count(),
        intervalMs: this.config.monitorIntervalMs,
        servers: this.servers().map(({ name, selected, reachable, authenticated, address, jobs, lastError }) => ({
          name,
          selected,
          reachable,
          authenticated,
          address,
          jobs: jobs?.total,
          error: lastError,
        })),
      },
    });
    for (const { slot, content } of pages) await this.live.publish(slot, content);
    for (const slot of RETIRED_SLOTS) await this.live.retire(slot);
  }

  private async checkRepositories(watch: Watch): Promise<RepositoryCapacity[]> {
    let repositories: RepositoryCapacity[];
    try {
      repositories = capacities(await watch.estate.reader.repositoryStates());
    } catch (error) {
      this.logger.warn(
        `Repository capacity check skipped on ${watch.estate.name}: ${(error as Error).message}`,
      );
      throw error;
    }

    const { events, cleared } = repositoryAlarms(repositories, {
      thresholdPercent: this.config.repositoryFreePercent,
      cooldownMs: this.config.repositoryAlertCooldownMs,
    });
    for (const key of cleared) this.store.cooldowns.clear(this.scoped(watch, key));
    for (const event of events) await this.emit(watch, event);
    return repositories;
  }

  /** Whether this server's once-a-day roll-up is due and not yet sent. */
  private digestDue(watch: Watch): boolean {
    return (
      digestDue(new Date(), this.config.digestHour, this.config.timezone) &&
      !this.store.cooldowns.isSuppressed(this.scoped(watch, 'digest'))
    );
  }

  /** Once-a-day roll-up, so a quiet channel still proves the monitor is alive. One per server. */
  private async sendDigest(watch: Watch, jobs: Job[], working: WorkingSessions): Promise<void> {
    // The job list and the Working sessions this cycle already read. The list
    // used to be read a second time here, on the one cycle a day that most
    // wanted to be quick, and the sessions a third time.
    const summary = summarise(jobs, working.byJob, working.unavailable);
    const report = await this.emit(watch, digestEvent(summary));

    // Arming before the fetch, as this used to, lost the whole digest for 23
    // hours whenever that request threw.
    if (report.outcome === 'delivered') this.store.cooldowns.arm(this.scoped(watch, 'digest'), 23 * HOUR);
  }

  private async emit(watch: Watch, event: NotificationEvent): Promise<DeliveryReport> {
    const labelled = this.labelled(watch, event);
    const report = await this.telegram.notify(labelled);
    this.lastOutcome = report.outcome;
    if (report.outcome === 'delivered') this.delivered += 1;
    if (report.outcome === 'failed') this.undelivered += 1;

    const line = `Event "${labelled.title}" -> ${report.outcome} topic=${report.topic ?? 'General'} (${report.reason}) sent=${report.sent} failed=${report.failed}`;
    if (report.outcome === 'failed') this.logger.error(line);
    else this.logger.debug(line);
    return report;
  }
}
