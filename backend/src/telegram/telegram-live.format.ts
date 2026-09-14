import { escapeHtml, MAX_LENGTH, truncate } from './telegram.format';

/**
 * Renders the two always-current status messages.
 *
 * These are deliberately pure: the text for any situation can be asserted
 * without a Telegram, a Veeam or a clock, which is what makes "what does the
 * operator actually see at 03:00 when the server is down" a testable question.
 */

/** Width of the progress bar, in characters. */
const BAR = 10;

/**
 * Renders as many of `count` items as Telegram's message limit allows.
 *
 * A fixed cap is always wrong in one direction: 30 entries left 12 unshown on a
 * day that would have fit all 42, and a cap large enough for the busy days
 * overflows the 4096-character limit and gets the message rejected. The limit
 * itself is the only honest cap, so `build` is asked for progressively shorter
 * lists until one fits.
 */
export const fitted = (count: number, build: (shown: number) => string): string => {
  const whole = build(count);
  if (whole.length <= MAX_LENGTH) return whole;

  // Binary search rather than one item at a time: with a hundred running jobs
  // the linear walk rebuilt the message a hundred times per cycle.
  let fits = 0;
  let tooMany = count;
  while (fits < tooMany) {
    const middle = Math.ceil((fits + tooMany) / 2);
    if (build(middle).length <= MAX_LENGTH) fits = middle;
    else tooMany = middle - 1;
  }
  return build(fits);
};

export interface LiveHealth {
  reachable: boolean;
  /** Null when no monitor account is configured at all. */
  authenticated: boolean | null;
  serverUrl: string;
  /** Veeam's own clock, as returned by /api/v1/serverTime. */
  serverTime?: string;
  error?: string | null;
  trackedJobs: number;
  intervalMs: number;
}

export interface RunningJob {
  name: string;
  type?: string;
  /** Absent while Veeam has not reported progress for the session yet. */
  percent?: number;
  startedAt?: string;
}

export interface ScheduledRun {
  name: string;
  /** ISO instant of the next scheduled start. */
  at: string;
}

export interface LiveRunning {
  jobs: RunningJob[];
  totalJobs: number;
  /** Only shown while nothing is running; the schedule slot owns the full list. */
  next?: ScheduledRun | null;
  /** Set when the figures could not be refreshed; says why, in Russian. */
  unavailable?: string;
}

export interface LiveSchedule {
  /** Every future run, ascending. The renderer decides what counts as today. */
  upcoming: ScheduledRun[];
  unavailable?: string;
}

/** Formatting options shared by both renderers. */
export interface LiveClock {
  now: Date;
  /** IANA zone, or empty for the server's own. */
  timezone: string;
}

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

export const renderHealth = (health: LiveHealth, clock: LiveClock): string => {
  const lines: string[] = [];

  if (!health.reachable) {
    lines.push('🔴 <b>Veeam — сервер недоступен</b>');
  } else if (health.authenticated === false) {
    lines.push('🟡 <b>Veeam — сервер отвечает, вход не выполнен</b>');
  } else if (health.authenticated === null) {
    lines.push('🟡 <b>Veeam — сервер отвечает, мониторинг заданий выключен</b>');
  } else {
    lines.push('🟢 <b>Veeam — всё работает</b>');
  }

  lines.push('', `<b>Сервер:</b> <code>${escapeHtml(health.serverUrl)}</code>`);

  if (health.reachable) {
    lines.push(
      '<b>Связь:</b> есть',
      `<b>Учётная запись мониторинга:</b> ${authLabel(health.authenticated)}`,
      `<b>Заданий под наблюдением:</b> ${health.trackedJobs}`,
    );
  } else {
    lines.push('<b>Связь:</b> нет');
  }

  if (health.error && (!health.reachable || health.authenticated === false)) {
    lines.push('', `<b>Причина:</b> ${escapeHtml(health.error)}`);
  }

  lines.push('', `<b>Проверка:</b> каждые ${Math.round(health.intervalMs / 1000)} с`);

  // Veeam's own clock belongs on the volatile line: it moves every poll, and a
  // field that always differs would mean rewriting this message every minute
  // just to say the same thing.
  const serverClock =
    health.reachable && health.serverTime
      ? ` · часы сервера ${escapeHtml(moment(health.serverTime, clock))}`
      : '';
  lines.push(`<i>Обновлено ${stampOf(clock.now, clock)}${serverClock}</i>`);

  return truncate(lines.join('\n'));
};

const authLabel = (authenticated: boolean | null): string => {
  if (authenticated === null) return 'не настроена';
  return authenticated ? 'авторизована' : 'вход не выполнен';
};

/* ------------------------------------------------------------------ *
 * Running jobs
 * ------------------------------------------------------------------ */

export const renderRunning = (running: LiveRunning, clock: LiveClock): string => {
  const lines: string[] = [];

  if (running.unavailable) {
    lines.push(
      '⚠️ <b>Данные о заданиях недоступны</b>',
      '',
      escapeHtml(running.unavailable),
      '',
      `<i>Обновлено ${stampOf(clock.now, clock)}</i>`,
    );
    return truncate(lines.join('\n'));
  }

  if (running.jobs.length === 0) {
    lines.push(
      '💤 <b>Сейчас не выполняется ни одно задание</b>',
      '',
      `<b>Заданий всего:</b> ${running.totalJobs}`,
      // Only when nothing is running: then "what happens next" is the question
      // being asked here. Otherwise the schedule slot answers it, in full, and
      // repeating one line of it in two places invites the two to disagree.
      `<b>Ближайший запуск:</b> ${nextRunLabel(running.next, clock)}`,
      '',
      `<i>Обновлено ${stampOf(clock.now, clock)}</i>`,
    );
    return truncate(lines.join('\n'));
  }

  const count = running.jobs.length;
  return truncate(
    fitted(count, (shown) => {
      const body: string[] = [
        `▶️ <b>Сейчас ${plural(count, 'выполняется', 'выполняются', 'выполняются')}: ` +
          `${count} ${plural(count, 'задание', 'задания', 'заданий')}</b>`,
        '',
      ];
      for (const job of running.jobs.slice(0, shown)) body.push(...jobBlock(job, clock), '');
      const rest = count - shown;
      if (rest > 0) {
        body.push(`…и ещё ${rest} ${plural(rest, 'задание', 'задания', 'заданий')}`, '');
      }
      body.push(
        `<b>Заданий всего:</b> ${running.totalJobs}`,
        '',
        `<i>Обновлено ${stampOf(clock.now, clock)}</i>`,
      );
      return body.join('\n');
    }),
  );
};

/* ------------------------------------------------------------------ *
 * Today's schedule
 * ------------------------------------------------------------------ */

export const renderSchedule = (schedule: LiveSchedule, clock: LiveClock): string => {
  if (schedule.unavailable) {
    return truncate(
      [
        '⚠️ <b>Расписание недоступно</b>',
        '',
        escapeHtml(schedule.unavailable),
        '',
        `<i>Обновлено ${stampOf(clock.now, clock)}</i>`,
      ].join('\n'),
    );
  }

  const today = dayKey(clock.now, clock);
  const runs = schedule.upcoming.filter((run) => dayKey(new Date(run.at), clock) === today);
  const footer = `<i>Обновлено ${stampOf(clock.now, clock)}</i>`;

  if (runs.length === 0) {
    const later = schedule.upcoming[0];
    return truncate(
      [
        '📅 <b>На сегодня запусков больше нет</b>',
        '',
        `<b>Следующий:</b> ${nextRunLabel(later ?? null, clock)}`,
        '',
        footer,
      ].join('\n'),
    );
  }

  return truncate(
    fitted(runs.length, (shown) => {
      const lines = [
        `📅 <b>Сегодня осталось ${runs.length} ${plural(runs.length, 'запуск', 'запуска', 'запусков')}</b>`,
        '',
      ];
      for (const run of runs.slice(0, shown)) {
        lines.push(`<b>${timeOnly(run.at, clock)}</b> · ${escapeHtml(run.name)}`);
      }
      const rest = runs.length - shown;
      if (rest > 0) {
        lines.push(`…и ещё ${rest} ${plural(rest, 'запуск', 'запуска', 'запусков')}`);
      }
      lines.push('', footer);
      return lines.join('\n');
    }),
  );
};

const jobBlock = (job: RunningJob, clock: LiveClock): string[] => {
  const head = job.percent === undefined
    ? `<b>${escapeHtml(job.name)}</b>`
    : `<b>${escapeHtml(job.name)}</b> — ${Math.round(job.percent)}%`;

  const details: string[] = [];
  if (job.percent !== undefined) details.push(bar(job.percent));
  if (job.startedAt) {
    details.push(`старт ${timeOnly(job.startedAt, clock)}`);
    const elapsed = clock.now.getTime() - Date.parse(job.startedAt);
    if (Number.isFinite(elapsed) && elapsed > 0) details.push(`идёт ${duration(elapsed)}`);
  }
  if (job.type) details.push(escapeHtml(job.type));

  return details.length ? [head, details.join(' · ')] : [head];
};

/** A filled/empty block bar. Telegram has no progress widget, so this is it. */
const bar = (percent: number): string => {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * BAR);
  return `${'▰'.repeat(filled)}${'▱'.repeat(BAR - filled)}`;
};

const nextRunLabel = (
  next: { name: string; at: string } | null | undefined,
  clock: LiveClock,
): string => {
  if (!next) return 'по расписанию ничего не запланировано';
  const at = Date.parse(next.at);
  const when = dayOf(next.at, clock);
  const distance = Number.isFinite(at) ? at - clock.now.getTime() : NaN;
  const relative =
    Number.isFinite(distance) && distance > 0 ? ` (через ${duration(distance)})` : '';
  return `${escapeHtml(next.name)} — ${when}${relative}`;
};

/* ------------------------------------------------------------------ *
 * Time and language
 * ------------------------------------------------------------------ */

/**
 * Constructing an Intl.DateTimeFormat is the expensive half of formatting a
 * date; `.format()` on an existing one is cheap. A message listing a hundred
 * jobs asks for hundreds of them, so the handful of shapes actually used are
 * built once and kept.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

const parts = (value: Date, clock: LiveClock, options: Intl.DateTimeFormatOptions): string => {
  const key = `${clock.timezone}|${Object.entries(options).join(',')}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('ru-RU', {
      timeZone: clock.timezone || undefined,
      ...options,
    });
    formatters.set(key, formatter);
  }
  return formatter.format(value);
};

/** An ISO instant as "14.09.2026, 14:27:39", or the raw string if unparsable. */
const moment = (iso: string, clock: LiveClock): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return parts(date, clock, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

export const stampOf = (value: Date, clock: LiveClock): string =>
  parts(value, clock, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

const timeOnly = (iso: string, clock: LiveClock): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return escapeHtml(iso);
  return parts(date, clock, { hour: '2-digit', minute: '2-digit' });
};

/**
 * Which calendar day an instant falls on, in the display timezone. "Today" is
 * a question about the operator's clock, not about UTC, so every comparison
 * goes through this rather than through Date's own local-time methods.
 */
const dayKey = (value: Date, clock: LiveClock): string =>
  parts(value, clock, { day: '2-digit', month: '2-digit', year: 'numeric' });

/** "сегодня в 18:00", "завтра в 03:00", or "16.09 в 03:00". */
export const dayOf = (iso: string, clock: LiveClock): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return escapeHtml(iso);
  const time = timeOnly(iso, clock);

  const today = dayKey(clock.now, clock);
  const tomorrow = dayKey(new Date(clock.now.getTime() + 86_400_000), clock);
  const target = dayKey(date, clock);

  if (target === today) return `сегодня в ${time}`;
  if (target === tomorrow) return `завтра в ${time}`;
  return `${parts(date, clock, { day: '2-digit', month: '2-digit' })} в ${time}`;
};

/** "45 с", "22 мин", "3 ч 33 мин", "2 д 4 ч" — never more than two units. */
export const duration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days} д ${rest} ч` : `${days} д`;
};

/** Russian needs three forms; "1 задание, 2 задания, 5 заданий". */
export const plural = (count: number, one: string, few: string, many: string): string => {
  const mod100 = Math.abs(count) % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = mod100 % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
};
