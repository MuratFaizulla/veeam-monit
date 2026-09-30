import { escapeHtml } from '../telegram/format';
import { dayOf, duration, Clock, longMoment, plural, stampOf } from '../telegram/time';
import { Job } from '../veeam/estate';
import { VeeamJob, VeeamJobStorage } from '../veeam/types';
import { RetainedHistory } from './backup-evidence.service';
import { iconOf, isBadResult } from './job-state';
import { runsOf } from './runs';
import { daysOf, describeRetry, describeSchedule } from './schedule-planner';

/**
 * One job, answered for.
 *
 * Every live slot is an aggregate: how many are running, how fast, where space
 * is short, which jobs are behind. None of them can be asked about a single
 * job, and that is the question an operator actually arrives with — usually
 * carrying a name somebody read out over the phone, half-remembered and in the
 * wrong case.
 *
 * So the module does two things the chat cannot do for itself: turn an
 * approximate name into a job, and turn a job into everything already known
 * about it. The two are separate because only the first can be wrong in a way
 * the asker must be told about.
 */

/**
 * One session of this job — one attempt, not one run.
 *
 * Veeam retries a failed job by starting another session; which sessions are
 * one run is decided in runs.ts.
 */
export interface JobSession {
  /** The session id, which is how its per-object detail is reached. */
  id?: string;
  startedAt?: string;
  /** Absent while the session is still going. */
  endedAt?: string;
  /** Lower-cased, as the estate reader hands every session result out. */
  result?: string;
  message?: string;
  /** 0-100, only while running and only once Veeam reports any. */
  percent?: number;
}

/**
 * How the job is set up, each line already written out.
 *
 * Strings rather than the raw configuration: deciding that `dailyKind:
 * SelectedDays` with three days means "пн, ср, пт в 03:12" is a reading of
 * Veeam's schedule model, and that belongs with the module that models
 * schedules, not with the one that lays out a message.
 */
export interface JobSettings {
  schedule?: string;
  retry?: string;
  repository?: string;
  proxies?: string;
  retention?: string;
  mode?: string;
}

/** A machine the job protects. */
export interface ProtectedObject {
  name: string;
  hostName?: string;
  /** Veeam's own formatting, shown as given. */
  size?: string;
}

/** One object of a run that went wrong, and what went wrong with it. */
export interface FailedObject {
  name: string;
  /** Lower-cased. */
  result?: string;
  message?: string;
}

/** Everything worth saying about one job, gathered from every source. */
export interface JobCard {
  name: string;
  type?: string;
  status?: string;
  disabled: boolean;
  /** Lower-cased last result, `none` where Veeam reports none. */
  lastResult: string;
  lastRun?: string;
  nextRun?: string;
  objects?: number;
  /** Newest sessions first. Empty when the sessions could not be read. */
  sessions: JobSession[];
  /**
   * The read of `sessions` stopped at its limit, so Veeam holds older ones and
   * the oldest Run among these may be missing attempts.
   */
  sessionsCut: boolean;
  /**
   * How far apart two sessions may be and still be one run, from the job's own
   * retry policy (see runs.ts). The run list folds its sessions by it.
   */
  retryWindowMs: number;
  /** Absent when the job configuration could not be read. */
  settings?: JobSettings;
  /** The machines this job protects, as its configuration lists them. */
  machines: ProtectedObject[];
  /** Machines deliberately left out of the job; counted, not listed. */
  excluded: number;
  /**
   * Which objects of the newest bad run failed, and why. Empty when the last
   * run was fine, or when the run never got as far as starting an object —
   * both of which are answers in themselves.
   */
  failedObjects: FailedObject[];
  /** Consecutive failed runs; absent when the estate scan has not run. */
  failures?: number;
  /** How far back this job can be restored. Absent with no scan, or no points. */
  depth?: RetainedHistory;
  /** Its own rhythm in days, learned from its points; null when unknowable. */
  cadenceDays?: number | null;
  /** Why there is nothing to say about restore points, when there is not. */
  pointsUnavailable?: string;
  /** A replica or the like, whose points Veeam keeps outside the list the scan reads. */
  pointsElsewhere?: boolean;
}

/* ------------------------------------------------------------------ *
 * Finding the job
 * ------------------------------------------------------------------ */

export type JobMatch =
  | { found: 'one'; job: Job }
  // The jobs themselves, not their names: whatever offers the choice needs to
  // be able to address what was chosen, and a name is not an address.
  | { found: 'many'; jobs: Job[] }
  | { found: 'none' };

/**
 * The job somebody meant, from what they typed.
 *
 * Three passes, narrowest first: the whole name, then the name containing what
 * was typed, then every word of it appearing somewhere in the name. The last
 * one is what makes `kingston db` find `OPS_Veeam_DB_Kingston`, where the words are
 * in the other order and separated by underscores nobody types. A job Veeam
 * gave no name is found by its id, which is what it is called everywhere else.
 *
 * Several hits are never resolved by guessing. An operator who asked about the
 * wrong job and was answered confidently is worse off than one who was shown
 * the list.
 */
export const matchJob = (jobs: Job[], query: string): JobMatch => {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return { found: 'none' };

  const exact = jobs.filter((job) => job.name.toLowerCase() === wanted);
  if (exact.length === 1) return { found: 'one', job: exact[0] };

  const words = wanted.split(/\s+/);
  const contained = jobs.filter((job) => job.name.toLowerCase().includes(wanted));
  const scattered = jobs.filter((job) => {
    const name = job.name.toLowerCase();
    return words.every((word) => name.includes(word));
  });

  const hits = contained.length > 0 ? contained : scattered;
  if (hits.length === 0) return { found: 'none' };
  if (hits.length === 1) return { found: 'one', job: hits[0] };
  return { found: 'many', jobs: [...hits].sort((a, b) => a.name.localeCompare(b.name)) };
};

/** What to say when the name fits several jobs. */
export const renderChoices = (jobs: Job[], query: string): string => {
  const shown = jobs.slice(0, 20);
  const lines = [
    `🔎 <b>Под «${escapeHtml(query)}» подходит ${jobs.length} ${plural(jobs.length, 'задание', 'задания', 'заданий')}:</b>`,
    '',
    ...shown.map((job) => `${iconOf(job.result)} <code>${escapeHtml(job.name)}</code>`),
  ];
  if (shown.length < jobs.length) lines.push(`<i>…и ещё ${jobs.length - shown.length}</i>`);
  lines.push('', 'Выберите кнопкой ниже или уточните запрос.');
  return lines.join('\n');
};

/* ------------------------------------------------------------------ *
 * Reading the configuration
 * ------------------------------------------------------------------ */

/**
 * Names for the ids a job points at. Structural on purpose: the card needs two
 * lookups, not a dependency on whatever caches them.
 */
export interface ResourceNames {
  repositories: ReadonlyMap<string, string>;
  proxies: ReadonlyMap<string, string>;
}

/** An id nobody could name is still shown — it is what Veeam's UI shows too. */
const named = (names: ReadonlyMap<string, string>, id: string | undefined): string | undefined =>
  id === undefined ? undefined : names.get(id) ?? id;

const retentionOf = (storage: VeeamJobStorage | undefined): string | undefined => {
  const policy = storage?.retentionPolicy;
  if (!policy?.quantity) return undefined;
  return (policy.type ?? '').toLowerCase() === 'days'
    ? `${policy.quantity} ${plural(policy.quantity, 'день', 'дня', 'дней')}`
    : `${policy.quantity} ${plural(policy.quantity, 'точка', 'точки', 'точек')}`;
};

const modeOf = (storage: VeeamJobStorage | undefined): string | undefined => {
  const advanced = storage?.advancedSettings;
  if (!advanced) return undefined;
  const parts = [advanced.backupModeType].filter((part): part is string => Boolean(part));
  const active = advanced.activeFulls;
  const synthetic = advanced.synthenticFulls;
  if (active?.isEnabled && active.weekly?.isEnabled) {
    const days = daysOf(active.weekly.days);
    parts.push(days ? `активный полный: ${days}` : 'активный полный еженедельно');
  } else if (synthetic?.isEnabled && synthetic.weekly?.isEnabled) {
    const days = daysOf(synthetic.weekly.days);
    parts.push(days ? `синтетический полный: ${days}` : 'синтетический полный еженедельно');
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
};

const proxiesOf = (
  storage: VeeamJobStorage | undefined,
  names: ReadonlyMap<string, string>,
): string | undefined => {
  const proxies = storage?.backupProxies;
  if (!proxies) return undefined;
  // Auto-selection is the answer to "which proxy" for most jobs here, and it
  // is a different answer from "none configured" — which is what an empty
  // proxyIds looks like if the flag is not read.
  if (proxies.autoSelectEnabled) return 'автоматически';
  const chosen = (proxies.proxyIds ?? []).map((id) => named(names, id)).filter(Boolean);
  return chosen.length > 0 ? chosen.join(', ') : undefined;
};

export const settingsOf = (
  configured: VeeamJob | undefined,
  names: ResourceNames,
): JobSettings | undefined => {
  if (!configured) return undefined;
  const storage = configured.storage;
  return {
    schedule: describeSchedule(configured.schedule),
    retry: describeRetry(configured.schedule),
    repository: named(names.repositories, storage?.backupRepositoryId),
    proxies: proxiesOf(storage, names.proxies),
    retention: retentionOf(storage),
    mode: modeOf(storage),
  };
};

/** The machines a job protects, and how many it deliberately leaves out. */
export const machinesOf = (
  configured: VeeamJob | undefined,
): { machines: ProtectedObject[]; excluded: number } => {
  const vms = configured?.virtualMachines;
  return {
    machines: (vms?.includes ?? []).map((object) => ({
      name: object.name ?? object.hostName ?? 'без имени',
      hostName: object.hostName,
      size: object.size,
    })),
    excluded: (vms?.excludes?.vms ?? []).length,
  };
};

/* ------------------------------------------------------------------ *
 * Saying what is known
 * ------------------------------------------------------------------ */

/** "32 мин", or nothing when it has not ended. */
const spanOf = ({ startedAt, endedAt }: { startedAt?: string; endedAt?: string }): string | undefined => {
  if (!startedAt || !endedAt) return undefined;
  const from = Date.parse(startedAt);
  const to = Date.parse(endedAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return undefined;
  return duration(to - from);
};

/** "2 д 11 ч назад", or nothing when the instant is unreadable. */
const agoOf = (iso: string | undefined, now: Date): string | undefined => {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || at > now.getTime()) return undefined;
  return `${duration(now.getTime() - at)} назад`;
};

const momentOf = (iso: string | undefined, clock: Clock): string | undefined => {
  if (!iso) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  return stampOf(at, clock);
};

/** "16.09, 00:15:24 (15 ч 24 мин назад)" — the date and how long ago, together. */
const whenOf = (iso: string | undefined, clock: Clock): string | undefined => {
  const moment = momentOf(iso, clock);
  if (!moment) return undefined;
  const ago = agoOf(iso, clock.now);
  return ago ? `${moment} (${ago})` : moment;
};

/** "раз в сутки", "примерно раз в 7.0 сут". Null cadence says nothing. */
const cadenceLabel = (days: number | null | undefined): string | undefined => {
  if (!days || !Number.isFinite(days)) return undefined;
  if (days >= 0.9 && days <= 1.1) return 'примерно раз в сутки';
  if (days >= 6.5 && days <= 7.5) return 'примерно раз в неделю';
  if (days < 0.9) return `примерно раз в ${duration(days * 86_400_000)}`;
  return `примерно раз в ${days.toFixed(1)} сут`;
};

const label = (name: string, value: string | undefined): string | undefined =>
  value === undefined ? undefined : `<b>${name}:</b> ${value}`;

/**
 * Caps, so the card is bounded before Telegram's limit is.
 *
 * Truncating the whole message would cut whatever happens to be last, which is
 * not the same as leaving out the least useful part. A sixteen-machine job
 * listing eight of them and saying so is more useful than one that lists
 * fifteen and loses its run history.
 */
const MACHINES_SHOWN = 8;
const FAILURES_SHOWN = 5;
const RUNS_SHOWN = 5;
/** Veeam error text runs to paragraphs; the first sentence carries it. */
const MESSAGE_SHOWN = 180;
/** The headline reason gets more room, being the one line most people read. */
const REASON_SHOWN = 300;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** Veeam writes multi-line errors; a chat line wants one line. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const more = (total: number, shown: number): string[] =>
  total > shown ? [`<i>…и ещё ${total - shown}</i>`] : [];

export const renderJobCard = (card: JobCard, clock: Clock): string => {
  const lines: string[] = [];
  const subtitle = [
    card.type,
    card.objects === undefined
      ? undefined
      : `${card.objects} ${plural(card.objects, 'объект', 'объекта', 'объектов')}`,
    card.disabled ? '⚠️ выключено в Veeam' : undefined,
  ].filter((part): part is string => Boolean(part));

  lines.push(`📦 <b>${escapeHtml(card.name)}</b>`);
  if (subtitle.length > 0) lines.push(`<i>${escapeHtml(subtitle.join(' · '))}</i>`);
  lines.push('');

  const newest = card.sessions[0];
  const inFlight = newest && !newest.endedAt;
  if (inFlight) {
    const started = agoOf(newest.startedAt, clock.now);
    lines.push(
      `▶️ <b>Выполняется сейчас</b>${newest.percent === undefined ? '' : ` — ${newest.percent}%`}`,
    );
    if (started) lines.push(`<b>Начато:</b> ${started}`);
    lines.push('');
  }

  lines.push(
    ...[
      `${iconOf(card.lastResult)} <b>Последний результат:</b> ${escapeHtml(card.lastResult.toUpperCase())}`,
      label('Запуск', whenOf(card.lastRun, clock)),
      label('Длительность', newest && !inFlight ? spanOf(newest) : undefined),
      label(
        'Причина',
        // Only where the run went wrong — on a success Veeam puts its own "job
        // finished" boilerplate in the same field — and only where the
        // per-object block below is not about to say the same thing at length.
        (card.lastResult === 'failed' || card.lastResult === 'warning') &&
          card.failedObjects.length === 0 &&
          newest?.message
          ? escapeHtml(clip(oneLine(newest.message), REASON_SHOWN))
          : undefined,
      ),
      label(
        'Неудачных подряд',
        card.failures && card.failures > 1 ? String(card.failures) : undefined,
      ),
      label('Следующий запуск', card.nextRun ? dayOf(card.nextRun, clock) : undefined),
    ].filter((line): line is string => Boolean(line)),
  );

  // Directly under the failure it explains, because "which machine" is the
  // next question every single time, and the session message names the job.
  if (card.failedObjects.length > 0) {
    lines.push('', '<b>❗ Что именно не прошло</b>');
    for (const object of card.failedObjects.slice(0, FAILURES_SHOWN)) {
      const why = object.message
        ? ` — ${escapeHtml(clip(oneLine(object.message), MESSAGE_SHOWN))}`
        : '';
      lines.push(`${iconOf(object.result ?? '')} ${escapeHtml(object.name)}${why}`);
    }
    lines.push(...more(card.failedObjects.length, FAILURES_SHOWN));
  }

  if (card.settings) {
    const settings = [
      label('Расписание', card.settings.schedule),
      label('Повтор при ошибке', card.settings.retry),
      label('Репозиторий', card.settings.repository),
      label('Прокси', card.settings.proxies),
      label('Хранение', card.settings.retention),
      label('Режим', card.settings.mode),
    ].filter((line): line is string => Boolean(line));
    if (settings.length > 0) lines.push('', '<b>⚙️ Настройки</b>', ...settings);
  }

  if (card.machines.length > 0) {
    lines.push('', `<b>💻 Машины (${card.machines.length})</b>`);
    for (const machine of card.machines.slice(0, MACHINES_SHOWN)) {
      const detail = [machine.size, machine.hostName].filter(Boolean).join(' · ');
      lines.push(`${escapeHtml(machine.name)}${detail ? ` — ${escapeHtml(detail)}` : ''}`);
    }
    lines.push(...more(card.machines.length, MACHINES_SHOWN));
    if (card.excluded > 0) lines.push(`<i>исключено из задания: ${card.excluded}</i>`);
  }

  lines.push('', '<b>🗂 Точки восстановления</b>');
  if (card.depth) {
    const { runs, points, machines, newest: freshest, oldest } = card.depth;
    lines.push(
      `Запусков в хранении: <b>${runs}</b> · точек: ${points} · машин: ${machines}`,
      `Новейшая: ${longMoment(freshest, clock)}`,
      `Старейшая: ${longMoment(oldest, clock)}`,
    );
    const cadence = cadenceLabel(card.cadenceDays);
    if (cadence) lines.push(`Периодичность: ${cadence}`);
  } else if (card.pointsElsewhere && !card.pointsUnavailable) {
    // Said instead of "no points at all", which is what a replica read as
    // while it was replicating every night.
    lines.push('Точки заданий этого типа Veeam хранит отдельно; защищённость видна по успешным запускам.');
    const cadence = cadenceLabel(card.cadenceDays);
    if (cadence) lines.push(`Периодичность: ${cadence}`);
  } else {
    lines.push(card.pointsUnavailable ?? 'У задания нет ни одной точки восстановления.');
  }

  // Runs, not sessions: four twenty-second retries and the attempt that worked
  // are one night, and listed a line each they read as a disaster.
  const runs = runsOf(card.sessions.filter((session) => session.endedAt), card.retryWindowMs);
  // A Run the read cut short would be listed with fewer attempts than it had,
  // so it is left out — unless it is the only one there is.
  const finished = card.sessionsCut && runs.length > 1 ? runs.slice(0, -1) : runs;
  if (finished.length > 0) {
    lines.push('', '<b>Последние запуски</b>');
    for (const run of finished.slice(0, RUNS_SHOWN)) {
      const first = run.attempts[run.attempts.length - 1];
      const last = run.attempts[0];
      const when = momentOf(first.startedAt, clock) ?? '—';
      const span = spanOf({ startedAt: first.startedAt, endedAt: last.endedAt });
      const tries = run.attempts.length > 1 ? ` · попыток: ${run.attempts.length}` : '';
      // The reason only on the runs that went wrong, and from the attempt that
      // finished the run: on a success Veeam puts its own boilerplate in the
      // same field and it says nothing.
      const why =
        isBadResult(run.result) && last.message
          ? `\n   <i>${escapeHtml(clip(oneLine(last.message), MESSAGE_SHOWN))}</i>`
          : '';
      lines.push(`${iconOf(run.result)} ${when}${span ? ` · ${span}` : ''}${tries}${why}`);
    }
  }

  return lines.join('\n');
};
