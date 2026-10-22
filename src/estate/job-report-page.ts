import { escapeHtml as esc } from '../telegram/format';
import { plural } from '../telegram/time';
import { jobTypeWord } from '../telegram/words';
import { calendarLabel, dayLabel, JobReport, JobRun, ReportMachine, sizeOf, spanOf } from './job-report';
import { envelope, ReportDocument, stampOf, STATUS_WORD } from './report-envelope';
import { STAGE_NAMES } from './repository-report';
import { SessionReport } from './session-report';
import { SESSION_STYLE, sessionsHtml } from './session-report-page';

/**
 * The Job report as one HTML document for the browser to print: first a page
 * that says at a glance how the job stands — the verdict, its numbers, the
 * month of runs, what to do, its machines and who else writes where it
 * does — then every session, newest first. Both in the look of Veeam's own
 * report: a header coloured by the result, grey section bars, ruled tables,
 * Veeam's colours. The first page is in Russian, the sessions in Veeam's
 * English.
 */
export const jobReportPage = (report: JobReport, sessions: SessionReport, timezone: string): ReportDocument => {
  const stamp = stampOf(report.at, timezone);
  return envelope({
    lang: 'ru',
    title: `${report.name} — ${stamp}`,
    style: `${STYLE}${SESSION_STYLE}`,
    body: `${summary(report, timezone, stamp)}${sessionsHtml(sessions, timezone)}`,
  });
};

/** What fits the first page by construction: the browser grows a row to its content when it prints. */
const MACHINE_ROWS = 6;
const STEP_ROWS = 3;
const NEIGHBOUR_ROWS = 4;
const ERROR_ROWS = 3;
const CHAIN_ROWS = 5;

/** Veeam's colours, as its own report has them. */
const COLOUR = { success: '#00b050', warning: '#e8b32c', failed: '#e8645f', none: '#8fa9c4', empty: '#e3e3e3' } as const;
const BAND = { crit: '#fb9895', warn: '#ffd96c', ok: '#00b050', unknown: '#a7a9ac' } as const;
/** White on Veeam's yellow does not read; its other colours keep Veeam's white. */
const INK = { crit: '#fff', warn: '#3d3d3d', ok: '#fff', unknown: '#fff' } as const;

const machinesWord = (count: number) => plural(count, 'машина', 'машины', 'машин');
const runsWord = (count: number) => plural(count, 'запуск', 'запуска', 'запусков');
const timeOf = (at: number, timezone: string): string =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: timezone || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
/** "db-01 (4f2edb3f-…)" is how vCloud names a machine; the id says nothing on this page. */
export const shortName = (name: string) => name.replace(/\s\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)$/i, '');
/** A replica keeps its points on the target host, where the restore points the bot reads are not. */
const isReplica = (report: JobReport) => /replica/i.test(report.type ?? '');

// --- The first page
const summary = (report: JobReport, timezone: string, stamp: string): string => {
  const replica = isReplica(report);
  const total = report.machines.length;
  const facts = [
    jobTypeWord(report.type),
    total ? `${total} ${machinesWord(total)}` : '',
    report.repository && `репозиторий ${report.repository.short}`,
    report.schedule,
    report.retry && `повторы ${report.retry}`,
    report.retention,
    report.fulls,
  ].filter(Boolean);
  return `<section class="js">
  <table class="js-hd" style="--band:${BAND[report.status]};--ink:${INK[report.status]}"><tr><td>Задание: ${esc(report.name)}<div class="js-d">${facts.map((fact) => esc(String(fact))).join(' · ')}</div></td><td class="js-s">${STATUS_WORD[report.status]}<div class="js-d">${esc(report.server)} · ${stamp} · за ${report.days} дней</div></td></tr></table>
  <table class="js-t"><tr><td class="js-verdict">${esc(report.verdict)}.</td></tr></table>
  ${report.partial ? `<div class="js-partial">Прочитано не всё: ${esc(report.partial.slice(0, 220))}</div>` : ''}
  ${report.pointsUnavailable ? `<div class="js-partial">${esc(report.pointsUnavailable)}</div>` : ''}
  <div><div class="js-band">Сводка</div>${numbers(report, timezone, replica)}</div>
  <div class="js-two">
    <div class="js-col">
      <div class="js-band">Запуски за ${report.days} дней</div>
      <div class="js-box">${chart(report, timezone)}<div class="js-legend"><span><i style="background:${COLOUR.success}"></i>успешно</span><span><i style="background:${COLOUR.warning}"></i>с предупреждением</span><span><i style="background:${COLOUR.failed}"></i>ошибка</span><span><i class="run"></i>идёт</span><span><b>×</b>не было запуска по расписанию</span></div></div>
      <div class="js-band">Машины</div>${machinesTable(report, timezone)}
    </div>
    <div class="js-col">
      <div class="js-band">Что сделать</div>${stepsTable(report)}
      ${report.neighbours.jobs && report.neighbours.window ? neighboursTable(report, timezone) : report.errors.length ? errorsTable(report, timezone) : chainTable(report)}
    </div>
  </div>
  <div class="js-next">Дальше — каждая сессия за ${report.days} дней, новые сверху: цифры сессии и каждая машина с тем, что Veeam о ней написал.</div>
</section>`;
};

/** Three rows of three: what a reader asks first. A replica is told by its runs. */
const numbers = (report: JobReport, timezone: string, replica: boolean): string => {
  const { runs, machines } = report;
  const good = runs.filter((run) => run.result === 'success' || run.result === 'warning').length;
  const failed = runs.filter((run) => run.result === 'failed').length;
  const going = runs.filter((run) => run.result === 'none' && run.end === undefined).length;
  // A machine is told by its runs, a replica's and a backup's alike: one none of the runs read took on is not one without a good run.
  const judged = machines.filter((machine) => !machine.unread);
  const total = judged.length;
  const saved = judged.filter((machine) => machine.lastSaved !== undefined).length;
  const newest = replica ? Math.max(...machines.map((machine) => machine.lastSaved ?? -Infinity)) : report.newestPoint ?? -Infinity;
  // Until the scan has read them, nothing is said of the points: not even that there are none.
  const unknown = !replica && report.pointsUnavailable !== undefined;
  const sent = machines.reduce((sum, machine) => sum + (machine.transferred ?? 0), 0);
  const bad = (text: string, when: boolean) => (when ? `<span class="js-bad">${text}</span>` : text);
  const cell = (label: string, value: string) => `<td class="k">${label}</td><td class="v">${value}</td>`;
  const rows = [
    [
      cell('Запуски', bad(`${good} успешно из ${runs.length}`, runs.length > 0 && good === 0)),
      cell(replica ? 'Последняя удачная' : 'Последняя точка', Number.isFinite(newest) ? `${dayLabel(newest, timezone)} ${timeOf(newest, timezone)}` : unknown ? '—' : bad(replica ? 'не было' : 'точек нет', true)),
      cell('Обычно идёт', report.usual ? spanOf(report.usual) : '—'),
    ],
    [
      cell('С ошибкой', `${bad(String(failed), failed > 0)}${going ? ` · идёт ${going}` : ''}${report.missed.length ? ` · не было ${report.missed.length}` : ''}`),
      replica
        ? cell('Передано', sent ? `${sizeOf(sent)} при последней удачной` : '—')
        : cell('Откат', report.depth ? `на ${report.depth.points} ${plural(report.depth.points, 'точку', 'точки', 'точек')}, до ${dayLabel(report.depth.oldest, timezone)}` : '—'),
      cell('Дольше всего', report.longest ? `${spanOf(report.longest.minutes)} · ${dayLabel(report.longest.start, timezone)}` : '—'),
    ],
    [
      cell(replica ? 'Машины реплицированы' : 'Машины сохранены', total ? bad(`${saved} из ${total}`, saved < total) : '—'),
      cell(replica ? 'Без удачной' : 'Не сохранены', total ? bad(String(total - saved), saved < total) : '—'),
      replica
        ? cell('Узкое место', report.bottleneck ? STAGE_NAMES[report.bottleneck] : '—')
        : cell('На диске', report.disk ? `${sizeOf(report.disk)}${report.data ? ` · данных ${sizeOf(report.data)}` : ''}` : '—'),
    ],
  ];
  return `<table class="js-t">${rows.map((row) => `<tr>${row.join('')}</tr>`).join('')}</table>`;
};

/**
 * The month of runs: a run a bar where it started, its height how long it
 * took on a scale of ten minutes, an hour, six hours, a day and three — so
 * that a twenty-minute run and a three-day one both read, with no bar cut
 * short and no label over another.
 */
const chart = (report: JobReport, timezone: string): string => {
  const W = 1000;
  const H = 360;
  const left = 64;
  const right = 24;
  const top = 12;
  const bottom = 34;
  const from = report.at - report.days * 86_400_000;
  const x = (at: number) => left + ((W - left - right) * (at - from)) / (report.at - from);
  const longest = Math.max(0, ...report.runs.map((run) => run.minutes));
  const ticks: Array<[number, string]> = [[10, '10 мин'], [60, '1 ч'], [360, '6 ч'], [1440, '1 сут'], [4320, '3 сут'], [10080, '7 сут']];
  const ceiling = Math.max(5760, longest * 1.15);
  const lo = Math.log(5);
  const hi = Math.log(ceiling);
  const y = (minutes: number) => top + (H - top - bottom) * (1 - (Math.log(Math.max(5, Math.min(ceiling, minutes))) - lo) / (hi - lo));
  const base = H - bottom;
  const barWidth = Math.max(3, Math.min(14, ((W - left - right) / report.days) * 0.55));
  const lines = ticks
    .filter(([minutes]) => minutes <= ceiling)
    .map(([minutes, label]) => `<line x1="${left}" x2="${W - right}" y1="${y(minutes).toFixed(1)}" y2="${y(minutes).toFixed(1)}" class="g"/><text x="${left - 8}" y="${(y(minutes) + 5).toFixed(1)}" text-anchor="end">${label}</text>`)
    .join('');
  const days = Array.from({ length: Math.floor(report.days / 5) + 1 }, (_, step) => from + step * 5 * 86_400_000);
  const dates = days
    .map((at, index) => `<line x1="${x(at).toFixed(1)}" x2="${x(at).toFixed(1)}" y1="${top}" y2="${base}" class="g"/><text x="${x(at).toFixed(1)}" y="${base + 22}" text-anchor="${index === 0 ? 'start' : x(at) > W - right - 30 ? 'end' : 'middle'}">${dayLabel(at, timezone)}</text>`)
    .join('');
  const bar = (run: JobRun) => {
    const height = Math.max(2, base - y(run.minutes));
    const going = run.result === 'none' && run.end === undefined;
    const colour = COLOUR[run.result] ?? COLOUR.none;
    return `<rect x="${(x(run.start) - barWidth / 2).toFixed(1)}" y="${(base - height).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${height.toFixed(1)}" ${going ? `fill="#fff" stroke="${COLOUR.none}" stroke-width="2"` : `fill="${colour}"`}/>`;
  };
  const missed = report.missed.map((at) => `<text x="${x(at).toFixed(1)}" y="${base - 5}" text-anchor="middle" class="m">×</text>`).join('');
  const empty = report.runs.length ? '' : `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">За ${report.days} дней запусков не было</text>`;
  return `<svg class="js-chart" viewBox="0 0 ${W} ${H}">${lines}${dates}<line x1="${left}" x2="${W - right}" y1="${base}" y2="${base}" class="a"/>${report.runs.map(bar).join('')}${missed}${empty}</svg>`;
};

/** How often a machine was saved of the runs it was in, and when last: in red when not every time, or never. */
const saves = (machine: ReportMachine, timezone: string): string =>
  `<td class="v">${machine.succeeded < machine.tookPart || !machine.tookPart ? `<span class="js-bad">${machine.succeeded} из ${machine.tookPart}</span>` : `${machine.succeeded} из ${machine.tookPart}`}</td><td class="v">${machine.lastSaved ? dayLabel(machine.lastSaved, timezone) : '<span class="js-bad">никогда</span>'}</td>`;

/** A machine none of the runs read took on, while Veeam would not give some: not known, which is not "never". */
const UNREAD = '<td class="v"><span class="js-dim">—</span></td><td class="v"><span class="js-dim">нет сведений</span></td>';

const machinesTable = (report: JobReport, timezone: string): string => {
  const shown: ReportMachine[] = report.machines.slice(0, MACHINE_ROWS);
  if (!shown.length) return '<table class="js-t"><tr><td class="js-dim">Сведений по машинам нет: запусков не было, или Veeam их не отдал.</td></tr></table>';
  const rows = shown
    .map(
      (machine) => `<tr><td class="v js-name">${esc(shortName(machine.name))}</td><td><div class="js-hist">${machine.history.map((outcome) => `<i style="background:${outcome === 'none' ? COLOUR.empty : COLOUR[outcome]}"></i>`).join('')}</div></td>${machine.unread ? UNREAD : saves(machine, timezone)}<td><div class="js-err">${esc(machine.error ?? '')}${machine.errorTone === 'healed' ? ' <span class="js-dim">· повтор помог</span>' : ''}</div></td></tr>`,
    )
    .join('');
  const more = report.machines.length - shown.length;
  return `<table class="js-t js-vms"><tr class="th"><td>Машина</td><td>По ${report.history.byDay ? 'дням' : 'запускам'}</td><td>Успешно</td><td>Сохранена</td><td>Последняя ошибка</td></tr>${rows}</table>${more > 0 ? `<div class="js-more">и ещё ${more} — в сессиях на следующих страницах</div>` : ''}`;
};

const stepsTable = (report: JobReport): string => {
  const shown = report.steps.slice(0, STEP_ROWS);
  const rows = shown
    .map((step, index) => `<tr class="${step.severity}"><td class="k">${index + 1}</td><td><b>${esc(step.title)}</b><p>${esc(step.detail)}${step.tags.length ? ` ${esc(step.tags.slice(0, 3).map(shortName).join(', '))}` : ''}</p></td></tr>`)
    .join('');
  const rest = report.steps.slice(STEP_ROWS);
  return `<table class="js-t js-steps">${rows}</table>${rest.length ? `<div class="js-more">Ещё: ${rest.map((step) => esc(step.title.charAt(0).toLowerCase() + step.title.slice(1))).join('; ')}.</div>` : ''}`;
};

const neighboursTable = (report: JobReport, timezone: string): string => {
  const { neighbours, repository } = report;
  const window = neighbours.window as { start: number; end: number };
  const position = (at: number) => Math.max(0, Math.min(100, (100 * (at - neighbours.origin)) / 86_400_000));
  const rows = neighbours.rows.slice(0, NEIGHBOUR_ROWS + 1);
  const more = neighbours.jobs - (rows.length - 1);
  return `<div class="js-band">Кто ещё писал в ${esc(repository?.short ?? 'репозиторий')} ${dayLabel(window.start, timezone)}</div>
  <table class="js-t js-nb">${rows
    .map(
      (row) =>
        `<tr><td class="v js-name">${row.own ? `<b>${esc(row.name)}</b>` : esc(row.name)}</td><td class="js-track">${row.spans.map(({ start, end }) => `<i class="${row.own ? 'own' : ''}" style="left:${position(start).toFixed(1)}%;width:${Math.max(0.8, position(end) - position(start)).toFixed(1)}%"></i>`).join('')}</td><td class="v">${timeOf(row.spans[0].start, timezone)}–${timeOf(row.spans[0].end, timezone)}${row.spans.length > 1 ? ` <span class="js-dim">+${row.spans.length - 1}</span>` : ''}</td></tr>`,
    )
    .join('')}<tr><td class="js-dim">${neighbours.jobs} из ${neighbours.of} заданий${report.bottleneck ? ` · узкое место ${STAGE_NAMES[report.bottleneck]}` : ''}</td><td><div class="js-axis">${[12, 15, 18, 21, 0, 3, 6, 9].map((hour) => `<span>${String(hour).padStart(2, '0')}</span>`).join('')}</div></td><td></td></tr></table>${more > 0 ? `<div class="js-more">и ещё ${more}</div>` : ''}`;
};

const errorsTable = (report: JobReport, timezone: string): string => `<div class="js-band">Последние ошибки</div>
  <table class="js-t"><tr class="th"><td>Что писал Veeam</td><td>Машин</td><td>Последний раз</td></tr>${[...report.errors]
    // The newest first: on this page it is the latest trouble that matters.
    .sort((a, b) => b.last - a.last)
    .slice(0, ERROR_ROWS)
    .map((group) => `<tr><td><div class="js-err">${esc(group.text.slice(0, 160))}</div></td><td class="v">${group.machines.length}</td><td class="v">${dayLabel(group.last, timezone)} · ${group.runs} ${runsWord(group.runs)}</td></tr>`)
    .join('')}</table>`;

/** The retained runs a day a row, as the Evidence has them; "—" where Veeam did not type a point, or no file names it. */
const chainTable = (report: JobReport): string => `<div class="js-band">Цепочка на диске</div>
  <table class="js-t"><tr class="th"><td>День</td><td>Файл</td><td>На диске</td><td>Данных</td></tr>${
    report.chain.length
      ? report.chain
          .slice(0, CHAIN_ROWS)
          .map((day) => `<tr><td class="v">${calendarLabel(day.day)}</td><td class="v">${day.full === undefined ? '—' : day.full ? 'Full' : 'инкремент'}</td><td class="v">${day.disk !== undefined ? sizeOf(day.disk) : '—'}</td><td class="v">${day.data ? sizeOf(day.data) : '—'}</td></tr>`)
          .join('')
      : `<tr><td colspan="4" class="js-dim">${esc(report.pointsUnavailable ?? 'У задания нет ни одной точки восстановления.')}</td></tr>`
  }</table>`;

/* ------------------------------------------------------------------ *
 * The first page's sheet: Veeam's header, grey bars and ruled tables
 * ------------------------------------------------------------------ */

const STYLE = `
@page { size: 297mm 210mm; margin: 0; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: #fff; }
.js { width: 297mm; height: 210mm; padding: 9mm 10mm; display: flex; flex-direction: column; gap: 2.4mm; overflow: hidden; break-after: page; font-family: 'Inter Variable', Tahoma, sans-serif; font-size: 8.5pt; line-height: 1.32; color: #000; }
.js * { box-sizing: border-box; margin: 0; padding: 0; }
.js table { border-collapse: collapse; width: 100%; }
.js-hd td { background: var(--band); color: var(--ink, #fff); font-weight: 700; font-size: 13pt; height: 15mm; vertical-align: bottom; padding: 0 3.6mm 3mm; }
.js-hd .js-s { width: 27%; border-left: 0.25mm solid rgba(255, 255, 255, 0.5); }
.js-d { font-size: 8pt; margin-top: 0.8mm; }
.js-t td { border: 0.25mm solid #a7a9ac; padding: 0.6mm 1mm; vertical-align: top; }
.js-t .k { font-weight: 700; white-space: nowrap; width: 1%; }
.js-t .v { white-space: nowrap; }
.js-t .th td { background: #e3e3e3; font-weight: 700; white-space: nowrap; }
.js-t td.js-verdict { font-weight: 700; font-size: 9.4pt; padding: 1.4mm 1.6mm; }
.js-partial { color: #9a6700; font-size: 7.2pt; }
.js-band { background: #f3f4f4; color: #626365; font-size: 11pt; padding: 1.6mm 3.6mm; border: 0.25mm solid #a7a9ac; border-bottom: none; }
.js-two { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 3mm; }
.js-col { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.js-col > .js-band:not(:first-child) { margin-top: 2.4mm; }
.js-box { border: 0.25mm solid #a7a9ac; padding: 1.6mm 2mm 1.2mm; }
.js-chart { width: 100%; height: auto; display: block; font-family: 'Inter Variable', sans-serif; }
.js-chart text { font-size: 16px; fill: #626365; }
.js-chart .g { stroke: #e3e3e3; stroke-width: 1; }
.js-chart .a { stroke: #a7a9ac; stroke-width: 1; }
.js-chart .m { font-size: 18px; font-weight: 700; fill: #000; }
.js-legend { display: flex; gap: 4mm; flex-wrap: wrap; color: #626365; font-size: 7.6pt; margin-top: 0.6mm; }
.js-legend i { display: inline-block; width: 3mm; height: 2.2mm; margin-right: 1mm; vertical-align: -0.3mm; }
.js-legend i.run { background: #fff; box-shadow: inset 0 0 0 0.35mm ${COLOUR.none}; }
.js-legend b { color: #000; margin-right: 0.8mm; }
.js-bad { color: #ff0000; font-weight: 700; }
.js-dim { color: #626365; }
.js-name { max-width: 44mm; overflow: hidden; text-overflow: ellipsis; }
.js-hist { display: flex; gap: 0.5mm; } .js-hist i { width: 2.6mm; height: 2.6mm; display: block; flex: none; }
.js-err { font-size: 7.6pt; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; word-break: break-word; }
.js-steps p { color: #626365; font-size: 7.8pt; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.js-steps tr.crit b { color: #ff0000; }
.js-steps tr.warn b { color: #9a6700; }
.js-more { color: #626365; font-size: 7.6pt; padding: 0.8mm 1mm 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.js-nb .js-name { width: 34mm; }
.js-track { position: relative; width: 100%; } .js-track i { position: absolute; top: 1mm; bottom: 1mm; background: #b8c4d0; } .js-track i.own { background: #5b7fa6; }
.js-axis { display: flex; justify-content: space-between; color: #626365; font-size: 6.6pt; }
.js-next { color: #626365; font-size: 7pt; text-align: right; margin-top: auto; }
`;
