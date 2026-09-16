import { escapeHtml } from '../telegram/format';
import { dayOf, duration, LiveClock, longMoment, plural, stampOf } from '../live/format';
import { VeeamJobState } from '../veeam/types';
import { RetainedHistory } from './backup-evidence.service';
import { iconOf } from './job-state';

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

/** A finished or running session of this job. */
export interface JobRun {
  startedAt?: string;
  /** Absent while the run is still going. */
  endedAt?: string;
  result?: string;
  message?: string;
  /** 0-100, only while running and only once Veeam reports any. */
  percent?: number;
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
  runs: JobRun[];
  /** Consecutive failed runs; absent when the estate scan has not run. */
  failures?: number;
  /** How far back this job can be restored. Absent with no scan, or no points. */
  depth?: RetainedHistory;
  /** Its own rhythm in days, learned from its points; null when unknowable. */
  cadenceDays?: number | null;
  /** Why there is nothing to say about restore points, when there is not. */
  pointsUnavailable?: string;
}

/* ------------------------------------------------------------------ *
 * Finding the job
 * ------------------------------------------------------------------ */

export type JobMatch =
  | { found: 'one'; job: VeeamJobState }
  | { found: 'many'; names: string[] }
  | { found: 'none' };

/**
 * The job somebody meant, from what they typed.
 *
 * Three passes, narrowest first: the whole name, then the name containing what
 * was typed, then every word of it appearing somewhere in the name. The last
 * one is what makes `kingston db` find `OPS_Veeam_DB_Kingston`, where the words are
 * in the other order and separated by underscores nobody types.
 *
 * Several hits are never resolved by guessing. An operator who asked about the
 * wrong job and was answered confidently is worse off than one who was shown
 * the list.
 */
export const matchJob = (jobs: VeeamJobState[], query: string): JobMatch => {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return { found: 'none' };

  const named = jobs.filter((job): job is VeeamJobState & { name: string } => Boolean(job.name));
  const exact = named.filter((job) => job.name.toLowerCase() === wanted);
  if (exact.length === 1) return { found: 'one', job: exact[0] };

  const words = wanted.split(/\s+/);
  const contained = named.filter((job) => job.name.toLowerCase().includes(wanted));
  const scattered = named.filter((job) => {
    const name = job.name.toLowerCase();
    return words.every((word) => name.includes(word));
  });

  const hits = contained.length > 0 ? contained : scattered;
  if (hits.length === 0) return { found: 'none' };
  if (hits.length === 1) return { found: 'one', job: hits[0] };
  return { found: 'many', names: hits.map((job) => job.name).sort((a, b) => a.localeCompare(b)) };
};

/** What to say when the name fits several jobs. */
export const renderChoices = (names: string[], query: string): string => {
  const shown = names.slice(0, 20);
  const lines = [
    `🔎 <b>Под «${escapeHtml(query)}» подходит ${names.length} ${plural(names.length, 'задание', 'задания', 'заданий')}:</b>`,
    '',
    ...shown.map((name) => `• <code>${escapeHtml(name)}</code>`),
  ];
  if (shown.length < names.length) lines.push(`<i>…и ещё ${names.length - shown.length}</i>`);
  lines.push('', 'Уточните запрос — можно скопировать имя целиком.');
  return lines.join('\n');
};

/* ------------------------------------------------------------------ *
 * Saying what is known
 * ------------------------------------------------------------------ */

/** "32 мин", or nothing when the run has not ended. */
const spanOf = (run: JobRun): string | undefined => {
  if (!run.startedAt || !run.endedAt) return undefined;
  const from = Date.parse(run.startedAt);
  const to = Date.parse(run.endedAt);
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

const momentOf = (iso: string | undefined, clock: LiveClock): string | undefined => {
  if (!iso) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  return stampOf(at, clock);
};

/** "16.09, 00:15:24 (15 ч 24 мин назад)" — the date and how long ago, together. */
const whenOf = (iso: string | undefined, clock: LiveClock): string | undefined => {
  const moment = momentOf(iso, clock);
  if (!moment) return undefined;
  const ago = agoOf(iso, clock.now);
  return ago ? `${moment} (${ago})` : moment;
};

/** "раз в сутки", "примерно раз в 7.0 сут". Null cadence says nothing. */
const cadenceOf = (days: number | null | undefined): string | undefined => {
  if (!days || !Number.isFinite(days)) return undefined;
  if (days >= 0.9 && days <= 1.1) return 'примерно раз в сутки';
  if (days >= 6.5 && days <= 7.5) return 'примерно раз в неделю';
  if (days < 0.9) return `примерно раз в ${duration(days * 86_400_000)}`;
  return `примерно раз в ${days.toFixed(1)} сут`;
};

const label = (name: string, value: string | undefined): string | undefined =>
  value === undefined ? undefined : `<b>${name}:</b> ${value}`;

export const renderJobCard = (card: JobCard, clock: LiveClock): string => {
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

  const newest = card.runs[0];
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
        // Only worth printing where the run went wrong: on a success Veeam puts
        // its own "job finished" boilerplate in the same field.
        card.lastResult === 'failed' || card.lastResult === 'warning'
          ? newest?.message && escapeHtml(newest.message)
          : undefined,
      ),
      label(
        'Неудачных подряд',
        card.failures && card.failures > 1 ? String(card.failures) : undefined,
      ),
      label('Следующий запуск', card.nextRun ? dayOf(card.nextRun, clock) : undefined),
    ].filter((line): line is string => Boolean(line)),
  );

  lines.push('', '<b>🗂 Точки восстановления</b>');
  if (card.depth) {
    const { runs, points, machines, newest: freshest, oldest } = card.depth;
    lines.push(
      `Запусков в хранении: <b>${runs}</b> · точек: ${points} · машин: ${machines}`,
      `Новейшая: ${longMoment(freshest, clock)}`,
      `Старейшая: ${longMoment(oldest, clock)}`,
    );
    const cadence = cadenceOf(card.cadenceDays);
    if (cadence) lines.push(`Периодичность: ${cadence}`);
  } else {
    lines.push(card.pointsUnavailable ?? 'У задания нет ни одной точки восстановления.');
  }

  const finished = card.runs.filter((run) => run.endedAt);
  if (finished.length > 0) {
    lines.push('', '<b>Последние запуски</b>');
    for (const run of finished.slice(0, 5)) {
      const when = momentOf(run.startedAt, clock) ?? '—';
      const span = spanOf(run);
      lines.push(
        `${iconOf((run.result ?? '').toLowerCase())} ${when}${span ? ` · ${span}` : ''}`,
      );
    }
  }

  return lines.join('\n');
};
