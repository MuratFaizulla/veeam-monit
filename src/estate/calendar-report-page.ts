import { escapeHtml as esc } from '../telegram/format';
import {
  CalendarJob, CalendarReport, CalendarResult, CalendarRun, DAY_MINUTES as DAY, freeStretches, fromNoon, heaviestFullDay, hm, LOAD_STEP, nightLoad, startOf,
  overran as overranIn,
} from './calendar-report';
import { GUIDE, guideBand, guideFoot, guideStyle } from './guide-look';
import { envelope, ReportDocument, stampOf, STATUS_WORD } from './report-envelope';

/**
 * The Calendar report's pages, landscape A4 in the Guide's look:
 *
 * 1. the server and the month: the verdict, five numbers, what to look at and what runs tonight;
 *    then, when the cover cannot hold all of tonight, every run of it;
 * 2. the month as a wall calendar — every past night as it went, every night to come as planned;
 * 3. every job against every day of the month;
 * 4. one night from noon to noon: when each job starts and how long it goes, and how many run at once;
 * 5. the machines, the vCenters they are on and the proxies, and every job under its vCenter;
 * 6. every job's schedule, Fulls, retention and times, as a table.
 */
export const calendarReportPage = (report: CalendarReport, at: number, timezone: string): ReportDocument => {
  const stamp = stampOf(at, timezone);
  const foot = `Veeam Backup & Replication | Календарь заданий ${report.server} · ${monthName(report)} | ${stamp}`;
  return envelope({
    lang: 'ru',
    title: `Календарь заданий ${report.server} · ${monthName(report)}`,
    style: `${guideStyle(foot)}${STYLE}`,
    body: `${cover(report, stamp, foot)}${tonightPages(report)}${calendar(report)}${matrix(report)}${night(report)}${infrastructure(report)}${table(report)}`,
  });
};

/* ------------------------------------------------------------------ *
 * Words and times
 * ------------------------------------------------------------------ */

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_OF = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const monthName = (report: CalendarReport): string => `${MONTHS[report.month]} ${report.year}`;
const daysIn = (report: CalendarReport): number => new Date(Date.UTC(report.year, report.month + 1, 0)).getUTCDate();
/** 0 for Monday. */
const weekdayOf = (report: CalendarReport, day: number): number => (new Date(Date.UTC(report.year, report.month, day)).getUTCDay() + 6) % 7;
const isWeekend = (report: CalendarReport, day: number): boolean => weekdayOf(report, day) >= 5;

const spanOf = (minutes: number): string => {
  const m = Math.round(minutes);
  if (m < 60) return `${m} мин`;
  return m % 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m / 60} ч`;
};
const plural = (n: number, one: string, few: string, many: string): string => {
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  return ones === 1 ? one : ones >= 2 && ones <= 4 ? few : many;
};
/** A job's name with a break allowed after its underscores. */
const nameOf = (name: string): string => esc(name).replace(/_/g, '_<wbr>');

/** The mark of a run that went past the morning end of the window: «07+». */
const lateMark = (report: CalendarReport): string => `${hm(report.window.to).slice(0, 2)}+`;

/** Whether the day is already past: today's night has not run yet. */
const isPast = (report: CalendarReport, day: number): boolean => (report.today === undefined ? true : day < report.today);

/* ------------------------------------------------------------------ *
 * What the pages are figured from
 * ------------------------------------------------------------------ */

const overran = (report: CalendarReport, run: { start: number; minutes: number }): boolean => overranIn(report.window, run);

/** How bad a run went, worst first: the one a day's cell shows when a job ran more than once. */
const WORST: CalendarResult[] = ['failed', 'missed', 'warning', 'running', 'success'];
const worstOf = (runs: CalendarRun[]): CalendarRun | undefined =>
  [...runs].sort((a, b) => WORST.indexOf(a.result) - WORST.indexOf(b.result) || Number(b.full) - Number(a.full))[0];

const runsOn = (report: CalendarReport, day: number): Array<{ job: CalendarJob; run: CalendarRun }> =>
  report.jobs.flatMap((job) => job.runs.filter((run) => run.day === day).map((run) => ({ job, run })));

const allRuns = (report: CalendarReport): CalendarRun[] => report.jobs.flatMap((job) => job.runs);

const KIND_WORD: Record<CalendarJob['kind'], string> = { backup: 'Backup', copy: 'Backup Copy', replica: 'Replica' };

/* ------------------------------------------------------------------ *
 * 1. The cover
 * ------------------------------------------------------------------ */

const cover = (report: CalendarReport, stamp: string, foot: string): string => {
  const active = report.jobs.filter((job) => job.enabled);
  const off = report.jobs.length - active.length;
  const runs = allRuns(report).filter((run) => run.result !== 'running');
  const count = (result: CalendarResult) => runs.filter((run) => run.result === result).length;
  const ok = count('success');
  const rate = runs.length ? Math.round((100 * (ok + count('warning'))) / runs.length) : 0;
  const fullsDone = runs.filter((run) => run.full).length;
  const fullsPlanned = report.jobs.filter((job) => job.enabled).reduce((sum, job) => sum + job.planned.filter((plan, index) => plan === 'full' && !isPast(report, index + 1)).length, 0);
  const heaviest = heaviestFullDay(report);
  const late = runs.filter((run) => overran(report, run)).length;
  const lateDays = new Set(runs.filter((run) => overran(report, run)).map((run) => run.day)).size;

  const tile = (label: string, value: string, detail: string, tone = '') =>
    `<div class="cv-tile ${tone}"><div class="cv-tk">${label}</div><div class="cv-tv">${value}</div><div class="cv-td">${detail}</div></div>`;
  const tiles = [
    tile('Заданий', `${active.length}`, off ? `и ${off} ${plural(off, 'отключено', 'отключены', 'отключены')}` : 'все включены'),
    tile('Запусков за месяц', `${runs.length}`, `<b class="ok"><i class="sw s"></i>${ok}</b> <b class="warn"><i class="sw w"></i>${count('warning')}</b> <b class="crit"><i class="sw x"></i>${count('failed') + count('missed')}</b>`),
    tile('Успешно', `${rate}<small>%</small>`, 'с предупреждением тоже считаются', rate < 90 ? 'crit' : rate < 97 ? 'warn' : ''),
    tile('Full за месяц', `${fullsDone}`, `<i class="sw f"></i>ещё ${fullsPlanned} по плану${heaviest ? ` · больше всего ${heaviest.day}-го: ${heaviest.fulls}` : ''}`),
    tile('Позже 07:00', `${late}`, late ? `${lateDays} ${plural(lateDays, 'ночь', 'ночи', 'ночей')}: залезли в рабочий день` : 'всё уложилось в окно', late ? 'crit' : ''),
  ];

  return `<section class="g-cover cv">
  ${guideBand('календарь заданий')}
  <div class="g-kicker">Календарь заданий</div>
  <h1 class="g-title">${esc(report.server)} · ${monthName(report)}</h1>
  <hr class="g-rule">
  <div class="g-meta"><span>${active.length} ${plural(active.length, 'задание', 'задания', 'заданий')}${report.infrastructure ? ` · ${report.infrastructure.machines} ВМ · ${report.infrastructure.vcenters.length} vCenter · ${report.infrastructure.proxies.length} прокси` : ''}</span><span>окно ${hm(report.window.from)}–${hm(report.window.to)}</span><span>${report.today ? `сегодня ${report.today} ${MONTHS_OF[report.month]}` : 'месяц прошёл'}</span><span>${stamp}</span></div>
  <div class="g-note ${report.verdict.status}"><b>${STATUS_WORD[report.verdict.status]}:</b> ${esc(report.verdict.text)}</div>
  <div class="cv-tiles">${tiles.join('')}</div>
  <div class="cv-cols">
    <div><h2 class="g-h2">На что обратить внимание</h2>${findings(report)}</div>
    <div><h2 class="g-h2">${report.today ? 'Сегодня ночью' : 'Последняя ночь'}</h2>${tonight(report)}</div>
  </div>
  ${guideFoot(foot)}
</section>`;
};

const findings = (report: CalendarReport): string =>
  report.findings.length
    ? `<div class="cv-steps">${report.findings
        .slice(0, 5)
        .map((finding, index) => `<div class="cv-step ${finding.status}"><span class="n">${index + 1}</span><div><b>${esc(finding.title)}</b><p>${esc(finding.text)}</p></div></div>`)
        .join('')}</div>`
    : '<p class="muted">Всё по расписанию и в окне.</p>';

/** Tonight's runs in the order they start, each with its usual end and whether it writes a Full. */
const tonightRuns = (report: CalendarReport) => {
  const day = report.today ?? daysIn(report);
  return report.jobs
    .filter((job) => job.enabled && job.planned[day - 1])
    .map((job) => {
      const full = job.planned[day - 1] === 'full';
      const start = startOf(report, job);
      const minutes = (full ? job.usualFull : undefined) ?? job.usual ?? 0;
      return { job, full, start, minutes };
    })
    .filter((row) => row.start !== undefined)
    .sort((a, b) => fromNoon(a.start as number) - fromNoon(b.start as number));
};

/** As many of tonight's runs as the cover has room for. */
const TONIGHT_ON_COVER = 11;
/** Tonight's runs on a page of their own. */
const TONIGHT_ROWS = 32;

const tonight = (report: CalendarReport): string => {
  const rows = tonightRuns(report);
  if (!rows.length) return '<p class="muted">Ничего не запланировано.</p>';
  const shown = rows.slice(0, TONIGHT_ON_COVER);
  return `<table class="g-table cv-night"><thead><tr><th>Старт</th><th>Задание</th><th>Конец ≈</th></tr></thead><tbody>${shown
    .map(({ job, full, start, minutes }) => {
      const late = overran(report, { start: start as number, minutes });
      return `<tr><td class="t">${job.after ? '↳ ' : ''}${hm(start as number)}</td><td>${nameOf(job.name)}${full ? ' <span class="vbk">.vbk</span>' : ''}</td><td class="t${late ? ' late' : ''}">${hm((start as number) + minutes)}</td></tr>`;
    })
    .join('')}</tbody></table>${rows.length > shown.length ? `<p class="muted more">и ещё ${rows.length - shown.length} — все запуски ночи на отдельной странице</p>` : ''}`;
};

/** Every one of tonight's runs, when the cover could not hold them. */
const tonightPages = (report: CalendarReport): string => {
  const rows = tonightRuns(report);
  if (rows.length <= TONIGHT_ON_COVER) return '';
  const pages: string[] = [];
  for (let from = 0; from < rows.length; from += TONIGHT_ROWS) {
    const chunk = rows.slice(from, from + TONIGHT_ROWS);
    const body = chunk
      .map(({ job, full, start, minutes }) => {
        const late = overran(report, { start: start as number, minutes });
        return `<tr><td class="t">${job.after ? '↳ ' : ''}${hm(start as number)}</td><td class="nm">${nameOf(job.name)}${full ? ' <span class="vbk">.vbk</span>' : ''}</td><td>${esc(job.schedule)}</td><td class="nw">${job.repository ? esc(job.repository) : '—'}</td><td class="t">${minutes ? spanOf(minutes) : '—'}</td><td class="t${late ? ' late' : ''}">${hm((start as number) + minutes)}</td></tr>`;
      })
      .join('');
    pages.push(`<section class="pg"><h2 class="g-h2">${report.today ? 'Сегодня ночью' : 'Последняя ночь'} <small>${from + 1}–${from + chunk.length} из ${rows.length} · по времени старта</small></h2>
<table class="g-table sch"><thead><tr><th>Старт</th><th>Задание</th><th>Расписание</th><th>Репозиторий</th><th>Идёт обычно</th><th>Конец ≈</th></tr></thead><tbody>${body}</tbody></table></section>`);
  }
  return pages.join('');
};

/* ------------------------------------------------------------------ *
 * 2. The month as a wall calendar
 * ------------------------------------------------------------------ */

const calendar = (report: CalendarReport): string => {
  const days = daysIn(report);
  const lead = weekdayOf(report, 1);
  const cells: string[] = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="cd out"></div>');
  for (let day = 1; day <= days; day++) cells.push(dayCell(report, day));
  while (cells.length % 7) cells.push('<div class="cd out"></div>');
  const weeks = cells.length / 7;
  return `<section class="pg">
  <h2 class="g-h2">Календарь · ${monthName(report)} <small>каждая ночь по дню, когда задания стартовали</small></h2>
  <div class="cal" style="grid-template-rows: auto repeat(${weeks}, minmax(0, 1fr))">${WEEKDAYS.map((name, index) => `<div class="wd${index >= 5 ? ' we' : ''}">${name}</div>`).join('')}${cells.join('')}</div>
  <div class="legend"><span><i class="sw s"></i>успешно</span><span><i class="sw f"></i>Full .vbk</span><span><i class="sw w"></i>с предупреждением</span><span><i class="sw x"></i>ошибка</span><span><i class="sw p"></i>по плану</span><span><i class="sw pf"></i>по плану Full</span><span><span class="lt">${lateMark(report)}</span> закончилось после ${hm(report.window.to)}</span></div>
</section>`;
};

/** How many named lines a day's cell has room for: fewer when the month spreads over six weeks. */
const linesIn = (report: CalendarReport): number => ((weekdayOf(report, 1) + daysIn(report)) > 35 ? 3 : 4);

const dayCell = (report: CalendarReport, day: number): string => {
  const classes = ['cd', isWeekend(report, day) ? 'we' : '', report.today === day ? 'today' : ''].filter(Boolean).join(' ');
  const head = `<div class="dn"><b>${day}</b>${report.today === day ? '<span class="tag">сегодня</span>' : ''}</div>`;
  if (isPast(report, day)) {
    const runs = runsOn(report, day);
    if (!runs.length) return `<div class="${classes}">${head}<div class="muted">запусков не было</div></div>`;
    const of = (result: CalendarResult) => runs.filter(({ run }) => run.result === result).length;
    const bad = of('failed') + of('missed');
    const chips = `<div class="chips"><span class="ok"><i class="sw s"></i>${of('success')}</span>${of('warning') ? `<span class="warn"><i class="sw w"></i>${of('warning')}</span>` : ''}${bad ? `<span class="crit"><i class="sw x"></i>${bad}</span>` : ''}</div>`;
    // What deserves a line: what failed, then what warned, then the Fulls; the rest is counted.
    const rank = ({ run }: { run: CalendarRun }) => (run.result === 'failed' || run.result === 'missed' ? 0 : run.result === 'warning' ? 1 : run.full ? 2 : 3);
    const notable = runs.filter((entry) => rank(entry) < 3).sort((a, b) => rank(a) - rank(b) || fromNoon(a.run.start) - fromNoon(b.run.start));
    const shown = notable.slice(0, linesIn(report));
    const lines = shown.map(({ job, run }) => {
      const kind = run.result === 'failed' || run.result === 'missed' ? 'x' : run.result === 'warning' ? 'w' : 'f';
      const late = overran(report, run) ? `<span class="lt">${lateMark(report)}</span>` : '';
      return `<div class="ln"><i class="sw ${kind}"></i><span class="tm">${run.result === 'missed' ? 'нет' : hm(run.start)}</span><span class="nm">${esc(job.name)}</span>${late}</div>`;
    });
    const rest = runs.length - shown.length;
    const late = runs.filter(({ run }) => overran(report, run)).length;
    const lateSaid = late && !shown.some((entry) => overran(report, entry.run)) ? ` · <span class="lt">${lateMark(report)}</span> ${late}` : '';
    return `<div class="${classes}${bad ? ' bad' : ''}">${head}${chips}${lines.join('')}${rest > 0 && shown.length ? `<div class="rest">+ ${rest} ${plural(rest, 'успешный', 'успешных', 'успешных')}${lateSaid}</div>` : lateSaid ? `<div class="rest">${lateSaid.slice(3)}</div>` : ''}</div>`;
  }
  const planned = report.jobs.filter((job) => job.enabled && job.planned[day - 1]);
  if (!planned.length) return `<div class="${classes} plan">${head}<div class="muted">ничего</div></div>`;
  const fulls = planned.filter((job) => job.planned[day - 1] === 'full');
  const lines = fulls.slice(0, linesIn(report)).map((job) => {
    const start = startOf(report, job);
    return `<div class="ln"><i class="sw pf"></i><span class="tm">${start === undefined ? '' : hm(start)}</span><span class="nm">${esc(job.name)}</span></div>`;
  });
  return `<div class="${classes} plan">${head}<div class="chips"><span class="pl">план: ${planned.length}</span>${fulls.length ? `<span class="fl">Full: ${fulls.length}</span>` : ''}</div>${lines.join('')}${fulls.length > linesIn(report) ? `<div class="rest">+ ${fulls.length - linesIn(report)} Full</div>` : ''}</div>`;
};

/* ------------------------------------------------------------------ *
 * 3. Every job against every day
 * ------------------------------------------------------------------ */

const ROWS_PER_PAGE = 30;

const matrix = (report: CalendarReport): string => {
  const days = daysIn(report);
  const jobs = [...report.jobs].sort((a, b) => Number(b.enabled) - Number(a.enabled) || (fromNoon(startOf(report, a) ?? 1e4) - fromNoon(startOf(report, b) ?? 1e4)));
  const head = `<thead><tr><th class="nmh">Задание</th><th class="st">Старт</th>${Array.from({ length: days }, (_, index) => {
    const day = index + 1;
    return `<th class="dh${isWeekend(report, day) ? ' we' : ''}${report.today === day ? ' today' : ''}">${day}<small>${WEEKDAYS[weekdayOf(report, day)].toLowerCase()}</small></th>`;
  }).join('')}<th class="pc">Успешно</th></tr></thead>`;
  const pages: string[] = [];
  for (let from = 0; from < jobs.length; from += ROWS_PER_PAGE) {
    const chunk = jobs.slice(from, from + ROWS_PER_PAGE);
    const rows = chunk.map((job) => {
      const cells = Array.from({ length: days }, (_, index) => {
        const day = index + 1;
        const plan = job.planned[index];
        const cls = [isWeekend(report, day) ? 'we' : '', report.today === day ? 'today' : ''].filter(Boolean).join(' ');
        let mark = '';
        if (isPast(report, day)) {
          const run = worstOf(job.runs.filter((candidate) => candidate.day === day));
          if (run) {
            const kind = run.result === 'success' ? (run.full ? 'f' : 's') : run.result === 'warning' ? 'w' : run.result === 'running' ? 'r' : run.result === 'missed' ? 'm' : 'x';
            mark = `<i class="mx ${kind}${overran(report, run) ? ' late' : ''}"></i>`;
          }
        } else if (plan && job.enabled) mark = `<i class="mx ${plan === 'full' ? 'pf' : 'p'}"></i>`;
        return `<td class="${cls}">${mark}</td>`;
      }).join('');
      const done = job.runs.filter((run) => run.result !== 'running');
      const good = done.filter((run) => run.result === 'success' || run.result === 'warning').length;
      const rate = done.length ? Math.round((100 * good) / done.length) : undefined;
      const start = startOf(report, job);
      return `<tr class="${job.enabled ? '' : 'off'}"><td class="nm">${nameOf(job.name)}${job.kind !== 'backup' ? ` <span class="copy">${job.kind}</span>` : ''}</td><td class="st">${job.enabled ? (start === undefined ? 'вручную' : `${job.after ? '↳' : ''}${hm(start)}`) : 'выкл.'}</td>${cells}<td class="pc${rate !== undefined && rate < 90 ? ' bad' : ''}">${rate === undefined ? '—' : `${rate}%`}</td></tr>`;
    });
    const title = from === 0 ? `Задания по дням <small>${jobs.length} ${plural(jobs.length, 'задание', 'задания', 'заданий')} · прошедшие дни по факту, будущие по плану</small>` : `Задания по дням <small>${from + 1}–${from + chunk.length} из ${jobs.length}</small>`;
    const rowH = Math.min(7, Math.max(4.5, 140 / chunk.length));
    pages.push(`<section class="pg"><h2 class="g-h2">${title}</h2><table class="mt" style="--row: ${rowH.toFixed(2)}mm">${head}<tbody>${rows.join('')}</tbody></table>
  <div class="legend"><span><i class="sw s"></i>успешно</span><span><i class="sw f"></i>Full .vbk</span><span><i class="sw w"></i>с предупреждением</span><span><i class="sw x"></i>ошибка</span><span><i class="sw m"></i>не запускалось по расписанию</span><span><i class="sw p"></i>по плану</span><span><i class="sw pf"></i>по плану Full</span><span><i class="sw s late"></i>закончилось после ${hm(report.window.to)}</span></div></section>`);
  }
  return pages.join('');
};

/* ------------------------------------------------------------------ *
 * 4. One night, noon to noon
 * ------------------------------------------------------------------ */

const LABEL = 250;
const AXIS = 860;
const W = LABEL + AXIS + 20;
const x = (minutesFromNoon: number): number => LABEL + (AXIS * Math.min(Math.max(minutesFromNoon, 0), DAY)) / DAY;

/** Rows of the night on one page; a server with more jobs gets more pages of it. */
const NIGHT_ROWS = 36;
/** As many jobs as still leave the page room for the chart of how many run at once. */
const NIGHT_ROWS_WITH_LOAD = 16;

const night = (report: CalendarReport): string => {
  const timed = report.jobs
    .filter((job) => job.enabled)
    .map((job) => ({ job, start: startOf(report, job) }))
    .filter((entry): entry is { job: CalendarJob; start: number } => entry.start !== undefined)
    .sort((a, b) => fromNoon(a.start) - fromNoon(b.start));
  const manual = report.jobs.filter((job) => job.enabled && startOf(report, job) === undefined && !job.every);
  const periodic = report.jobs.filter((job) => job.enabled && job.every);
  const legend = `<div class="legend"><span><i class="sw s"></i>обычно идёт</span><span><i class="sw copy"></i>Backup Copy, реплика</span><span><i class="sw tail"></i>дольше всего</span><span><i class="sw x"></i>обычно идёт после ${hm(report.window.to)}</span><span><i class="sw tail-late"></i>бывало после ${hm(report.window.to)}</span><span><i class="sw ln-f"></i>в ночь с Full</span><span><i class="sw wait"></i>ждёт прокси или репозиторий</span><span><b>↳</b> стартует после другого задания</span></div>`;
  const heading = (part: string) => `<h2 class="g-h2">Одна ночь по часам <small>${part}обычный старт и длительность каждого задания · окно ${hm(report.window.from)}–${hm(report.window.to)} подсвечено</small></h2>`;
  const notes = `${periodic.length ? `<p class="muted manual">Запускаются по нескольку раз в сутки, на шкале их нет: ${periodic.map((job) => `${esc(job.name)} (каждые ${spanOf(job.every as number)})`).join(', ')}.</p>` : ''}
  ${manual.length ? `<p class="muted manual">Без расписания, только вручную: ${manual.map((job) => esc(job.name)).join(', ')}.</p>` : ''}`;
  const load = `<h2 class="g-h2">Сколько идёт одновременно</h2>${overlap(report)}${notes}`;

  if (timed.length <= NIGHT_ROWS_WITH_LOAD) return `<section class="pg">${heading('')}${gantt(report, timed, 19)}${legend}${load}</section>`;
  const pages: string[] = [];
  for (let from = 0; from < timed.length; from += NIGHT_ROWS) {
    const chunk = timed.slice(from, from + NIGHT_ROWS);
    const part = `${from + 1}–${from + chunk.length} из ${timed.length} · `;
    pages.push(`<section class="pg">${heading(part)}${gantt(report, chunk, 17)}${legend}</section>`);
  }
  return `${pages.join('')}<section class="pg">${load.replace('<h2 class="g-h2">', '<h2 class="g-h2 first">')}</section>`;
};

/** The night of `timed` jobs, one row each, noon to noon. */
const gantt = (report: CalendarReport, timed: Array<{ job: CalendarJob; start: number }>, rowH: number): string => {
  const top = 26;
  const height = top + rowH * timed.length + 8;
  const windowFrom = x(fromNoon(report.window.from));
  const windowTo = x(fromNoon(report.window.to));
  const end = fromNoon(report.window.to);
  const grid = Array.from({ length: 13 }, (_, index) => {
    const at = index * 120;
    return `<line class="g" x1="${x(at)}" y1="${top - 4}" x2="${x(at)}" y2="${height}"/><text x="${x(at)}" y="${top - 9}" text-anchor="middle">${hm(720 + at)}</text>`;
  }).join('');
  const rect = (cls: string, from: number, to: number, y: number, h: number) =>
    to > from ? `<rect class="${cls}" x="${x(from).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(x(to) - x(from), 1.5).toFixed(1)}" height="${h.toFixed(1)}"/>` : '';
  const bars = timed
    .map(({ job, start }, index) => {
      const y = top + index * rowH;
      const from = fromNoon(start);
      const usual = job.usual ?? 0;
      const longest = Math.max(job.longest ?? usual, usual);
      const barY = y + rowH * 0.22;
      const barH = rowH * 0.5;
      const late = from < end;
      const parts = [
        `<text class="nm" x="${LABEL - 8}" y="${y + rowH * 0.62}" text-anchor="end">${job.after ? '↳ ' : ''}${esc(job.name.length > 34 ? `${job.name.slice(0, 33)}…` : job.name)}</text>`,
        job.waited && job.start !== undefined ? rect('wait', from - job.waited, from, barY, barH) : '',
        rect('tail', from + usual, late ? Math.min(from + longest, end) : from + longest, barY, barH),
        late ? rect('tail-late', Math.max(from + usual, end), from + longest, barY, barH) : '',
        rect(job.kind !== 'backup' ? 'copy' : 'bar', from, late ? Math.min(from + usual, end) : from + usual, barY, barH),
        late ? rect('over', end, from + usual, barY, barH) : '',
        job.usualFull ? rect('full', from, from + job.usualFull, barY + barH + 0.8, Math.max(rowH * 0.13, 1.6)) : '',
      ];
      const label = x(Math.min(from + longest, DAY)) + 4;
      parts.push(label < W - 70
        ? `<text class="tm" x="${label}" y="${y + rowH * 0.62}">${hm(start)}–${hm(start + usual)}</text>`
        : `<text class="tm" x="${x(from) - 4}" y="${y + rowH * 0.62}" text-anchor="end">${hm(start)}–${hm(start + usual)}</text>`);
      return parts.join('');
    })
    .join('');
  return `<svg class="gantt" viewBox="0 0 ${W} ${height}"><rect class="win" x="${windowFrom}" y="${top - 4}" width="${windowTo - windowFrom}" height="${height - top + 4}"/>${grid}${bars}<line class="edge" x1="${windowTo}" y1="${top - 4}" x2="${windowTo}" y2="${height}"/></svg>`;
};

/** How many jobs run at once through the night, on an ordinary night and on the heaviest night with a Full; and the free stretches in the window. */
const overlap = (report: CalendarReport): string => {
  const STEP = LOAD_STEP;
  const heaviest = heaviestFullDay(report);
  const ordinary = nightLoad(report);
  const heavy = heaviest ? nightLoad(report, heaviest.day) : ordinary;
  const peak = Math.max(1, ...ordinary, ...heavy);
  const H = 120;
  const top = 18;
  const y = (n: number) => top + H - (H * n) / peak;
  const path = (counts: number[]) => counts.map((n, slot) => `${slot ? 'L' : 'M'}${x(slot * STEP).toFixed(1)} ${y(n).toFixed(1)} L${x((slot + 1) * STEP).toFixed(1)} ${y(n).toFixed(1)}`).join(' ');
  const area = `${path(ordinary)} L${x(DAY)} ${y(0)} L${x(0)} ${y(0)} Z`;

  const from = fromNoon(report.window.from);
  const to = fromNoon(report.window.to);
  const free = freeStretches(report.window, ordinary);
  const peakAt = ordinary.indexOf(Math.max(...ordinary)) * STEP;

  const levels = Array.from({ length: peak + 1 }, (_, n) => n)
    .filter((n) => peak <= 6 || n % 2 === 0)
    .map((n) => `<line class="g" x1="${LABEL}" y1="${y(n)}" x2="${x(DAY)}" y2="${y(n)}"/><text x="${LABEL - 8}" y="${y(n) + 4}" text-anchor="end">${n}</text>`)
    .join('');
  const hours = Array.from({ length: 13 }, (_, index) => `<text x="${x(index * 120)}" y="${top + H + 16}" text-anchor="middle">${hm(720 + index * 120)}</text>`).join('');
  const freeMarks = free
    .map(([a, b]) => `<rect class="free" x="${x(a)}" y="${top}" width="${x(b) - x(a)}" height="${H}"/><text class="fr" x="${(x(a) + x(b)) / 2}" y="${top + 16}" text-anchor="middle">свободно ${hm(720 + a)}–${hm(720 + b)}</text>`)
    .join('');
  const svg = `<svg class="load" viewBox="0 0 ${W} ${top + H + 24}"><rect class="win" x="${x(from)}" y="${top}" width="${x(to) - x(from)}" height="${H}"/>${freeMarks}${levels}<path class="area" d="${area}"/><path class="line" d="${path(ordinary)}"/><path class="heavy" d="${path(heavy)}"/>${hours}</svg>`;
  const heavyDay = heaviest ? `${heaviest.day} ${MONTHS_OF[report.month]}` : '';
  return `${svg}<div class="legend"><span><i class="sw s"></i>обычная ночь</span>${heavyDay ? `<span><i class="sw ln-f"></i>самая тяжёлая ночь с Full: ${heavyDay}</span>` : ''}<span>больше всего в ${hm(720 + peakAt)}: ${Math.max(...ordinary)} ${plural(Math.max(...ordinary), 'задание', 'задания', 'заданий')}${heavyDay ? `, в ночь с Full до ${Math.max(...heavy)}` : ''}</span>${free.length ? `<span><i class="sw free"></i>сюда можно поставить новое задание</span>` : ''}</div>`;
};

/* ------------------------------------------------------------------ *
 * 5. Machines, vCenters and proxies
 * ------------------------------------------------------------------ */

/** How many machines run at once on an ordinary night at its busiest, and when. */
const machinesAtPeak = (report: CalendarReport): { at: number; machines: number } => {
  const timed = report.jobs.filter((job) => job.enabled && job.machines).flatMap((job) => {
    const start = startOf(report, job);
    return start === undefined ? [] : [{ from: fromNoon(start), minutes: job.usual ?? 0, machines: job.machines as number }];
  });
  let best = { at: 0, machines: 0 };
  for (let at = 0; at < DAY; at += LOAD_STEP) {
    const machines = timed.filter(({ from, minutes }) => at >= from && at < from + minutes).reduce((sum, job) => sum + job.machines, 0);
    if (machines > best.machines) best = { at, machines };
  }
  return best;
};

/** What a job names to back up, in a line: «SQL01, SQL02, Prod (папка) и ещё 4». */
const objectsOf = (job: CalendarJob): string => {
  const objects = job.objects ?? [];
  const shown = objects.slice(0, 5).map(({ name, kind }) => `${esc(name)}${kind ? ` <span class="muted">(${kind})</span>` : ''}`);
  return `${shown.join(', ')}${objects.length > shown.length ? ` <span class="muted">и ещё ${objects.length - shown.length}</span>` : ''}` || '—';
};

const infrastructure = (report: CalendarReport): string => {
  const infra = report.infrastructure;
  if (!infra) return '';
  const slots = infra.proxies.reduce((sum, proxy) => sum + (proxy.tasks ?? 0), 0);
  const peak = machinesAtPeak(report);
  const active = report.jobs.filter((job) => job.enabled);
  const tile = (label: string, value: string, detail: string, tone = '') =>
    `<div class="cv-tile ${tone}"><div class="cv-tk">${label}</div><div class="cv-tv">${value}</div><div class="cv-td">${detail}</div></div>`;
  const tiles = [
    tile('ВМ в заданиях', `${infra.machines}`, 'у которых есть точки восстановления, каждая один раз'),
    tile('vCenter', `${infra.vcenters.length}`, infra.vcenters.slice(0, 2).map((vcenter) => esc(vcenter.name)).join(', ') || '—'),
    tile('Прокси', `${infra.proxies.length}`, slots ? `всего ${slots} ${plural(slots, 'слот', 'слота', 'слотов')} одновременно` : 'слоты не известны'),
    tile('Пик ночи', `${peak.machines}<small> ВМ</small>`, peak.machines ? `в ${hm(720 + peak.at)}${slots ? ` при ${slots} слотах прокси` : ''}` : '—', slots && peak.machines > slots ? 'warn' : ''),
    tile('Прокси выбирает Veeam', `${infra.automatic.length}`, `из ${active.length} ${plural(active.length, 'задания', 'заданий', 'заданий')}, остальные закреплены`),
  ];

  const vcenterRows = infra.vcenters
    .map((vcenter) => `<tr><td class="nm">${esc(vcenter.name)}</td><td class="t">${vcenter.jobs.length}</td><td class="t">${vcenter.machines}</td></tr>`)
    .join('');
  const proxyRows = infra.proxies
    .map((proxy) => `<tr><td class="nm nw">${esc(proxy.name)}</td><td class="nw">${proxy.mode ?? '—'}</td><td class="t">${proxy.tasks ?? '—'}</td><td>${proxy.pinned.length ? `${proxy.pinned.length}: ${proxy.pinned.slice(0, 4).map((name) => esc(name)).join(', ')}${proxy.pinned.length > 4 ? ` <span class="muted">и ещё ${proxy.pinned.length - 4}</span>` : ''}` : '<span class="muted">только авто</span>'}</td></tr>`)
    .join('');
  const overview = `<section class="pg"><h2 class="g-h2">Машины, vCenter и прокси <small>что бэкапят задания сервера и через что</small></h2>
<div class="cv-tiles">${tiles.join('')}</div>
${slots && peak.machines > slots ? `<div class="g-note">В пик ночи, около ${hm(720 + peak.at)}, задания обрабатывают до ${peak.machines} ВМ, а у прокси ${slots} ${plural(slots, 'слот', 'слота', 'слотов')}: часть машин ждёт в очереди. Это и есть «ждёт старта» в справочнике.</div>` : ''}
<div class="cv-cols infra">
  <div><h2 class="g-h2">vCenter</h2>${vcenterRows ? `<table class="g-table sch"><thead><tr><th>vCenter</th><th>Заданий</th><th>ВМ</th></tr></thead><tbody>${vcenterRows}</tbody></table>` : '<p class="muted">Задания не назвали ни одного vCenter.</p>'}</div>
  <div><h2 class="g-h2">Прокси</h2>${proxyRows ? `<table class="g-table sch"><thead><tr><th>Прокси</th><th>Режим</th><th>Слотов</th><th>Закреплены задания</th></tr></thead><tbody>${proxyRows}</tbody></table>` : '<p class="muted">Список прокси не прочитан.</p>'}</div>
</div></section>`;

  // Every job under its vCenter, the most machines first; a job of two vCenters under each.
  const byStart = (a: CalendarJob, b: CalendarJob) => (b.machines ?? 0) - (a.machines ?? 0) || a.name.localeCompare(b.name);
  const row = (job: CalendarJob) => {
    const start = startOf(report, job);
    return `<tr><td class="nm">${nameOf(job.name)}</td><td class="t">${start === undefined ? (job.every ? `каждые ${spanOf(job.every)}` : 'вручную') : `${job.after ? '↳ ' : ''}${hm(start)}`}</td><td class="t">${job.machines ?? '—'}</td><td>${objectsOf(job)}</td><td>${job.proxies ? job.proxies.map((name) => esc(name)).join(', ') || '—' : '<span class="muted">авто</span>'}</td><td class="nw">${job.repository ? esc(job.repository) : '—'}</td></tr>`;
  };
  const head = '<thead><tr><th>Задание</th><th>Старт</th><th>ВМ</th><th>Что в задании</th><th>Прокси</th><th>Репозиторий</th></tr></thead>';
  const groups = infra.vcenters.map((vcenter) => {
    const its = active.filter((job) => job.vcenters?.includes(vcenter.name)).sort(byStart);
    return `<h2 class="g-h2 vc">${esc(vcenter.name)} <small>${vcenter.machines} ВМ · ${its.length} ${plural(its.length, 'задание', 'задания', 'заданий')}</small></h2><table class="g-table sch vct">${head}<tbody>${its.map(row).join('')}</tbody></table>`;
  });
  const other = active.filter((job) => !job.vcenters?.length).sort(byStart);
  if (other.length) groups.push(`<h2 class="g-h2 vc">Без vCenter <small>копии, агенты и задания, что не назвали машин · ${other.length}</small></h2><table class="g-table sch vct">${head}<tbody>${other.map(row).join('')}</tbody></table>`);
  return `${overview}<section class="pg"><h2 class="g-h2 first">Задания по vCenter <small>какие задания бэкапят машины каждого vCenter</small></h2>${groups.join('')}</section>`;
};

/* ------------------------------------------------------------------ *
 * 6. Every job's schedule, as a table
 * ------------------------------------------------------------------ */

const table = (report: CalendarReport): string => {
  const rows = [...report.jobs]
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || fromNoon(startOf(report, a) ?? 1e4) - fromNoon(startOf(report, b) ?? 1e4))
    .map((job) => {
      const start = startOf(report, job);
      const done = job.runs.filter((run) => run.result !== 'running');
      const good = done.filter((run) => run.result === 'success' || run.result === 'warning').length;
      const rate = done.length ? Math.round((100 * good) / done.length) : undefined;
      const late = start !== undefined && job.longest !== undefined && overran(report, { start, minutes: job.longest });
      return `<tr class="${job.enabled ? '' : 'off'}">
<td class="nm">${nameOf(job.name)}</td>
<td class="nw">${KIND_WORD[job.kind]}${job.enabled ? '' : '<br><span class="muted">отключено</span>'}</td>
<td class="t">${job.machines ?? '—'}</td>
<td>${esc(job.schedule)}</td>
<td>${job.fullRule ? esc(job.fullRule) : '—'}</td>
<td class="nw">${job.repository ? esc(job.repository) : '—'}</td>
<td class="nw">${job.retention ? esc(job.retention) : '—'}</td>
<td class="t">${job.usual ? spanOf(job.usual) : '—'}${job.longest && job.longest > (job.usual ?? 0) ? `<br><span class="muted">до ${spanOf(job.longest)}</span>` : ''}${job.outliers ? `<br><span class="muted">и ${job.outliers} ${plural(job.outliers, 'зависший', 'зависших', 'зависших')}</span>` : ''}</td>
<td class="t">${start !== undefined && job.usual ? `${hm(start + job.usual)}${late ? `<br><span class="late">до ${hm(start + (job.longest as number))}</span>` : ''}` : '—'}</td>
<td class="t">${job.waited ? `<span class="warnc">${spanOf(job.waited)}</span>` : '—'}</td>
<td class="t${rate !== undefined && rate < 90 ? ' late' : ''}">${rate === undefined ? '—' : `${rate}%`}</td>
<td class="t">${job.enabled && job.next ? esc(job.next) : '—'}</td></tr>`;
    })
    .join('');
  return `<section class="pg"><h2 class="g-h2">Расписание каждого задания <small>справочник</small></h2>
<table class="g-table sch"><thead><tr><th>Задание</th><th>Тип</th><th>ВМ</th><th>Расписание</th><th>Full</th><th>Репозиторий</th><th>Хранить</th><th>Идёт</th><th>Конец обычно</th><th>Ждёт старта</th><th>Успешно</th><th>Следующий</th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted manual">«Ждёт старта» — сколько задание обычно стоит в очереди после своего времени, пока освободится прокси или слот репозитория: если ждёт долго, ресурсов на эту ночь мало.</p></section>`;
};

/* ------------------------------------------------------------------ *
 * The style
 * ------------------------------------------------------------------ */

const STYLE = `
@page { size: 297mm 210mm; margin: 12mm 14mm 14mm; }
.g-cover { height: 210mm; padding: 0 14mm; }
.g-band { margin: 0 -14mm; height: 30mm; }
.g-band .veeam-logo { left: 14mm; top: 7.5mm; }
.g-product { left: 14mm; top: 17.5mm; }
.g-foot { left: 14mm; right: 14mm; bottom: 6.5mm; }
.g-kicker { margin-top: 5.5mm; }
.g-title { font-size: 24pt; }
.g-note { margin-top: 3.4mm; padding: 2.2mm 4mm; }
.g-h2 { margin: 4.5mm 0 2mm; font-size: 14pt; }
.pg { break-before: page; }
.pg > .g-h2:first-child, .g-h2.first { margin-top: 0; }
.muted { color: ${GUIDE.muted}; }
b.ok, .chips .ok { color: #00873c; } b.warn, .chips .warn { color: #c4600a; } b.crit, .chips .crit, .late { color: ${GUIDE.failed}; }
.late { font-weight: 650; }

/* the cover */
.cv-tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); border: 0.25mm solid ${GUIDE.rule}; margin-top: 4mm; }
.cv-tile { border-left: 0.25mm solid ${GUIDE.rule}; } .cv-tile:first-child { border-left: none; }
.cv-tk { background: ${GUIDE.head}; color: #fff; font-weight: 500; font-size: 8pt; padding: 1.6mm 2.6mm; }
.cv-tv { font-size: 18pt; font-weight: 300; line-height: 1.15; padding: 1.6mm 2.6mm 0; } .cv-tv small { font-size: 10pt; color: ${GUIDE.muted}; }
.cv-tile.crit .cv-tv { color: ${GUIDE.failed}; } .cv-tile.warn .cv-tv { color: #d06a10; }
.cv-td { font-size: 7.6pt; color: ${GUIDE.muted}; padding: 0.4mm 2.6mm 2mm; } .cv-td b { font-weight: 650; margin-right: 1.6mm; }
.cv-cols { display: grid; grid-template-columns: 1.25fr 1fr; gap: 9mm; }
.cv-steps { display: flex; flex-direction: column; gap: 2.2mm; }
.cv-step { display: flex; gap: 2.4mm; }
.cv-step .n { flex: none; width: 5mm; height: 5mm; border-radius: 50%; background: ${GUIDE.green}; color: #fff; font-weight: 650; font-size: 7.8pt; display: flex; align-items: center; justify-content: center; }
.cv-step.crit .n { background: ${GUIDE.failed}; } .cv-step.warn .n { background: ${GUIDE.warning}; }
.cv-step b { font-weight: 650; font-size: 8.8pt; } .cv-step p { margin: 0.2mm 0 0; color: #333; font-size: 8.2pt; line-height: 1.35; }
.cv-night td, .cv-night th { padding: 1mm 2.2mm; font-size: 8pt; }
.cv-night .t { white-space: nowrap; font-weight: 500; width: 13mm; }
.vbk { display: inline-block; background: ${GUIDE.full}; color: #fff; font-size: 6.6pt; font-weight: 650; padding: 0 1.2mm; vertical-align: 0.2mm; }
.more { margin: 1mm 0 0; font-size: 7.6pt; }

/* swatches */
.sw { display: inline-block; width: 2.8mm; height: 2.8mm; margin-right: 1.2mm; vertical-align: -0.4mm; flex: none; }
.sw.s { background: ${GUIDE.increment}; } .sw.f { background: ${GUIDE.full}; } .sw.w { background: ${GUIDE.warning}; } .sw.x { background: ${GUIDE.failed}; }
.sw.m { background: repeating-linear-gradient(135deg, ${GUIDE.failed} 0 0.6mm, #fff 0.6mm 0.9mm); }
.sw.p { box-shadow: inset 0 0 0 0.35mm ${GUIDE.teal}; } .sw.pf { box-shadow: inset 0 0 0 0.45mm ${GUIDE.full}; }
.sw.copy { background: ${GUIDE.dark}; } .sw.tail-late { background: #f6c9c7; } .sw.tail { background: ${GUIDE.tealPale}; }
.sw.wait { background: repeating-linear-gradient(90deg, #9a9a9a 0 0.4mm, #fff 0.4mm 0.8mm); }
.sw.ln-f { height: 0; border-top: 0.7mm solid ${GUIDE.full}; width: 4mm; vertical-align: 0.6mm; }
.sw.free { background: ${GUIDE.linkPale}; box-shadow: inset 0 0 0 0.25mm ${GUIDE.link}; }
.sw.s.late { box-shadow: 0 0 0 0.35mm ${GUIDE.failed}; }
.legend { display: flex; flex-wrap: wrap; gap: 0.8mm 4.5mm; font-size: 7.4pt; color: ${GUIDE.muted}; margin-top: 2mm; }
.legend span { white-space: nowrap; display: inline-flex; align-items: center; }
.legend .lt { margin-right: 1.2mm; }

/* the wall calendar */
.cal { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); height: 158mm; border-top: 0.25mm solid ${GUIDE.rule}; border-left: 0.25mm solid ${GUIDE.rule}; }
.cal .wd { background: ${GUIDE.head}; color: #fff; font-weight: 500; font-size: 8pt; padding: 1.2mm 2mm; border-right: 0.25mm solid ${GUIDE.head}; }
.cal .wd.we { background: #7a7a7a; }
.cd { border-right: 0.25mm solid ${GUIDE.rule}; border-bottom: 0.25mm solid ${GUIDE.rule}; padding: 1.1mm 1.6mm; overflow: hidden; min-width: 0; font-size: 6.9pt; line-height: 1.32; position: relative; }
.cd.we { background: #f7f9f8; }
.cd.out { background: repeating-linear-gradient(135deg, #f4f4f4 0 1mm, #fff 1mm 2mm); }
.cd.bad { box-shadow: inset 0.8mm 0 0 ${GUIDE.failed}; }
.cd.today { box-shadow: inset 0 0 0 0.6mm ${GUIDE.green}; }
.cd.plan .dn b { color: ${GUIDE.muted}; }
.dn { display: flex; align-items: center; gap: 1.4mm; margin-bottom: 0.4mm; }
.dn b { font-size: 10pt; font-weight: 400; color: ${GUIDE.ink}; }
.dn .tag { background: ${GUIDE.green}; color: #fff; font-size: 6.2pt; font-weight: 600; padding: 0 1.2mm; }
.chips { display: flex; gap: 1.8mm; font-weight: 650; margin-bottom: 0.5mm; }
.chips .pl { color: ${GUIDE.teal}; } .chips .fl { color: ${GUIDE.full}; }
.ln { display: flex; align-items: center; gap: 0.8mm; white-space: nowrap; }
.ln .sw { width: 2.1mm; height: 2.1mm; margin-right: 0.3mm; }
.ln .tm { color: ${GUIDE.muted}; flex: none; }
.ln .nm { overflow: hidden; text-overflow: ellipsis; min-width: 0; }

.rest { color: ${GUIDE.muted}; white-space: nowrap; }
.lt { display: inline-block; background: ${GUIDE.failed}; color: #fff; font-size: 5.6pt; font-weight: 700; padding: 0 0.7mm; line-height: 1.35; flex: none; }
b .sw, .chips .sw { width: 2.2mm; height: 2.2mm; margin-right: 0.6mm; vertical-align: -0.2mm; }

/* jobs × days */
.mt { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 7.4pt; }
.mt th { background: ${GUIDE.head}; color: #fff; font-weight: 500; padding: 1mm 0.4mm; border: 0.25mm solid ${GUIDE.head}; }
.mt th.nmh { width: 52mm; text-align: left; padding-left: 2mm; } .mt th.st { width: 12mm; } .mt th.pc { width: 14mm; }
.mt th.dh { font-size: 7pt; line-height: 1.1; } .mt th.dh small { display: block; font-size: 5.6pt; font-weight: 400; opacity: 0.85; }
.mt th.dh.we { background: #7a7a7a; } .mt th.dh.today { background: ${GUIDE.green}; }
.mt td { border: 0.25mm solid #e2e2e2; height: var(--row, 4.5mm); padding: 0; text-align: center; }
.mt td.we { background: #f7f9f8; } .mt td.today { background: #e6faef; }
.mt td.nm { text-align: left; padding: 0 2mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
.mt td.st { color: ${GUIDE.muted}; font-size: 7pt; } .mt td.pc { font-weight: 600; } .mt td.pc.bad { color: ${GUIDE.failed}; }
.mt tr.off td { color: #a8a8a8; } .mt tr.off td.nm { font-weight: 400; }
.mt .copy { font-size: 5.8pt; color: ${GUIDE.dark}; border: 0.2mm solid ${GUIDE.tealSoft}; padding: 0 0.6mm; font-weight: 600; }
.mx { display: block; margin: auto; width: 74%; height: calc(var(--row, 4.5mm) * 0.66); }
.mx.s { background: ${GUIDE.increment}; } .mx.f { background: ${GUIDE.full}; } .mx.w { background: ${GUIDE.warning}; } .mx.x { background: ${GUIDE.failed}; } .mx.r { background: ${GUIDE.link}; }
.mx.m { background: repeating-linear-gradient(135deg, ${GUIDE.failed} 0 0.6mm, #fff 0.6mm 0.9mm); }
.mx.p { box-shadow: inset 0 0 0 0.3mm ${GUIDE.teal}; } .mx.pf { box-shadow: inset 0 0 0 0.45mm ${GUIDE.full}; }
.mx.late { box-shadow: 0 0 0 0.35mm ${GUIDE.failed}; }

/* the night */
.gantt, .load { width: 100%; height: auto; display: block; font-family: 'Inter Variable', sans-serif; }
.gantt text, .load text { font-size: 10.5px; fill: ${GUIDE.muted}; font-weight: 350; }
.gantt text.nm { fill: ${GUIDE.ink}; font-weight: 450; } .gantt text.tm { font-size: 9.5px; }
.gantt .g, .load .g { stroke: #e8e8e8; stroke-width: 1; }
.gantt .win, .load .win { fill: ${GUIDE.tealMist}; }
.gantt .edge { stroke: ${GUIDE.failed}; stroke-width: 1.2; stroke-dasharray: 4 3; }
.gantt .bar { fill: ${GUIDE.increment}; } .gantt .copy { fill: ${GUIDE.dark}; } .gantt .tail { fill: ${GUIDE.tealPale}; } .gantt .over { fill: ${GUIDE.failed}; opacity: 0.85; }
.gantt .full { fill: ${GUIDE.full}; } .gantt .tail-late { fill: #f6c9c7; }
.gantt .wait { fill: #bdbdbd; opacity: 0.8; }
.load .area { fill: ${GUIDE.increment}; opacity: 0.35; } .load .line { fill: none; stroke: #00a64b; stroke-width: 1.6; }
.load .heavy { fill: none; stroke: ${GUIDE.full}; stroke-width: 1.8; stroke-dasharray: 5 3; }
.load .free { fill: ${GUIDE.linkPale}; stroke: ${GUIDE.link}; stroke-width: 0.8; }
.load text.fr { fill: #0083b3; font-weight: 600; font-size: 10px; }
.manual { font-size: 7.8pt; margin: 2mm 0 0; }

/* machines, vCenters and proxies */
.cv-cols.infra { gap: 7mm; align-items: start; grid-template-columns: 1fr 1.4fr; }
.g-h2.vc { font-size: 12pt; margin-top: 5mm; }
.vct td:nth-child(4) { font-size: 7pt; }
.vct thead { display: table-header-group; }

/* the schedule table */
.sch th, .sch td { font-size: 7.4pt; padding: 0.9mm 1.6mm; line-height: 1.3; }
.sch td.nw { white-space: nowrap; }
.sch td.nm { font-weight: 600; } .sch td.t { white-space: nowrap; }
.sch tr.off td { color: #9a9a9a; }
.warnc { color: #c4600a; font-weight: 600; }
`;
