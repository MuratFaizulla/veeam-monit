import { escapeHtml, MAX_LENGTH, truncate } from '../telegram/format';
import { dayKey, dayOf, duration, Clock, moment, plural, stampOf, timeOnly } from '../telegram/time';
import { jobTypeWord } from '../telegram/words';
import { ScheduledRun } from '../estate/schedule-planner';

// Re-exported so the slot renderers keep one place to import their helpers from.
export { dateOf, dayOf, Clock, everyLabel, momentOf, plural } from '../telegram/time';

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
  if (whole.length <= BUDGET) return whole;
  return build(largest(count, (shown) => build(shown).length <= BUDGET));
};

/**
 * Room left above every slot for the name of the server it shows.
 *
 * The lists are fitted to what is left, rather than cut after the name is
 * put on top: cutting would take the footer, or the "…и ещё" that says how many
 * rows were left out.
 */
const HEADING_ROOM = 64;
const BUDGET = MAX_LENGTH - HEADING_ROOM;

/**
 * A slot's page with the server it shows named on top.
 *
 * Only where there are several servers: with one, there is nothing to tell
 * apart, and the name would be one more line on every message saying nothing.
 */
export const headed = (serverName: string, page: string): string =>
  truncate(`🖥 <b>${escapeHtml(serverName)}</b>\n\n${page}`);

/**
 * The largest `n` up to `limit` for which `fits(n)` holds.
 *
 * Binary search rather than one item at a time: with a hundred running jobs the
 * linear walk rebuilt the message a hundred times per cycle.
 */
const largest = (limit: number, fits: (n: number) => boolean): number => {
  let ok = 0;
  let tooMany = limit;
  while (ok < tooMany) {
    const middle = Math.ceil((ok + tooMany) / 2);
    if (fits(middle)) ok = middle;
    else tooMany = middle - 1;
  }
  return ok;
};

/**
 * Renders `count` items across as many messages as they need, up to `maxPages`.
 *
 * One message can hold about fifty spelled-out rows, and an estate has twice
 * that. Dropping the overflow is the wrong trade when the list is the point of
 * the topic, so the list is allowed to continue into a second message that is
 * kept current exactly like the first.
 *
 * `build(from, take, tail)` renders items `[from, from + take)`. `tail` asks for
 * the closing summary, and is only true on the page that ends the list — a
 * total repeated under every page would be read as a per-page total.
 */
export const paged = (
  count: number,
  maxPages: number,
  build: (from: number, take: number, tail: boolean) => string,
): string[] => {
  const out: string[] = [];
  let from = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const rest = count - from;
    const whole = build(from, rest, true);
    if (whole.length <= BUDGET) {
      out.push(whole);
      return out;
    }
    // The last page allowed must carry the summary even though it cannot carry
    // every remaining row; the summary is what says how many were left out.
    const closing = page === maxPages - 1;
    const take = largest(rest, (n) => build(from, n, closing).length <= BUDGET);
    out.push(build(from, take, closing));
    from += take;
    // A single row that does not fit on its own would loop forever otherwise.
    if (take === 0) return out;
  }
  return out;
};

export interface LiveHealth {
  reachable: boolean;
  /** Null when no monitor account is configured at all. */
  authenticated: boolean | null;
  serverUrl: string;
  /** The IP address `serverUrl` leads to, once a connection has resolved it. */
  serverAddress?: string;
  error?: string | null;
  trackedJobs: number;
  intervalMs: number;
  /** Every Veeam server watched, and which one the slots show. Listed when there are several. */
  servers?: LiveServerHealth[];
}

export interface LiveServerHealth {
  name: string;
  selected: boolean;
  /** Null until the server has been asked once. */
  reachable: boolean | null;
  authenticated: boolean | null;
  /** Its IP address, once a connection has resolved it. */
  address?: string;
  /** How many jobs it has, once its job list has been read. */
  jobs?: number;
  /** Why it is not watched, in Veeam's or the network's words, when it is not. */
  error?: string | null;
}

export interface RunningJob {
  name: string;
  type?: string;
  /** Absent while Veeam has not reported progress for the session yet. */
  percent?: number;
  startedAt?: string;
  /**
   * Running, but switched off in Veeam — started by hand, or disabled after it
   * had already begun. Said out loud because the schedule will not start it
   * again, and this list is the only place anyone would notice.
   */
  disabled?: boolean;
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
  /** Every remaining run today, ascending. */
  upcoming: ScheduledRun[];
  /** First known run, including one beyond today. */
  next?: ScheduledRun | null;
  unavailable?: string;
}

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

export const renderHealth = (health: LiveHealth, clock: Clock): string => {
  if (health.servers && health.servers.length > 1) return renderServersHealth(health, health.servers, clock);
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
  // The address is what a network engineer is asked to open, and the name in
  // the URL is not something a firewall rule is written for. Left out when the
  // URL already is the address.
  if (health.serverAddress && !health.serverUrl.includes(health.serverAddress)) {
    lines.push(`<b>IP:</b> <code>${escapeHtml(health.serverAddress)}</code>`);
  }

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

  lines.push('', healthFooter(health, clock));
  return truncate(lines.join('\n'));
};

/**
 * One time under 🩺: when it was written, and how often it is checked.
 *
 * It used to be three — the check interval on a line of its own, then the
 * time of writing beside Veeam's own clock — and two clocks a few seconds
 * apart read as a puzzle, not as a check that the monitor is alive.
 */
const healthFooter = (health: LiveHealth, clock: Clock): string =>
  footerOf(clock, ` · проверка каждые ${Math.round(health.intervalMs / 1000)} с`);

/**
 * 🩺 when there are several servers: is every one of them watched?
 *
 * It used to open with the selected server alone — "🟢 Veeam — всё работает"
 * above a list in which another server could not sign in — and to say which
 * server was selected by colour, ⚪ for the others, which read as "off". Now
 * the first line counts the servers that are fine, the ones in trouble come
 * first with their reason, and the addresses a firewall rule is written for
 * sit together under the list. The selected one leads the servers that are
 * fine, in blue: a colour no state uses, so the eye finds the server the
 * topics show before reading a word.
 */
const renderServersHealth = (health: LiveHealth, servers: LiveServerHealth[], clock: Clock): string => {
  const fine = servers
    .filter((server) => server.reachable === true && server.authenticated === true)
    .sort((a, b) => Number(b.selected) - Number(a.selected));
  const unasked = servers.filter((server) => server.reachable === null);
  const troubled = servers.filter((server) => troubleOf(server) !== undefined);

  const counted = countWords(servers.length, fine.length, troubled.length, unasked.length);
  const lines = [`${healthIcon(fine.length, troubled.length)} <b>${counted}</b>`, ''];
  for (const server of troubled) {
    // Red where the monitor is shut out; a server with no account configured
    // was left unwatched on purpose, or by an oversight, and is yellow.
    const icon = server.reachable === false || server.authenticated === false ? '🔴' : '🟡';
    lines.push(`${icon} ${serverName(server)} — ${troubleOf(server)}`);
    if (server.error) lines.push(`<i>${escapeHtml(server.error)}</i>`);
  }
  for (const server of fine) {
    const jobs = server.jobs === undefined ? '' : ` · ${server.jobs} ${plural(server.jobs, 'задание', 'задания', 'заданий')}`;
    // In trouble, the selected one keeps its red or yellow above: trouble
    // matters more than which server is shown, and the other topics name the
    // server they show on top anyway.
    lines.push(`${server.selected ? '🔵' : '🟢'} ${serverName(server)}${jobs}`);
  }
  for (const server of unasked) lines.push(`⚪ ${serverName(server)} — ещё не опрошен`);

  const addressed = servers.filter((server) => server.address && server.address !== server.name);
  if (addressed.length) {
    lines.push('', '<b>Адреса:</b>');
    for (const server of addressed) {
      lines.push(`${escapeHtml(server.name)} — <code>${escapeHtml(server.address ?? '')}</code>`);
    }
  }

  lines.push('', healthFooter(health, clock));
  return truncate(lines.join('\n'));
};

const healthIcon = (fine: number, troubled: number): string => {
  if (troubled === 0) return fine > 0 ? '🟢' : '⚪';
  return fine > 0 ? '🟡' : '🔴';
};

/** "Все 5 серверов в порядке", "Оба сервера в порядке", "4 из 5 серверов в порядке". */
const countWords = (total: number, fine: number, troubled: number, unasked: number): string => {
  if (fine === total) {
    if (total === 2) return 'Оба сервера в порядке';
    return `Все ${total} ${plural(total, 'сервер', 'сервера', 'серверов')} в порядке`;
  }
  const counted = `${fine} из ${total} ${plural(total, 'сервера', 'серверов', 'серверов')} в порядке`;
  if (troubled > 0 || unasked === 0) return counted;
  return `${counted}, ${unasked} ещё не ${unasked === 1 ? 'опрошен' : 'опрошены'}`;
};

const serverName = (server: LiveServerHealth): string => `<b>${escapeHtml(server.name)}</b>`;

/** What keeps a server from being watched, or nothing while it is watched or not asked yet. */
const troubleOf = (server: { reachable: boolean | null; authenticated: boolean | null }): string | undefined => {
  if (server.reachable === false) return 'не отвечает';
  if (server.reachable && server.authenticated === false) return 'вход не выполнен';
  if (server.reachable && server.authenticated === null) return 'учётная запись не настроена';
  return undefined;
};

/** 🟢 answering and signed in, 🟡 answering only, 🔴 not answering, ⚪ not asked yet. */
export const serverIcon = (server: {
  reachable: boolean | null;
  authenticated: boolean | null;
}): string =>
  server.reachable === null ? '⚪' : !server.reachable ? '🔴' : server.authenticated ? '🟢' : '🟡';

const authLabel = (authenticated: boolean | null): string => {
  if (authenticated === null) return 'не настроена';
  return authenticated ? 'авторизована' : 'вход не выполнен';
};

/* ------------------------------------------------------------------ *
 * Running jobs
 * ------------------------------------------------------------------ */

export const renderRunning = (running: LiveRunning, clock: Clock): string => {
  const lines: string[] = [];

  if (running.unavailable) {
    lines.push(
      '⚠️ <b>Данные о заданиях недоступны</b>',
      '',
      escapeHtml(running.unavailable),
      '',
      footerOf(clock),
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
      footerOf(clock),
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
        footerOf(clock),
      );
      return body.join('\n');
    }),
  );
};

/* ------------------------------------------------------------------ *
 * Today's schedule
 * ------------------------------------------------------------------ */

export const renderSchedule = (schedule: LiveSchedule, clock: Clock): string => {
  if (schedule.unavailable) {
    return truncate(
      [
        '⚠️ <b>Расписание недоступно</b>',
        '',
        escapeHtml(schedule.unavailable),
        '',
        footerOf(clock),
      ].join('\n'),
    );
  }

  const today = dayKey(clock.now, clock);
  const runs = schedule.upcoming.filter((run) => dayKey(new Date(run.at), clock) === today);
  const footer = footerOf(clock);

  if (runs.length === 0) {
    const later = schedule.next ?? schedule.upcoming[0];
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
        const kind = run.scheduleKind ? ` <i>· ${escapeHtml(run.scheduleKind)}</i>` : '';
        lines.push(`${timeOnly(run.at, clock)} · ${escapeHtml(run.name)}${kind}`);
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

const jobBlock = (job: RunningJob, clock: Clock): string[] => {
  const head = job.percent === undefined
    ? `<b>${escapeHtml(job.name)}</b>`
    : `<b>${escapeHtml(job.name)}</b> — ${Math.round(job.percent)}%`;

  const details: string[] = [];
  if (job.percent !== undefined) details.push(bar(job.percent));
  if (job.startedAt) {
    // The time alone only while it is today's: a job going since the 26th
    // read "старт 23:11" and looked like it had started last night.
    const today = dayKey(new Date(job.startedAt), clock) === dayKey(clock.now, clock);
    details.push(`старт ${today ? timeOnly(job.startedAt, clock) : dayOf(job.startedAt, clock)}`);
    const elapsed = clock.now.getTime() - Date.parse(job.startedAt);
    if (Number.isFinite(elapsed) && elapsed > 0) details.push(`идёт ${duration(elapsed)}`);
  }
  if (job.type) details.push(escapeHtml(jobTypeWord(job.type) ?? job.type));
  if (job.disabled) details.push('⚠️ выключено в Veeam');

  return details.length ? [head, details.join(' · ')] : [head];
};

/**
 * A filled/empty block bar. Telegram has no progress widget, so this is it.
 *
 * Block elements rather than the parallelograms this used: a Windows Telegram
 * client with no glyph for ▰ substituted a hyphen, so half the bar rendered as
 * `-----□□□□□` and the shape stopped reading as a bar at all. These are the
 * same characters 💾 Repositories has always drawn its bar with, which is the
 * other half of the reason — one bot should not have two bars.
 */
export const bar = (percent: number, width = BAR): string => {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
};

const nextRunLabel = (
  next: { name: string; at: string } | null | undefined,
  clock: Clock,
): string => {
  if (!next) return 'по расписанию ничего не запланировано';
  const at = Date.parse(next.at);
  const when = dayOf(next.at, clock);
  const distance = Number.isFinite(at) ? at - clock.now.getTime() : NaN;
  const relative =
    Number.isFinite(distance) && distance > 0 ? ` (через ${duration(distance)})` : '';
  return `${escapeHtml(next.name)} — ${when}${relative}`;
};

const UPDATED = '<i>Обновлено';

/**
 * The last line of every live slot: when it was written.
 *
 * Written here and nowhere else, because it is read here too — `isFooter` is
 * how the live module leaves it out when deciding whether a slot changed. Two
 * renderers used to spell it themselves, with their own date formatter, and
 * the comparison worked only because both spellings happened to match the
 * string the live module was looking for.
 *
 * `extra` stays inside the line, and so inside what the comparison ignores:
 * it is for things that move every poll, like Veeam's own clock.
 */
export const footerOf = (clock: Clock, extra = ''): string =>
  `${UPDATED} ${stampOf(clock.now, clock)}${extra}</i>`;

/** Whether this line is the one `footerOf` writes. */
export const isFooter = (line: string): boolean => line.startsWith(UPDATED);

