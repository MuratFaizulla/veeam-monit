import { escapeHtml as esc } from '../telegram/format';
import { calendarLabel, sizeOf } from './job-report';
import { shortName } from './job-report-page';
import { CALENDAR_DAYS, Cell, MachineDays } from './points-calendar';
import { daysWords, momentLabel, namesWords, PointsReport, Tile } from './points-report';
import { envelope, ReportDocument, stampOf } from './report-envelope';
import { GUIDE, guideBand, guideFoot, guideStyle } from './guide-look';

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
  return envelope({
    lang: 'ru',
    title: `${report.name} — точки восстановления — ${stamp}`,
    style: `${guideStyle(footOf(report, stamp))}${STYLE}`,
    body: firstPage(report, rows.slice(0, FIRST_ROWS), rows.slice(FIRST_ROWS), stamp, timezone),
  });
};

/** Machines the first page holds under its head and numbers; the rest go on in the pages after it. */
export const FIRST_ROWS = 22;
/** Machines a page after it holds, each such page under the days' header of its own. */
export const NEXT_ROWS = 50;

export const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, place) => items.slice(place * size, (place + 1) * size));

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

/** The page's colours, as drawn. */
const DOT = { crit: '#E8403A', warn: '#FE8A25', ok: '#00D15F', unknown: '#639C90' } as const;

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

const firstPage = (report: PointsReport, shown: MachineDays[], rest: MachineDays[], stamp: string, timezone: string): string => {
  const { status, verdict } = report;
  const said = `${verdict.problem.charAt(0).toUpperCase()}${verdict.problem.slice(1)}${verdict.facts.length ? ` — ${verdict.facts.join(' · ')}` : ''}.`;
  return `<section class="page">
  ${guideBand('точки восстановления')}
  <div class="g-kicker eyebrow">Точки восстановления</div>
  <h1 class="job">${esc(report.name).replace(/_/g, '_<wbr>')}</h1>
  <hr class="g-rule">
  <div class="g-meta"><span class="g-state st"><span class="dot" style="background:${DOT[status]}"></span>${esc(report.word)}</span><span>${esc(report.server)} · за ${CALENDAR_DAYS} дней</span><span>${stamp}</span></div>
  <div class="g-note ${status} band"><div class="verdict">${esc(said)}</div></div>
  <h2 class="g-h2">Коротко</h2>
  <div class="tiles">${report.tiles.map(tile).join('')}</div>
  ${grid(report, shown, 0, false)}
  ${guideFoot(footOf(report, stamp))}
</section>
<div class="flow">
  ${chunks(rest, NEXT_ROWS)
    .map((part, place) => `<div class="cont">${grid(report, part, shown.length + place * NEXT_ROWS, true)}</div>`)
    .join('')}
  <div class="sect">${steps(report)}</div>
  <div class="sect">${errors(report)}</div>
  <div class="sect">${chains(report, timezone)}</div>
  <h3 class="g-h2">Настройки задания</h3>
  <ul class="facts">${report.facts.map((fact) => `<li>${esc(fact)}</li>`).join('')}</ul>
  ${foot(report)}
</div>`;
};

/** The foot line of every page. */
const footOf = (report: PointsReport, stamp: string): string => `Veeam Backup & Replication | Точки восстановления ${report.name} | ${stamp}`;

const tile = ({ label, value, note, alarm }: Tile): string =>
  `<div class="tile"><div class="tl-k">${esc(label)}</div><div class="tl-v${valueSize(value)}">${esc(value)}</div>${note ? `<div class="tl-s${alarm ? ' bad' : ''}">${esc(note)}</div>` : ''}</div>`;

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
      ${continued ? `<div class="meta">Машины ${from + 1}–${from + shown.length} из ${report.calendar.rows.length}</div>` : ''}
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
    ...(oldest ? [`<span class="lg"><span class="sw" style="background:${GUIDE.fullOldest}"></span>${label(oldest)}${oldest.leaves !== undefined ? `, уйдёт ~${calendarLabel(oldest.leaves)}` : ', самая старая'}</span>`] : []),
    `<span class="lg"><span class="sw" style="background:${GUIDE.full}"></span>${label(current)}, текущая</span>`,
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

const foot = (report: PointsReport): string =>
  `<div class="foot"><span>${esc(report.foot)}</span><span>Запуски по сессиям — «Отчёт PDF» под карточкой задания</span></div>`;

/* ------------------------------------------------------------------ *
 * The look of Veeam's User Guide (./guide-look), and the grid's own
 * ------------------------------------------------------------------ */

const STYLE = `
.page { page: cover; position: relative; height: 297mm; padding: 0 16mm; overflow: hidden; break-after: page; box-sizing: border-box; }
.page *, .flow * { box-sizing: border-box; }
.job { margin: 0; color: ${GUIDE.green}; font-weight: 300; font-size: 26pt; line-height: 1.12; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.dot { width: 3.4mm; height: 3.4mm; border-radius: 50%; display: inline-block; flex: none; }
.verdict { font-weight: 600; }
.bad { color: #e8403a; }
.meta { color: ${GUIDE.muted}; }
.meta.small { font-size: 8pt; margin-top: 1.4mm; }

.tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); border: 0.25mm solid ${GUIDE.rule}; border-top: none; }
.tile { min-width: 0; border-left: 0.25mm solid ${GUIDE.rule}; } .tile:first-child { border-left: none; }
.tl-k { background: ${GUIDE.head}; color: #fff; font-weight: 500; font-size: 8pt; padding: 1.9mm 2.6mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tl-v { font-size: 14pt; font-weight: 300; line-height: 1.2; padding: 2mm 2.6mm 0; overflow-wrap: anywhere; }
.tl-v.m { font-size: 12.5pt; } .tl-v.s { font-size: 11pt; }
.tl-s { font-size: 7.6pt; color: ${GUIDE.muted}; padding: 0.4mm 2.6mm 2.2mm; }

h2 { margin: 0; }
.gcard { margin-top: 5mm; }
.gcard h2 { color: ${GUIDE.green}; font-weight: 300; font-size: 15pt; line-height: 1.2; }
.sec-h { margin-bottom: 1.6mm; break-after: avoid; }
.legend { display: flex; gap: 0.6mm 3.6mm; font-size: 7.6pt; color: ${GUIDE.muted}; flex-wrap: wrap; margin-top: 1mm; }
.lg { display: inline-flex; align-items: center; gap: 1.2mm; white-space: nowrap; }
.sw { width: 2.8mm; height: 2.8mm; display: inline-block; flex: none; }
.grid { display: flex; flex-direction: column; gap: 0.7mm; }
.row { display: grid; grid-template-columns: 42mm repeat(${CALENDAR_DAYS}, minmax(0, 1fr)) 9mm; gap: 0.45mm; align-items: center; break-inside: avoid; }
.mon { font-size: 7.4pt; font-weight: 600; color: ${GUIDE.ink}; border-bottom: 0.25mm solid ${GUIDE.rule}; padding-bottom: 0.6mm; white-space: nowrap; overflow: hidden; }
.hd { font-size: 6.4pt; color: ${GUIDE.muted}; text-align: center; line-height: 1.3; }
.hd.we { color: #9a9a9a; } .hd.fd { color: ${GUIDE.ink}; font-weight: 650; } .hd.miss { color: #e8403a; font-weight: 650; }
.nm { font-size: 7.8pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 1mm; }
.cnt { font-size: 8pt; font-weight: 650; text-align: right; }
.none { color: ${GUIDE.muted}; padding: 1mm 0; }
.c { display: block; height: 3.5mm; }
.sw.c { display: inline-block; height: 2.8mm; }
.f { background: ${GUIDE.full}; } .i { background: ${GUIDE.increment}; } .x { background: ${GUIDE.failed}; } .r { background: ${GUIDE.tealPale}; }
.e { background: #fff; border: 0.25mm dashed ${GUIDE.tealSoft}; }
.mf, .sw.c.mf { background: repeating-linear-gradient(135deg, ${GUIDE.failed} 0 0.6mm, #fff 0.6mm 0.9mm); outline: none; }

.cont { break-before: page; }
.cont .gcard { margin-top: 0; }
.sect h3 { margin: 5.5mm 0 2mm; color: ${GUIDE.green}; font-weight: 300; font-size: 15pt; line-height: 1.2; break-after: avoid; display: flex; align-items: baseline; gap: 3mm; }
.more { font-size: 8pt; color: ${GUIDE.muted}; }
.err { margin: 0 0 2mm; break-inside: avoid; }
.err b { font-weight: 650; }
.errt { display: block; color: #e8403a; margin-top: 0.4mm; overflow-wrap: anywhere; }
.act { margin: 0 0 2.4mm; break-inside: avoid; }
.act b { display: block; font-weight: 650; font-size: 9pt; }
.act .ad { display: block; color: #333; }
.act.calm { color: ${GUIDE.muted}; }
.imp { margin-left: 1.2mm; font-weight: 650; color: #e8403a; }
.note { margin-left: 1.2mm; color: ${GUIDE.muted}; font-weight: 600; }
.track { position: relative; height: 3.4mm; background: ${GUIDE.tealMist}; overflow: hidden; }
.track .rm { position: absolute; left: 0; top: 0; bottom: 0; background: ${GUIDE.tealPale}; }
.track .ca { position: absolute; top: 0; bottom: 0; background: ${GUIDE.fullOldest}; box-shadow: inset 0.3mm 0 0 #fff; }
.track .cc { position: absolute; top: 0; bottom: 0; background: ${GUIDE.fullOlder}; box-shadow: inset 0.3mm 0 0 #fff; }
.track .cb { position: absolute; top: 0; bottom: 0; background: ${GUIDE.full}; box-shadow: inset 0.3mm 0 0 #fff; }
.track .tk { position: absolute; top: 0; bottom: 0; width: 0.6mm; background: #e8403a; }
.axis { display: flex; justify-content: space-between; font-size: 7.6pt; color: ${GUIDE.muted}; margin-top: 0.6mm; }
.ct { width: 100%; border-collapse: collapse; margin-top: 2.4mm; }
.ct th { background: ${GUIDE.head}; color: #fff; font-weight: 500; font-size: 8pt; text-align: left; padding: 1.9mm 2.6mm; border: 0.25mm solid ${GUIDE.head}; }
.ct td { padding: 1.7mm 2.6mm; border: 0.25mm solid ${GUIDE.rule}; }
.ct .n { text-align: right; }
.ct .dim { color: ${GUIDE.muted}; }
.facts { list-style: none; margin: 0; padding: 0; border-top: 0.25mm solid ${GUIDE.rule}; }
.facts li { padding: 1.7mm 2.6mm; border: 0.25mm solid ${GUIDE.rule}; border-top: none; overflow-wrap: anywhere; break-inside: avoid; }
.foot { display: flex; justify-content: space-between; gap: 6mm; font-size: 7.8pt; color: ${GUIDE.muted}; margin-top: 5mm; }
`;
