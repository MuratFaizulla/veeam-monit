import { escapeHtml as esc } from '../telegram/format';
import { calendarLabel, sizeOf } from './job-report';
import { shortName } from './job-report-page';
import { CALENDAR_DAYS, Cell, MachineDays } from './points-calendar';
import { daysWords, momentLabel, namesWords, PointsReport, Tile } from './points-report';
import { envelope, ReportDocument, stampOf } from './report-envelope';

/**
 * The Points report as one HTML document for the browser to print, in the
 * look the user drew for it: a light page of white cards — the job and how it
 * stands, five numbers, the five weeks a machine to a row, and under them the
 * machines' errors, what to do and the chains on disk. A job of more machines
 * than the first page holds goes on over further pages, the days' header
 * repeated on each.
 *
 * Everything is laid out to fit, whatever the job says: a name, a number or a
 * line that would wrap is made smaller or cut short, the cards under the grid
 * hold a set number of entries and clip the rest, and the rows a page holds
 * are counted here rather than left to the browser, which grows a page to its
 * content when it prints. No emoji: the server's browser may have no font
 * for them.
 */
export const pointsReportPage = (report: PointsReport, timezone: string): ReportDocument => {
  const stamp = stampOf(report.at, timezone);
  const rows = report.calendar.rows;
  const first = rows.slice(0, FIRST_ROWS);
  const rest = chunks(rows.slice(FIRST_ROWS), NEXT_ROWS);
  const pages = 1 + rest.length;
  return envelope({
    lang: 'ru',
    title: `${report.name} — точки восстановления — ${stamp}`,
    style: STYLE,
    body: [
      firstPage(report, first, stamp, timezone, pages),
      ...rest.map((shown, place) => nextPage(report, shown, FIRST_ROWS + place * NEXT_ROWS, place + 2, pages)),
    ].join(''),
  });
};

/** Machines the first page holds under its head and numbers, with the cards under them. */
export const FIRST_ROWS = 8;
/** Machines a page after it holds. */
export const NEXT_ROWS = 26;

const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, place) => items.slice(place * size, (place + 1) * size));

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

/** The page's colours, as drawn. */
const DOT = { crit: '#E5484D', warn: '#E0A100', ok: '#1F9D55', unknown: '#A7AEB9' } as const;
const WORD = { crit: '#D13438', warn: '#8A5A00', ok: '#1B7F45', unknown: '#5E6878' } as const;

/** A name drawn smaller the longer it is, so that it stays on its line. */
const nameSize = (name: string): string => (name.length <= 24 ? '' : name.length <= 32 ? ' style="font-size:26px"' : name.length <= 44 ? ' style="font-size:21px"' : ' style="font-size:18px"');
/** A number drawn smaller the longer it is: «сб 24.10, 22:00» wrapped at the size of «2,4 ТБ». */
const valueSize = (value: string): string => (value.length <= 11 ? '' : value.length <= 15 ? ' m' : ' s');
/**
 * At most this much of a text: its whole sentences that fit, or else its
 * words and an ellipsis. The cards under the grid clip what is left over.
 */
const cut = (text: string, most: number): string => {
  if (text.length <= most) return text;
  let stop = -1;
  for (let at = 0; at < most; at += 1) if (/[.!?]/.test(text[at]) && text[at + 1] === ' ') stop = at;
  if (stop > most / 2) return text.slice(0, stop + 1);
  const space = text.lastIndexOf(' ', most - 1);
  return `${text.slice(0, space > 0 ? space : most - 1).replace(/[\s,:;—-]+$/, '')}…`;
};

const firstPage = (report: PointsReport, shown: MachineDays[], stamp: string, timezone: string, pages: number): string => {
  const { status, verdict } = report;
  const said = `${verdict.problem.charAt(0).toUpperCase()}${verdict.problem.slice(1)}${verdict.facts.length ? ` — ${verdict.facts.join(' · ')}` : ''}.`;
  return `<section class="page">
  <div class="top">
    <div class="card head">
      <div class="eyebrow">Точки восстановления · Veeam B&amp;R</div>
      <h1 class="job"${nameSize(report.name)}>${esc(report.name)}</h1>
      <div class="meta one">${report.facts.map(esc).join(' · ')}</div>
    </div>
    <div class="card status">
      <div class="st"><span class="dot" style="background:${DOT[status]}"></span><span style="color:${WORD[status]}">${esc(report.word)}</span></div>
      <div class="verdict">${esc(said)}</div>
      <div class="meta one">Сервер ${esc(report.server)} · ${stamp} · за ${CALENDAR_DAYS} дней</div>
    </div>
  </div>
  <div class="tiles">${report.tiles.map(tile).join('')}</div>
  ${grid(report, shown, 0, false)}
  <div class="bottom">
    <div class="card bcard">${errors(report)}</div>
    <div class="card bcard">${steps(report)}</div>
    <div class="card bcard">${chains(report, timezone)}</div>
  </div>
  ${foot(report, 1, pages)}
</section>`;
};

const nextPage = (report: PointsReport, shown: MachineDays[], from: number, page: number, pages: number): string => `<section class="page">
  <div class="card chead">
    <div class="ch-l"><span class="eyebrow">Точки восстановления · Veeam B&amp;R</span><b>${esc(report.name)}</b></div>
    <div class="meta">Машины ${from + 1}–${from + shown.length} из ${report.calendar.rows.length}</div>
  </div>
  ${grid(report, shown, from, true)}
  ${foot(report, page, pages)}
</section>`;

const tile = ({ label, value, note, alarm }: Tile): string =>
  `<div class="card tile"><div class="tl-k">${esc(label)}</div><div class="tl-v${valueSize(value)}">${esc(value)}</div>${note ? `<div class="tl-s${alarm ? ' bad' : ''}">${esc(note)}</div>` : ''}</div>`;

const CELL: Record<Cell, string> = { full: 'f', increment: 'i', failed: 'x', retired: 'r', none: 'e' };

/** The five weeks, a machine a row: the days' header, then `shown`. */
const grid = (report: PointsReport, shown: MachineDays[], from: number, continued: boolean): string => {
  const { days, typed } = report.calendar;
  const most = report.depth?.points ?? 0;
  const months: Array<{ name: string; from: number; span: number }> = [];
  days.forEach(({ day }, place) => {
    const name = MONTHS[new Date(day).getUTCMonth()];
    if (months.at(-1)?.name === name) months[months.length - 1].span += 1;
    else months.push({ name, from: place, span: 1 });
  });
  const missed = days.some((day) => day.missed);
  const legend = [
    ...(typed ? [['f', 'Full'], ['i', 'Инкремент']] : [['i', 'Точка']]),
    ...(missed ? [['i mf', 'Full не выполнен']] : []),
    ['x', 'Запуск упал'],
    ['r', 'Удалено по хранению'],
    ['e', 'Нет данных'],
  ];
  const header = days
    .map(({ day, weekend, fullDay, missed: miss }) => `<span class="hd${weekend ? ' we' : ''}${fullDay ? ' fd' : ''}${miss ? ' miss' : ''}">${String(new Date(day).getUTCDate()).padStart(2, '0')}</span>`)
    .join('');
  const body = shown
    .map((row) => {
      const cells = row.cells.map((cell, place) => `<i class="c ${CELL[cell]}${days[place].missed ? ' mf' : ''}"></i>`).join('');
      return `<div class="row"><span class="nm">${esc(shortName(row.name))}</span>${cells}<span class="cnt${row.points < most ? ' bad' : ''}">${row.points}</span></div>`;
    })
    .join('');
  return `<section class="card gcard">
    <div class="sec-h">
      <h2>Точки по дням, ${calendarLabel(days[0].day)}–${calendarLabel(days[days.length - 1].day)}${continued ? ' · продолжение' : ''}</h2>
      <div class="legend">${legend.map(([kind, label]) => `<span class="lg"><span class="sw c ${kind}"></span>${label}</span>`).join('')}</div>
    </div>
    <div class="grid">
      <div class="row"><span></span>${months.map((month) => `<span class="mon" style="grid-column:${month.from + 2} / span ${month.span}">${month.name}</span>`).join('')}<span></span></div>
      <div class="row"><span class="hd" style="text-align:left">Машина</span>${header}<span class="hd">Точек</span></div>
      ${body || `<div class="none">${from ? '' : 'Ни одна машина задания не названа: ни в точках, ни в настройках.'}</div>`}
    </div>
  </section>`;
};

/** Entries the errors card holds. */
const ERROR_ROWS = 2;
/** Steps the card holds. */
const STEP_ROWS = 3;
/** Chains the table holds. */
const CHAIN_ROWS = 3;
/** What of a step's detail two lines hold with its mark after it: the mark is never the part clipped. */
const DETAIL = 86;

const errors = (report: PointsReport): string => {
  const shown = report.errors.slice(0, ERROR_ROWS);
  const more = report.errors.length - shown.length;
  const entries = shown
    .map((group) => {
      const said = group.failed ? group.reason ?? 'Запуск упал на машине; что сказал Veeam, не прочитано.' : 'Точек нет, а ошибки по машине Veeam не записал.';
      return `<p class="err"><span class="who"><b>${esc(namesWords(group.machines.map(shortName)))}</b> · ${daysWords(group.days)}</span><span class="errt">${esc(cut(said, 120))}</span></p>`;
    })
    .join('');
  return `<h3>Ошибки машин${more > 0 ? `<span class="more">и ещё ${more} — в сетке</span>` : ''}</h3>${entries || `<p class="err">Ошибок за ${CALENDAR_DAYS} дней нет.</p>`}`;
};

const steps = (report: PointsReport): string => {
  const important = report.steps.filter((step) => step.important);
  const shown = report.steps.slice(0, STEP_ROWS);
  const listed = (from: number) =>
    shown
      .slice(from)
      .map(
        (step, place) =>
          `<p class="act"><b>${from + place + 1}. ${esc(step.title)}</b><span class="ad">${esc(cut(step.detail ?? '', DETAIL))}<span class="${step.important ? 'imp' : 'note'}">${step.important ? 'Важно' : 'К сведению'}</span></span></p>`,
      )
      .join('');
  if (important.length) return `<h3>Что сделать</h3>${listed(0)}`;
  // Nothing that needs anybody: said first, and what is worth knowing after it.
  const calm = report.excused
    ? report.excused === 'disabled' ? 'Задание выключено в Veeam: новых точек от него не ждут.' : 'Задание запускают только вручную: по расписанию точек от него не ждут.'
    : report.next ? `Следующий Full — ${report.next.weekday} ${calendarLabel(report.next.day)}${report.next.time ? ` в ${report.next.time}` : ''}, по расписанию.` : '';
  return `<h3>Что сделать</h3><p class="act"><b>Ничего делать не нужно.</b></p>${calm ? `<p class="act calm">${esc(calm)}</p>` : ''}${shown
    .slice(0, STEP_ROWS - 1)
    .map((step) => `<p class="act"><b>${esc(step.title)}</b><span class="ad">${esc(cut(step.detail ?? '', DETAIL))}<span class="note">К сведению</span></span></p>`)
    .join('')}`;
};

const chains = (report: PointsReport, timezone: string): string => {
  const found = report.chains;
  if (!found) {
    return `<h3>Цепочки на диске</h3><p class="err">Veeam не сказал, какие точки — Full, поэтому цепочки не видны.</p>`;
  }
  const at = (place: number) => `${((100 * Math.max(0, Math.min(CALENDAR_DAYS, place))) / CALENDAR_DAYS).toFixed(3)}%`;
  const width = (from: number, to: number) => `${((100 * (Math.max(0, Math.min(CALENDAR_DAYS, to)) - Math.max(0, from))) / CALENDAR_DAYS).toFixed(3)}%`;
  const spans = found.spans.filter((span) => span.to > 0);
  const track = [
    found.retired > 0 ? `<span class="rm" style="width:${at(found.retired)}"></span>` : '',
    // The oldest as its legend has it, the next ones lighter, the one written now dark.
    ...spans.map((span) => `<span class="${span.current ? 'cb' : span === found.spans[0] ? 'ca' : 'cc'}" style="left:${at(span.from)};width:${width(span.from, span.to)}"></span>`),
    ...found.missed.map((place) => `<span class="tk" style="left:${at(place)}"></span>`),
  ].join('');
  const label = (span: (typeof spans)[number]) => (span.full === undefined ? 'Без Full' : `Full ${calendarLabel(span.full)}`);
  const current = found.spans[found.spans.length - 1];
  const oldest = found.spans.length > 1 ? found.spans[0] : undefined;
  const legend = [
    ...(oldest ? [`<span class="lg"><span class="sw" style="background:#8FAEEB"></span>${label(oldest)}${oldest.leaves !== undefined ? `, уйдёт ~${calendarLabel(oldest.leaves)}` : ', самая старая'}</span>`] : []),
    `<span class="lg"><span class="sw" style="background:#2453C7"></span>${label(current)}, текущая</span>`,
  ].join('');
  const newest = [...found.spans].reverse();
  const shown = newest.slice(0, CHAIN_ROWS);
  const size = (bytes: number | undefined) => (bytes === undefined ? '—' : sizeOf(bytes));
  const rows = shown
    .map((span) => `<tr><td>${label(span)}${span.current ? ' (текущая)' : ''}</td><td class="n">${span.increments}</td><td class="n">${size(span.data)}</td><td class="n">${size(span.disk)}</td></tr>`)
    .join('');
  const more = newest.length - shown.length;
  const note = found.writing !== undefined
    ? `Новый Full с ${momentLabel(found.writing, timezone).slice(0, 5)} ещё пишется.`
    : found.increment ? `Обычный инкремент: ${sizeOf(found.increment.data)} → ${sizeOf(found.increment.disk)} на диске.` : '';
  return `<h3>Цепочки на диске</h3>
      <div class="track">${track}</div>
      <div class="axis"><span>${calendarLabel(report.calendar.days[0].day)}</span><span>${calendarLabel(report.calendar.days[report.calendar.days.length - 1].day)}</span></div>
      <div class="legend">${legend}</div>
      <table class="ct"><tr><th>Цепочка</th><th class="n">Инкр.</th><th class="n">Данные</th><th class="n">На диске</th></tr>${rows}${more > 0 ? `<tr><td colspan="4" class="dim">и ещё ${more} — старше</td></tr>` : ''}</table>
      ${note ? `<div class="meta small">${esc(note)}</div>` : ''}`;
};

const foot = (report: PointsReport, page: number, pages: number): string =>
  `<div class="foot"><span>${esc(report.foot)}${pages > 1 ? ` · стр. ${page} из ${pages}` : ''}</span><span>Запуски по сессиям — «Отчёт PDF» под карточкой задания</span></div>`;

/* ------------------------------------------------------------------ *
 * The sheet, as drawn: 1123 × 794 px, A4 landscape
 * ------------------------------------------------------------------ */

const STYLE = `
@page { size: 297mm 210mm; margin: 0; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: #F5F7FA; }
.page { width: 297mm; height: 210mm; box-sizing: border-box; padding: 20px 28px 18px; background: #F5F7FA; color: #15191F; font-family: 'Inter Variable', system-ui, sans-serif; display: flex; flex-direction: column; gap: 8px; overflow: hidden; font-size: 13px; line-height: 1.45; font-variant-numeric: tabular-nums; break-after: page; }
.page:last-child { break-after: auto; }
.page * { box-sizing: border-box; }
.card { background: #fff; border: 1px solid #E3E8EF; border-radius: 14px; }
.top { display: flex; justify-content: space-between; align-items: stretch; gap: 16px; flex: none; }
.head { padding: 12px 20px; flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 5px; }
.eyebrow { font-size: 12px; font-weight: 600; color: #5E6878; }
.job { margin: 0; font-size: 32px; line-height: 1.05; font-weight: 800; letter-spacing: -0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta { color: #5E6878; font-size: 13px; }
.meta.one { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta.small { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status { width: 360px; flex: none; padding: 12px 18px; display: flex; flex-direction: column; gap: 5px; }
.st { display: flex; align-items: center; gap: 9px; font-size: 18px; font-weight: 700; }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
.verdict { font-size: 12.5px; line-height: 1.4; color: #2A303B; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; flex: none; }
.tile { padding: 10px 15px; min-width: 0; }
.tl-k { font-size: 12px; font-weight: 600; color: #5E6878; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tl-v { font-size: 23px; font-weight: 700; margin-top: 4px; line-height: 1.15; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tl-v.m { font-size: 20px; line-height: 26px; }
.tl-v.s { font-size: 17px; line-height: 26px; }
.tl-s { font-size: 12px; color: #5E6878; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bad { color: #D13438; }
h1, h2, h3 { margin: 0; }
h2 { font-size: 14px; font-weight: 700; white-space: nowrap; }
.gcard { padding: 12px 16px 10px; display: flex; flex-direction: column; gap: 6px; flex: none; }
.sec-h { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
.legend { display: flex; gap: 14px; font-size: 12px; color: #3E4654; flex-wrap: wrap; }
.sec-h .legend { flex-wrap: nowrap; white-space: nowrap; }
.lg { display: inline-flex; align-items: center; gap: 6px; }
.sw { width: 11px; height: 11px; border-radius: 3px; display: inline-block; flex: none; }
.grid { display: flex; flex-direction: column; gap: 3px; }
.row { display: grid; grid-template-columns: 150px repeat(${CALENDAR_DAYS}, minmax(0, 1fr)) 52px; gap: 3px; align-items: center; }
.mon { font-size: 12px; font-weight: 600; color: #5E6878; border-bottom: 1px solid #E3E8EF; padding-bottom: 3px; white-space: nowrap; overflow: hidden; }
.hd { font-size: 11px; color: #5E6878; text-align: center; line-height: 1.3; }
.hd.we { color: #8A94A3; }
.hd.fd { color: #2453C7; font-weight: 700; }
.hd.miss { color: #D13438; }
.nm { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 4px; }
.cnt { font-size: 13px; font-weight: 700; text-align: right; }
.none { color: #5E6878; font-size: 13px; padding: 4px 0; }
.c { display: block; height: 14px; border-radius: 4px; }
.sw.c { display: inline-block; height: 11px; border-radius: 3px; }
.f { background: #2453C7; }
.i { background: #B5CBF5; }
.x { background: #E5484D; }
.r { background: #E6EAF0; }
.e { background: #fff; border: 1px dashed #C9D0DB; }
.mf { outline: 2px solid #E5484D; outline-offset: -2px; }
.bottom { flex: 1; min-height: 0; display: grid; grid-template-columns: 0.95fr 1.1fr 1.05fr; gap: 12px; }
.bcard { padding: 12px 16px; display: flex; flex-direction: column; gap: 6px; min-height: 0; min-width: 0; overflow: hidden; font-size: 12.5px; line-height: 1.38; }
.bcard h3 { font-size: 14px; font-weight: 700; flex: none; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; white-space: nowrap; }
.err { margin: 0; flex: none; }
.who { display: -webkit-box; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.err b { font-weight: 700; }
.errt { color: #D13438; display: -webkit-box; margin-top: 2px; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.more { font-size: 12px; font-weight: 400; color: #5E6878; }
.act { margin: 0; flex: none; }
.act b { display: block; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.act .ad { display: -webkit-box; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.act.calm { color: #3E4654; }
.imp { display: inline-block; margin-left: 4px; font-weight: 700; color: #D13438; }
.note { display: inline-block; margin-left: 4px; color: #5E6878; font-weight: 700; }
.track { position: relative; height: 12px; border-radius: 6px; background: #EEF1F6; overflow: hidden; margin-top: 4px; flex: none; }
.track .rm { position: absolute; left: 0; top: 0; bottom: 0; background: #D9DEE7; }
.track .ca { position: absolute; top: 0; bottom: 0; background: #8FAEEB; box-shadow: inset 1px 0 0 #fff; }
.track .cc { position: absolute; top: 0; bottom: 0; background: #B5CBF5; box-shadow: inset 1px 0 0 #fff; }
.track .cb { position: absolute; top: 0; bottom: 0; background: #2453C7; box-shadow: inset 1px 0 0 #fff; }
.track .tk { position: absolute; top: -3px; bottom: -3px; width: 2px; background: #E5484D; }
.axis { display: flex; justify-content: space-between; font-size: 11px; color: #5E6878; flex: none; }
.bcard .legend { flex: none; }
.ct { width: 100%; border-collapse: collapse; font-size: 12px; flex: none; }
.ct th, .ct td { text-align: left; padding: 2px 2px; border-bottom: 1px solid #EEF1F6; font-weight: 400; white-space: nowrap; }
.ct th { color: #5E6878; font-weight: 600; }
.ct .n { text-align: right; }
.ct .dim { color: #5E6878; }
.chead { flex: none; display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 12px 22px; }
.ch-l { display: flex; align-items: baseline; gap: 14px; min-width: 0; white-space: nowrap; overflow: hidden; }
.ch-l b { font-size: 18px; font-weight: 800; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; }
.foot { display: flex; justify-content: space-between; gap: 16px; font-size: 12px; color: #5E6878; padding: 0 4px; flex: none; margin-top: auto; white-space: nowrap; }
`;
