import { escapeHtml as esc } from '../telegram/format';
import { calendarLabel, sizeOf } from './job-report';
import { shortName } from './job-report-page';
import { CALENDAR_DAYS, Cell, MachineDays } from './points-calendar';
import { daysWords, momentLabel, namesWords, PointsReport, Tile } from './points-report';
import { envelope, ReportDocument, stampOf } from './report-envelope';
import { VEEAM_LOGO } from './veeam-logo';

/**
 * The Points report as one HTML document for the browser to print, in the
 * look of the Job report and the Repository report: veeam.com's dark navy
 * panel under Veeam's logo — the job, how it stands and what it is set to do
 * — and beside it white cards on a pale page: what is wrong in one band,
 * five numbers, the five weeks a machine to a row, and under them the
 * machines' errors, what to do and the chains on disk. A Full is navy and an
 * increment Veeam's green; coral says a run that failed and nothing else. A
 * job of more machines than the first page holds goes on over further pages,
 * the days' header repeated on each.
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
export const FIRST_ROWS = 13;
/** Machines a page after it holds. */
export const NEXT_ROWS = 26;

const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, place) => items.slice(place * size, (place + 1) * size));

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

/** The page's colours, as drawn. */
const DOT = { crit: '#FF5A5F', warn: '#FFB224', ok: '#00D15F', unknown: '#ADACAF' } as const;

/** A name drawn smaller the longer it is, so that it stays on its line. */
const nameSize = (name: string): string => (name.length <= 24 ? '' : name.length <= 32 ? ' style="font-size:20px"' : name.length <= 44 ? ' style="font-size:17px"' : ' style="font-size:15px"');
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
  <aside class="side">
    <div class="brand">${VEEAM_LOGO}<span>Backup &amp; Replication</span></div>
    <div>
      <div class="eyebrow">Точки восстановления</div>
      <h1 class="job"${nameSize(report.name)}>${esc(report.name).replace(/_/g, '_<wbr>')}</h1>
      <div class="st"><span class="dot" style="background:${DOT[status]}"></span><span>${esc(report.word)}</span></div>
    </div>
    <ul class="facts">${report.facts.map((fact) => `<li>${esc(fact)}</li>`).join('')}</ul>
    <div class="stamp"><span>${esc(report.server)} · за ${CALENDAR_DAYS} дней</span><span>${stamp}</span></div>
  </aside>
  <div class="main">
    <div class="band ${status}"><span class="dot" style="background:${DOT[status]}"></span><div class="verdict">${esc(said)}</div></div>
    <div class="tiles">${report.tiles.map(tile).join('')}</div>
    ${grid(report, shown, 0, false)}
    <div class="bottom">
      <div class="card bcard">${errors(report)}</div>
      <div class="card bcard">${steps(report)}</div>
      <div class="card bcard">${chains(report, timezone)}</div>
    </div>
    ${foot(report, 1, pages)}
  </div>
</section>`;
};

const nextPage = (report: PointsReport, shown: MachineDays[], from: number, page: number, pages: number): string => `<section class="page">
  <div class="main">
    <div class="chead">
      <div class="ch-l">${VEEAM_LOGO}<span class="eyebrow">Точки восстановления</span><b>${esc(report.name)}</b></div>
      <div class="meta">Машины ${from + 1}–${from + shown.length} из ${report.calendar.rows.length}</div>
    </div>
    ${grid(report, shown, from, true)}
    ${foot(report, page, pages)}
  </div>
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
/** What of a step's detail three lines hold with its mark after it: the mark is never the part clipped. */
const DETAIL = 150;

const errors = (report: PointsReport): string => {
  const shown = report.errors.slice(0, ERROR_ROWS);
  const more = report.errors.length - shown.length;
  const entries = shown
    .map((group) => {
      const said = group.failed ? group.reason ?? 'Запуск упал на машине; что сказал Veeam, не прочитано.' : 'Точек нет, а ошибки по машине Veeam не записал.';
      return `<p class="err"><span class="who"><b>${esc(namesWords(group.machines.map(shortName)))}</b> · ${daysWords(group.days)}</span><span class="errt">${esc(cut(said, 170))}</span></p>`;
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
    ...(oldest ? [`<span class="lg"><span class="sw" style="background:#6B7697"></span>${label(oldest)}${oldest.leaves !== undefined ? `, уйдёт ~${calendarLabel(oldest.leaves)}` : ', самая старая'}</span>`] : []),
    `<span class="lg"><span class="sw" style="background:#010D35"></span>${label(current)}, текущая</span>`,
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
body { margin: 0; background: #EEF4F6; }
.page { width: 297mm; height: 210mm; box-sizing: border-box; background: #EEF4F6; color: #232323; font-family: 'Inter Variable', system-ui, sans-serif; display: flex; overflow: hidden; font-size: 12px; line-height: 1.45; font-variant-numeric: tabular-nums; break-after: page; }
.page:last-child { break-after: auto; }
.page * { box-sizing: border-box; }
h1, h2, h3 { margin: 0; }

/* The navy panel the report opens on */
.side { width: 272px; flex: none; background: #010D35; color: #D6DBE6; padding: 40px 28px 28px; display: flex; flex-direction: column; gap: 24px; }
.brand { display: flex; align-items: center; gap: 11px; padding-bottom: 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.18); font-size: 9.5px; color: #ADB4C6; white-space: nowrap; }
.veeam-logo { height: 32px; width: auto; flex: none; }
.eyebrow { font-size: 9.5px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: #00D15F; }
.job { margin-top: 6px; font-size: 23px; line-height: 1.12; font-weight: 650; letter-spacing: -0.01em; color: #fff; overflow-wrap: anywhere; }
.st { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 13.5px; font-weight: 600; color: #fff; }
.dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; flex: none; }
.facts { list-style: none; margin: 0; padding: 0; font-size: 12px; line-height: 1.4; color: #fff; }
.facts li { padding: 7px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.12); overflow-wrap: anywhere; }
.facts li:last-child { border-bottom: none; }
.stamp { margin-top: auto; display: flex; justify-content: space-between; gap: 8px; font-size: 9.5px; color: #A3ACC2; padding-top: 9px; border-top: 1px solid rgba(255, 255, 255, 0.18); white-space: nowrap; }

/* The page beside it */
.main { flex: 1; min-width: 0; padding: 22px 24px 16px; display: flex; flex-direction: column; gap: 9px; }
.card { background: #fff; border: 1px solid #DFE6EA; border-radius: 9px; }
.band { flex: none; display: flex; align-items: center; gap: 11px; border-radius: 9px; padding: 11px 16px; background: #fff; color: #14171C; border: 1px solid #DFE6EA; }
.band .dot { width: 14px; height: 14px; }
.band.crit { background: #ff5a5f; border-color: #ff5a5f; color: #fff; } .band.warn { background: #ffb224; border-color: #ffb224; color: #fff; } .band.ok { background: #00d15f; border-color: #00d15f; color: #fff; }
.band.crit .dot, .band.ok .dot, .band.warn .dot { background: #fff !important; }
.verdict { font-size: 16px; line-height: 1.3; font-weight: 650; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.meta { color: #505861; font-size: 12px; }
.meta.small { font-size: 11px; }
.tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 9px; flex: none; }
.tile { padding: 9px 12px; min-width: 0; }
.tl-k { font-size: 9.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #505861; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tl-v { font-size: 19px; font-weight: 650; margin-top: 3px; line-height: 24px; letter-spacing: -0.01em; color: #010D35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tl-v.m { font-size: 16px; }
.tl-v.s { font-size: 13.5px; }
.tl-s { font-size: 11px; color: #505861; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bad { color: #E63946; }
h2 { font-size: 13.5px; font-weight: 650; color: #010D35; white-space: nowrap; }
.gcard { padding: 11px 14px 10px; display: flex; flex-direction: column; gap: 6px; flex: none; }
.sec-h { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.legend { display: flex; gap: 11px; font-size: 11px; color: #505861; flex-wrap: wrap; }
.sec-h .legend { flex-wrap: nowrap; white-space: nowrap; }
.lg { display: inline-flex; align-items: center; gap: 5px; }
.sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex: none; }
.grid { display: flex; flex-direction: column; gap: 3px; }
.row { display: grid; grid-template-columns: 132px repeat(${CALENDAR_DAYS}, minmax(0, 1fr)) 40px; gap: 2px; align-items: center; }
.mon { font-size: 11px; font-weight: 600; color: #505861; border-bottom: 1px solid #DFE6EA; padding-bottom: 3px; white-space: nowrap; overflow: hidden; }
.hd { font-size: 9.5px; color: #505861; text-align: center; line-height: 1.3; }
.hd.we { color: #8A8F98; }
.hd.fd { color: #010D35; font-weight: 650; }
.hd.miss { color: #E63946; }
.nm { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 4px; }
.cnt { font-size: 12px; font-weight: 650; text-align: right; }
.none { color: #505861; font-size: 12px; padding: 4px 0; }
.c { display: block; height: 14px; border-radius: 3px; }
.sw.c { display: inline-block; height: 10px; border-radius: 3px; }
.f { background: #010D35; }
.i { background: #00D15F; }
.x { background: #FF5A5F; }
.r { background: #E3E9ED; }
.e { background: #fff; border: 1px dashed #C7D0D6; }
.mf { outline: 2px solid #FF5A5F; outline-offset: -2px; }
.bottom { flex: 1; min-height: 0; display: grid; grid-template-columns: 0.85fr 1.15fr 1.2fr; gap: 9px; }
.bcard { padding: 11px 14px; display: flex; flex-direction: column; gap: 6px; min-height: 0; min-width: 0; overflow: hidden; font-size: 12px; line-height: 1.38; }
.bcard h3 { font-size: 13.5px; font-weight: 650; color: #010D35; flex: none; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; white-space: nowrap; padding-bottom: 6px; border-bottom: 1px solid #EEF4F6; }
.err { margin: 0; flex: none; }
.who { display: -webkit-box; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.err b { font-weight: 650; }
.errt { color: #D92D3A; display: -webkit-box; margin-top: 2px; overflow: hidden; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.more { font-size: 11px; font-weight: 400; color: #505861; }
.act { margin: 0; flex: none; }
.act b { display: block; font-weight: 650; color: #14171C; }
.act .ad { display: block; color: #3A4048; }
.act.calm { color: #505861; }
.imp { display: inline-block; margin-left: 4px; font-weight: 650; color: #E63946; }
.note { display: inline-block; margin-left: 4px; color: #505861; font-weight: 650; }
.track { position: relative; height: 12px; border-radius: 6px; background: #EEF4F6; overflow: hidden; margin-top: 2px; flex: none; }
.track .rm { position: absolute; left: 0; top: 0; bottom: 0; background: #DCE3E8; }
.track .ca { position: absolute; top: 0; bottom: 0; background: #6B7697; box-shadow: inset 1px 0 0 #fff; }
.track .cc { position: absolute; top: 0; bottom: 0; background: #C9CFDD; box-shadow: inset 1px 0 0 #fff; }
.track .cb { position: absolute; top: 0; bottom: 0; background: #010D35; box-shadow: inset 1px 0 0 #fff; }
.track .tk { position: absolute; top: -3px; bottom: -3px; width: 2px; background: #FF5A5F; }
.axis { display: flex; justify-content: space-between; font-size: 11px; color: #505861; flex: none; }
.bcard .legend { flex: none; }
.ct { width: 100%; border-collapse: collapse; font-size: 11px; flex: none; }
.ct th, .ct td { text-align: left; padding: 2px 2px; border-bottom: 1px solid #EEF4F6; font-weight: 400; white-space: nowrap; }
.ct th { color: #505861; font-weight: 600; }
.ct .n { text-align: right; }
.ct .dim { color: #505861; }

/* The pages after the first open on a navy bar */
.chead { flex: none; display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 10px 18px; border-radius: 9px; background: #010D35; color: #fff; }
.chead .meta { color: #ADB4C6; }
.chead .veeam-logo { height: 22px; }
.ch-l { display: flex; align-items: center; gap: 12px; min-width: 0; white-space: nowrap; overflow: hidden; }
.ch-l b { font-size: 16px; font-weight: 650; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; }
.foot { display: flex; justify-content: space-between; gap: 16px; font-size: 11px; color: #505861; padding: 0 2px; flex: none; margin-top: auto; white-space: nowrap; }
`;
