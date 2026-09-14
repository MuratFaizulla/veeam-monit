import { escapeHtml } from './telegram.format';
import { dayOf, fitted, LiveClock, plural, stampOf } from './telegram-live.format';

/**
 * "What is not actually protected right now."
 *
 * Every other alert in this service fires on a *transition*: a job that was
 * fine and now is not. That leaves the most dangerous case invisible — a job
 * sitting at `lastResult: Success` whose newest restore point is from June,
 * because the job simply stopped running. Nothing transitions, so nothing is
 * reported, and the gap is only found when somebody needs the restore.
 *
 * So this slot asks a different question, and asks it of the restore points
 * themselves rather than of the job status.
 */

/** How many recent intervals are used to learn a job's own rhythm. */
const RHYTHM_SAMPLES = 10;

const DAY = 86_400_000;

export interface ProtectionJob {
  id: string;
  name: string;
  type?: string;
  lastRun?: string;
  /** Switched off in Veeam. It is not supposed to be producing anything. */
  disabled?: boolean;
  /**
   * Set to run by hand rather than on a schedule. Undefined means the schedule
   * could not be read, and an unknown schedule is treated as a real one: a job
   * is only excused from this list on positive evidence, never on a gap.
   */
  unscheduled?: boolean;
}

export interface ProtectionThresholds {
  /** Floor, in days. Nothing fresher than this is ever reported. */
  staleDays: number;
  /**
   * How many of a job's own intervals it may miss before it counts as overdue.
   * A weekly job is not late after three days; a hourly one is.
   */
  overdueFactor: number;
  /**
   * Consecutive failed runs that make a job worth reporting on their own.
   * Runs, not sessions: a job with retries enabled produces several failed
   * sessions per failed run.
   */
  minStreak: number;
}

export interface ProtectionInput extends ProtectionThresholds {
  jobs: ProtectionJob[];
  /** Restore point timestamps (epoch ms) per job id, in any order. */
  pointsByJob: Map<string, number[]>;
  /** Consecutive failures counted back from the newest session, per job id. */
  streakByJob: Map<string, number>;
  now: number;
}

export interface ProtectionRisk {
  name: string;
  type?: string;
  /** Days since the newest restore point; null when the job has none at all. */
  ageDays: number | null;
  /** The job's own typical interval in days, when it has enough history. */
  intervalDays: number | null;
  failures: number;
  lastRun?: string;
  severity: 'critical' | 'warning';
}

export interface ProtectionSnapshot extends ProtectionThresholds {
  risks: ProtectionRisk[];
  /** Jobs actually judged — excludes the ones below. */
  totalJobs: number;
  /** Jobs with a restore point inside their own expected interval. */
  protectedJobs: number;
  excludedDisabled: number;
  excludedUnscheduled: number;
  unavailable?: string;
}

/**
 * Decides which jobs are at risk. Pure: the whole judgement can be tested
 * without a Veeam, a Telegram or a clock.
 */
export const assessProtection = (input: ProtectionInput): ProtectionSnapshot => {
  const { jobs, pointsByJob, streakByJob, now, staleDays, overdueFactor, minStreak } = input;
  const risks: ProtectionRisk[] = [];
  let excludedDisabled = 0;
  let excludedUnscheduled = 0;
  let judged = 0;

  for (const job of jobs) {
    // A job that is switched off, or that only runs when somebody starts it,
    // has no restore point by design. Reporting those buried the four jobs
    // that are genuinely failing under nineteen that are working as intended.
    if (job.disabled) {
      excludedDisabled += 1;
      continue;
    }
    if (job.unscheduled) {
      excludedUnscheduled += 1;
      continue;
    }
    judged += 1;

    const points = [...(pointsByJob.get(job.id) ?? [])].sort((a, b) => b - a);
    const failures = streakByJob.get(job.id) ?? 0;
    const intervalDays = rhythm(points);
    const ageDays = points.length ? (now - points[0]) / DAY : null;

    // The deadline is the job's own schedule where it is known, but never
    // tighter than the configured floor: a job that runs hourly should not be
    // reported the moment it misses one run.
    const deadline = Math.max(staleDays, (intervalDays ?? staleDays) * overdueFactor);
    const overdue = ageDays === null || ageDays > deadline;
    const streaking = failures >= minStreak;
    if (!overdue && !streaking) continue;

    risks.push({
      name: job.name,
      type: job.type,
      ageDays,
      intervalDays,
      failures,
      lastRun: job.lastRun,
      // "No restore point at all" and "twice past the deadline" are the two
      // cases where somebody should be looking today rather than this week.
      severity:
        ageDays === null || (overdue && ageDays > deadline * 2) ? 'critical' : 'warning',
    });
  }

  risks.sort(compareRisk);

  return {
    risks,
    totalJobs: judged,
    protectedJobs: judged - risks.length,
    excludedDisabled,
    excludedUnscheduled,
    staleDays,
    overdueFactor,
    minStreak,
  };
};

/** Critical first, then the longest-unprotected first. */
const compareRisk = (a: ProtectionRisk, b: ProtectionRisk): number => {
  if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
  const age = (risk: ProtectionRisk): number =>
    risk.ageDays === null ? Number.POSITIVE_INFINITY : risk.ageDays;
  return age(b) - age(a);
};

/**
 * The job's usual interval, as the median gap between its recent restore
 * points. The median rather than the mean because one long outage between two
 * points would otherwise redefine the job as a monthly one.
 */
const rhythm = (newestFirst: number[]): number | null => {
  if (newestFirst.length < 3) return null;
  const gaps: number[] = [];
  for (let i = 0; i < Math.min(newestFirst.length - 1, RHYTHM_SAMPLES); i += 1) {
    gaps.push(newestFirst[i] - newestFirst[i + 1]);
  }
  gaps.sort((a, b) => a - b);
  const middle = gaps[Math.floor(gaps.length / 2)] / DAY;
  return Number.isFinite(middle) && middle > 0 ? middle : null;
};

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

export const renderProtection = (snapshot: ProtectionSnapshot, clock: LiveClock): string => {
  const footer = `<i>Обновлено ${stampOf(clock.now, clock)}</i>`;

  if (snapshot.unavailable) {
    return [
      '⚠️ <b>Защищённость не проверена</b>',
      '',
      escapeHtml(snapshot.unavailable),
      '',
      footer,
    ].join('\n');
  }

  const rule =
    `<b>Правило:</b> точка старше ${snapshot.staleDays} ${plural(snapshot.staleDays, 'дня', 'дней', 'дней')}` +
    ` или ${trim(snapshot.overdueFactor)}× своего интервала;` +
    ` ${snapshot.minStreak} ${plural(snapshot.minStreak, 'неудачный запуск', 'неудачных запуска', 'неудачных запусков')} подряд`;

  const skipped: string[] = [];
  if (snapshot.excludedDisabled) skipped.push(`${snapshot.excludedDisabled} выключено`);
  if (snapshot.excludedUnscheduled) {
    skipped.push(`${snapshot.excludedUnscheduled} без расписания`);
  }
  // Said out loud, because a count that silently shrank would be worse than a
  // count that is too big: the operator must know what is outside the check.
  const tail = [
    rule,
    skipped.length ? `<b>Не учитываются:</b> ${skipped.join(', ')}` : null,
    footer,
  ].filter((line): line is string => line !== null);

  if (snapshot.risks.length === 0) {
    return [
      '🟢 <b>Все задания защищены</b>',
      '',
      `Свежая точка восстановления есть у всех ${snapshot.totalJobs} ${plural(snapshot.totalJobs, 'задания', 'заданий', 'заданий')}.`,
      '',
      ...tail,
    ].join('\n');
  }

  const count = snapshot.risks.length;
  return fitted(count, (shown) => {
    const lines = [
      `🛡 <b>Под угрозой: ${count} из ${snapshot.totalJobs} ${plural(snapshot.totalJobs, 'задания', 'заданий', 'заданий')}</b>`,
      '',
    ];
    for (const risk of snapshot.risks.slice(0, shown)) lines.push(riskLine(risk, clock));
    const rest = count - shown;
    if (rest > 0) {
      lines.push(`…и ещё ${rest} ${plural(rest, 'задание', 'задания', 'заданий')}`);
    }
    lines.push('', ...tail);
    return lines.join('\n');
  });
};

const riskLine = (risk: ProtectionRisk, clock: LiveClock): string => {
  const icon = risk.severity === 'critical' ? '🔴' : '🟠';
  const reasons: string[] = [];

  if (risk.ageDays === null) {
    reasons.push('точек восстановления нет');
    if (risk.lastRun) reasons.push(`последний запуск ${dayOf(risk.lastRun, clock)}`);
  } else {
    reasons.push(`${age(risk.ageDays)} без точки`);
    if (risk.intervalDays !== null) reasons.push(`обычно раз в ${age(risk.intervalDays)}`);
  }

  if (risk.failures > 0) {
    reasons.push(
      `${risk.failures} ${plural(risk.failures, 'неудачный запуск', 'неудачных запуска', 'неудачных запусков')} подряд`,
    );
  }

  return `${icon} <b>${escapeHtml(risk.name)}</b> — ${reasons.join(' · ')}`;
};

/** Days, but readable when it is less than one. */
const age = (days: number): string => {
  if (days < 1) {
    const hours = Math.max(1, Math.round(days * 24));
    // 23.7 hours rounds to 24, which should read as a day rather than as a
    // second way of writing one.
    if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
    return '1 день';
  }
  const whole = Math.floor(days);
  return `${whole} ${plural(whole, 'день', 'дня', 'дней')}`;
};

const trim = (value: number): string => String(Number(value.toFixed(1)));
