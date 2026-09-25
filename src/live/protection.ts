import { escapeHtml } from '../telegram/format';
import { Standings } from '../estate/job-standing';
import { dayOf, fitted, footerOf, LiveClock, longMoment, plural } from './format';

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

const DAY = 86_400_000;

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
  /**
   * Which jobs are owed a restore point, and what each of them has. Decided
   * elsewhere and shared with the 🗂 slot, so the two cannot disagree about
   * which jobs are in scope or how many were left out.
   */
  standings: Standings;
  now: number;
}

export interface ProtectionRisk {
  name: string;
  type?: string;
  /** Epoch ms of the newest restore point, when there is one. */
  lastPoint?: number;
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
  const { standings, now, staleDays, overdueFactor, minStreak } = input;
  const risks: ProtectionRisk[] = [];
  let protectedJobs = 0;

  for (const job of standings.judged) {
    const { runs: points, failures, cadenceDays: intervalDays } = job;
    const ageDays = points.length ? (now - points[0]) / DAY : null;

    // The deadline is the job's own schedule where it is known, but never
    // tighter than the configured floor: a job that runs hourly should not be
    // reported the moment it misses one run.
    const deadline = Math.max(staleDays, (intervalDays ?? staleDays) * overdueFactor);
    const overdue = ageDays === null || ageDays > deadline;
    const streaking = failures >= minStreak;
    // A failed attempt does not erase a usable restore point. Keep the job in
    // the attention list, but still count it as protected while its point is
    // fresh enough for this job's own schedule.
    if (!overdue) protectedJobs += 1;
    if (!overdue && !streaking) continue;

    risks.push({
      name: job.name,
      type: job.type,
      lastPoint: points.length ? points[0] : undefined,
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
    totalJobs: standings.judged.length,
    protectedJobs,
    excludedDisabled: standings.excludedDisabled,
    excludedUnscheduled: standings.excludedUnscheduled,
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

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

export const renderProtection = (snapshot: ProtectionSnapshot, clock: LiveClock): string => {
  const footer = footerOf(clock);

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

  // Same order as 🗂 states them, so the two topics can be read side by side.
  const skipped: string[] = [];
  if (snapshot.excludedUnscheduled) {
    skipped.push(`${snapshot.excludedUnscheduled} без расписания`);
  }
  if (snapshot.excludedDisabled) skipped.push(`${snapshot.excludedDisabled} выключено`);
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
      `🛡 <b>Требуют внимания: ${count} из ${snapshot.totalJobs} ${plural(snapshot.totalJobs, 'задания', 'заданий', 'заданий')}</b>`,
      `<b>С актуальной точкой:</b> ${snapshot.protectedJobs} из ${snapshot.totalJobs}`,
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
    // The moment itself, not only how long ago: this is the state a restore
    // would actually return the machine to, and somebody deciding whether that
    // is survivable needs the date in front of them, not an arithmetic problem.
    const when =
      risk.lastPoint === undefined ? '' : ` — ${longMoment(risk.lastPoint, clock)}`;
    reasons.push(`${age(risk.ageDays)} без точки${when}`);
    if (risk.intervalDays !== null) reasons.push(`обычно ${cadence(risk.intervalDays)}`);
    if (risk.lastRun) reasons.push(`последний запуск ${dayOf(risk.lastRun, clock)}`);
  }

  if (risk.failures > 0) {
    const streak = `${risk.failures} ${plural(risk.failures, 'неудачный запуск', 'неудачных запуска', 'неудачных запусков')}`;
    // "1 неудачный запуск подряд" is not a streak, it is one failure.
    reasons.push(risk.failures > 1 ? `${streak} подряд` : streak);
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

/** How often a job runs. "обычно раз в 1 день" is a sentence nobody says. */
const cadence = (days: number): string => {
  if (days < 1) {
    const hours = Math.max(1, Math.round(days * 24));
    if (hours === 1) return 'раз в час';
    if (hours < 24) return `раз в ${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
    return 'раз в сутки';
  }
  const whole = Math.round(days);
  if (whole === 1) return 'раз в сутки';
  if (whole === 7) return 'раз в неделю';
  return `раз в ${whole} ${plural(whole, 'день', 'дня', 'дней')}`;
};

const trim = (value: number): string => String(Number(value.toFixed(1)));
