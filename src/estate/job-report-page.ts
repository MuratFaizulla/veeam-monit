import { escapeHtml as esc } from '../telegram/format';
import { plural } from '../telegram/time';
import { jobTypeWord } from '../telegram/words';
import { calendarLabel, dayLabel, JobReport, JobRun, Outcome, ReportMachine, sizeOf, spanOf } from './job-report';
import { envelope, ReportDocument, stampOf, Status, STATUS_WORD } from './report-envelope';
import { STAGE_NAMES } from './repository-report';
import { SessionReport } from './session-report';
import { SESSION_STYLE, sessionsHtml } from './session-report-page';
import { GUIDE, guideBand, guideFoot, guideStyle } from './guide-look';

/**
 * The Job report as one HTML document for the browser to print: first a page
 * that says at a glance how the job stands, then every session, newest
 * first. The first page is a dark panel — Veeam's logo, the job, how it is
 * set up, its last run, its repository and its Fulls — beside the verdict,
 * five numbers, the month of runs, the machines, what to do, and who else
 * writes where it does. In the colours veeam.com is drawn in: its green for
 * what went well, an amber and a coral of the same strength for what did
 * not. The first page is in Russian, the sessions in Veeam's English.
 */
export const jobReportPage = (report: JobReport, sessions: SessionReport, timezone: string): ReportDocument => {
  const stamp = stampOf(report.at, timezone);
  return envelope({
    lang: 'ru',
    title: `${report.name} — ${stamp}`,
    style: `${guideStyle(footOf(report, stamp))}${STYLE}${SESSION_STYLE}`,
    body: `${summary(report, timezone, stamp)}${sessionsHtml(sessions, timezone)}`,
  });
};

/** What fits the first page by construction: the browser grows a row to its content when it prints. */
const MACHINE_ROWS = 8;
const STEP_ROWS = 2;
/** At most; the card shows as many of them as the steps above leave room for, and says how many wrote under its head. */
const NEIGHBOUR_ROWS = 4;
const ERROR_ROWS = 3;
const CHAIN_ROWS = 6;

/** One family: Veeam's green, and an amber and a coral as strong as it is. */
const COLOUR = { success: '#00d15f', warning: '#ffb224', failed: '#ff5a5f', none: '#00a7e2', empty: '#e3edeb' } as const;

/** A state is its mark and its word, never the colour alone. */
const MARK: Record<Status, string> = {
  crit: `<svg class="js-mk" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="${COLOUR.failed}"/><path d="M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  warn: `<svg class="js-mk" viewBox="0 0 16 16"><path d="M8 1.2 15.4 14.2H.6z" fill="${COLOUR.warning}"/><path d="M8 6v4" stroke="#3d2a00" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="12" r="1" fill="#3d2a00"/></svg>`,
  ok: `<svg class="js-mk" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="${COLOUR.success}"/><path d="M4.6 8.3l2.3 2.3 4.5-4.9" stroke="#010d35" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  unknown: '<svg class="js-mk" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="#adacaf"/><path d="M5.4 8h5.2" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>',
};
/** How a run ended, as the panel says its last one. */
const RESULT: Record<Outcome, [Status, string]> = { success: ['ok', 'Успешно'], warning: ['warn', 'С предупреждением'], failed: ['crit', 'Ошибка'], none: ['unknown', 'Идёт'] };

const machinesWord = (count: number) => plural(count, 'машина', 'машины', 'машин');
const runsWord = (count: number) => plural(count, 'запуск', 'запуска', 'запусков');
const timeOf = (at: number, timezone: string): string =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: timezone || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
/** "db-01 (4f2edb3f-…)" is how vCloud names a machine; the id says nothing on this page. */
export const shortName = (name: string) => name.replace(/\s\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)$/i, '');
/** A replica keeps its points on the target host, where the restore points the bot reads are not. */
const isReplica = (report: JobReport) => /replica/i.test(report.type ?? '');

// --- The first page: the band, the job, the verdict, five numbers, the month of runs and what to do
const summary = (report: JobReport, timezone: string, stamp: string): string => {
  const total = report.machines.length;
  return `<section class="js">
  ${guideBand('отчёт по заданию')}
  <div class="g-kicker js-kind">Отчёт по заданию</div><h1>${esc(report.name).replace(/_/g, '_<wbr>')}</h1>
  <hr class="g-rule">
  <div class="g-meta"><span class="g-state js-status">${MARK[report.status]}${STATUS_WORD[report.status]}</span><span>${esc(jobTypeWord(report.type))}${total ? ` · ${total} ${machinesWord(total)}` : ''}</span><span>${esc(report.server)} · за ${report.days} дней</span><span>${stamp}</span></div>
  <div class="g-note ${report.status} js-verdict"><b>${STATUS_WORD[report.status]}:</b> ${esc(report.verdict)}.</div>
  ${report.partial ? `<div class="js-partial">Прочитано не всё: ${esc(report.partial.slice(0, 220))}</div>` : ''}
  ${report.pointsUnavailable ? `<div class="js-partial">${esc(report.pointsUnavailable)}</div>` : ''}
  <h2 class="g-h2">Коротко</h2>
  ${numbers(report, timezone, isReplica(report))}
  <h2 class="g-h2">Запуски за ${report.days} дней</h2>
  ${chart(report, timezone)}
  <div class="js-legend"><span><i style="background:${COLOUR.success}"></i>успешно</span><span><i style="background:${COLOUR.warning}"></i>с предупреждением</span><span><i style="background:${COLOUR.failed}"></i>ошибка</span><span><i class="run"></i>идёт</span><span><b>×</b> не было запуска по расписанию</span>${report.usual ? `<span><i class="dash"></i>обычно ${spanOf(report.usual)}</span>` : ''}</div>
  <h2 class="g-h2">Что сделать</h2>
  ${stepsTable(report)}
  ${guideFoot(footOf(report, stamp))}
</section>
<div class="js-rest">
  <h2 class="g-h2">Машины</h2>
  ${machinesTable(report, timezone)}
  <h2 class="g-h2">Настройки задания</h2>
  ${settings(report, timezone)}
  ${report.neighbours.jobs && report.neighbours.window ? neighboursTable(report, timezone) : report.errors.length ? errorsTable(report, timezone) : chainTable(report)}
  <p class="js-next">Дальше — каждая сессия за ${report.days} дней, новые сверху: цифры сессии и каждая машина с тем, что Veeam о ней написал.</p>
</div>`;
};

/** The foot line of every page: what the document is and when it was read. */
const footOf = (report: JobReport, stamp: string): string => `Veeam Backup & Replication | Отчёт по заданию ${report.name} | ${stamp}`;

/** What the job is and how it is set up, and its last run, repository and Fulls: the Guide's two-column table. */
const settings = (report: JobReport, timezone: string): string => {
  const total = report.machines.length;
  const { repository } = report;
  const free = repository ? (100 * repository.freeGB) / repository.capacityGB : 0;
  const rows: Array<[string, string | undefined | false]> = [
    ['Тип', esc(`${jobTypeWord(report.type)}${total ? ` · ${total} ${machinesWord(total)}` : ''}`)],
    ['Сервер', esc(report.server)],
    ['Расписание', report.schedule && esc(report.schedule)],
    ['Повторы', report.retry && esc(report.retry)],
    ['Хранение', report.retention && esc(report.retention)],
    ['Full', report.fulls && esc(report.fulls)],
  ];
  const last = report.runs.at(-1);
  if (last) {
    const [status, word] = RESULT[last.result];
    rows.push([
      'Последний запуск',
      `<span class="js-sv">${MARK[status]}<b>${word}</b></span> · ${dayLabel(last.start, timezone)} в ${timeOf(last.start, timezone)} · шёл ${spanOf(last.minutes)}${last.machines ? ` · машин ${last.saved ?? 0} из ${last.machines}` : ''}${last.pieces.length > 1 ? ` · попыток ${last.pieces.length}` : ''}`,
    ]);
  }
  if (repository) {
    rows.push([
      `Репозиторий`,
      `${esc(repository.short)} · <b>${(repository.freeGB / 1024).toFixed(1).replace('.', ',')} ТБ</b> свободно из ${Math.round(repository.capacityGB / 1024)} ТБ · <span class="${free < 10 ? 'js-bad' : ''}">${Math.round(free)}%</span>${report.disk ? ` · задание занимает ${sizeOf(report.disk)}` : ''}<div class="js-sbar"><i class="${free < 10 ? 'crit' : free < 20 ? 'warn' : ''}" style="width:${(100 - free).toFixed(1)}%"></i></div>`,
    ]);
  }
  if (report.lastFull) rows.push(['Последний Full', `${dayLabel(report.lastFull.at, timezone)} · ${sizeOf(report.lastFull.disk)} на диске`]);
  if (report.nextFull) rows.push(['Следующий Full', `${calendarLabel(report.nextFull.day)} · ${report.nextFull.kind === 'synthetic' ? 'Synthetic Full' : 'Active Full'}`]);
  return `<table class="g-table g-spec js-facts"><thead><tr><th>Параметр</th><th>Значение</th></tr></thead><tbody>${rows
    .filter(([, value]) => value)
    .map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`)
    .join('')}</tbody></table>`;
};

/** Five numbers: what a reader asks first. A replica is told by its runs. */
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
  const tile = (label: string, value: string, detail: string, bad = false) =>
    `<div class="js-tile${bad ? ' bad' : ''}"><div class="js-tk">${label}</div><div class="js-tv">${value}</div><div class="js-td">${detail}</div></div>`;
  const tiles = [
    tile(
      'Запуски',
      `${good}<small> из ${runs.length}</small>`,
      `успешно${failed ? ` · с ошибкой ${failed}` : ''}${going ? ` · идёт ${going}` : ''}${report.missed.length ? ` · не было ${report.missed.length}` : ''}`,
      runs.length > 0 && good === 0,
    ),
    tile(replica ? 'Машины реплицированы' : 'Машины сохранены', total ? `${saved}<small> из ${total}</small>` : '—', total ? (saved < total ? `${replica ? 'без удачной' : 'не сохранены'}: ${total - saved}` : 'все') : '', saved < total),
    tile(
      replica ? 'Последняя удачная' : 'Последняя точка',
      Number.isFinite(newest) ? `${dayLabel(newest, timezone)}<small> ${timeOf(newest, timezone)}</small>` : unknown ? '—' : replica ? 'не было' : 'точек нет',
      replica ? (sent ? `передано ${sizeOf(sent)}` : '') : report.depth ? `откат на ${report.depth.points} ${plural(report.depth.points, 'точку', 'точки', 'точек')}, до ${dayLabel(report.depth.oldest, timezone)}` : '',
      !Number.isFinite(newest) && !unknown,
    ),
    tile('Обычно идёт', report.usual ? spanOf(report.usual) : '—', report.longest ? `дольше всего ${spanOf(report.longest.minutes)} · ${dayLabel(report.longest.start, timezone)}` : ''),
    replica
      ? tile('Узкое место', report.bottleneck ? STAGE_NAMES[report.bottleneck] : '—', '')
      : tile('На диске', report.disk ? sizeOf(report.disk) : '—', `${report.data ? `данных ${sizeOf(report.data)}` : ''}${report.bottleneck ? `${report.data ? ' · ' : ''}узкое место ${STAGE_NAMES[report.bottleneck]}` : ''}`),
  ];
  return `<div class="js-tiles">${tiles.join('')}</div>`;
};

/**
 * The month of runs: a run a bar where it started, its height how long it
 * took on a scale of ten minutes, an hour, six hours, a day and three — so
 * that a twenty-minute run and a three-day one both read, with no bar cut
 * short and no label over another. The dashed line is the usual run.
 */
const chart = (report: JobReport, timezone: string): string => {
  const W = 1000;
  const H = 132;
  const left = 58;
  const right = 14;
  const top = 10;
  const bottom = 30;
  const from = report.at - report.days * 86_400_000;
  const x = (at: number) => left + ((W - left - right) * (at - from)) / (report.at - from);
  const longest = Math.max(0, ...report.runs.map((run) => run.minutes));
  const ticks: Array<[number, string]> = [[10, '10 мин'], [60, '1 ч'], [360, '6 ч'], [1440, '1 сут'], [4320, '3 сут'], [10080, '7 сут']];
  const ceiling = Math.max(1440, longest * 1.25);
  const lo = Math.log(5);
  const hi = Math.log(ceiling);
  const y = (minutes: number) => top + (H - top - bottom) * (1 - (Math.log(Math.max(5, Math.min(ceiling, minutes))) - lo) / (hi - lo));
  const base = H - bottom;
  const barWidth = Math.max(4, Math.min(16, ((W - left - right) / report.days) * 0.6));
  const lines = ticks
    .filter(([minutes]) => minutes <= ceiling)
    .map(([minutes, label]) => `<line x1="${left}" x2="${W - right}" y1="${y(minutes).toFixed(1)}" y2="${y(minutes).toFixed(1)}" class="g"/><text x="${left - 8}" y="${(y(minutes) + 4.5).toFixed(1)}" text-anchor="end">${label}</text>`)
    .join('');
  const usual = report.usual ? `<line x1="${left}" x2="${W - right}" y1="${y(report.usual).toFixed(1)}" y2="${y(report.usual).toFixed(1)}" class="u"/>` : '';
  const days = Array.from({ length: Math.floor(report.days / 5) + 1 }, (_, step) => from + step * 5 * 86_400_000);
  const dates = days
    .map((at, index) => `<text x="${x(at).toFixed(1)}" y="${base + 20}" text-anchor="${index === 0 ? 'start' : x(at) > W - right - 30 ? 'end' : 'middle'}">${dayLabel(at, timezone)}</text>`)
    .join('');
  const bar = (run: JobRun) => {
    const height = Math.max(4, base - y(run.minutes));
    const going = run.result === 'none' && run.end === undefined;
    const r = Math.min(2, barWidth / 2);
    const X = x(run.start) - barWidth / 2;
    const Y = base - height;
    const path = `M${X.toFixed(1)} ${base} V${(Y + r).toFixed(1)} Q${X.toFixed(1)} ${Y.toFixed(1)} ${(X + r).toFixed(1)} ${Y.toFixed(1)} H${(X + barWidth - r).toFixed(1)} Q${(X + barWidth).toFixed(1)} ${Y.toFixed(1)} ${(X + barWidth).toFixed(1)} ${(Y + r).toFixed(1)} V${base} Z`;
    return `<path d="${path}" ${going ? `fill="#fff" stroke="${COLOUR.none}" stroke-width="1.6"` : `fill="${COLOUR[run.result] ?? COLOUR.none}"`}/>`;
  };
  const missed = report.missed.map((at) => `<text x="${x(at).toFixed(1)}" y="${base - 5}" text-anchor="middle" class="m">×</text>`).join('');
  const empty = report.runs.length ? '' : `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">За ${report.days} дней запусков не было</text>`;
  return `<svg class="js-chart" viewBox="0 0 ${W} ${H}">${lines}${usual}${dates}<line x1="${left}" x2="${W - right}" y1="${base}" y2="${base}" class="a"/>${report.runs.map(bar).join('')}${missed}${empty}</svg>`;
};

/** How often a machine was saved of the runs it was in, and when last: in red when not every time, or never. */
const saves = (machine: ReportMachine, timezone: string): string =>
  `<td class="r nw">${machine.succeeded < machine.tookPart || !machine.tookPart ? `<b class="js-bad">${machine.succeeded}</b>` : `<b>${machine.succeeded}</b>`}<span class="js-dim"> из ${machine.tookPart}</span></td><td class="r nw">${machine.lastSaved ? dayLabel(machine.lastSaved, timezone) : '<b class="js-bad">никогда</b>'}</td>`;

/** A machine none of the runs read took on, while Veeam would not give some: not known, which is not "never". */
const UNREAD = '<td class="r nw"><span class="js-dim">—</span></td><td class="r nw"><span class="js-dim">нет сведений</span></td>';

const machineMark = (machine: ReportMachine): string =>
  machine.unread ? MARK.unknown : machine.failing ? MARK.crit : machine.succeeded < machine.tookPart || !machine.tookPart ? MARK.warn : MARK.ok;

/**
 * A machine's name, free to break after its separators: a name runs to thirty
 * letters and more, and two lines of it say which machine it is where one cut
 * short does not — «REMS-DACS01_r…» was two machines.
 */
const breakable = (name: string): string => esc(name).replace(/([_.\-])/g, '$1<wbr>');
/** More runs than this, and the bars of a machine's history stand closer, to keep the column its name needs. */
const DENSE_RUNS = 20;

/**
 * The height the machines' rows have on the first page, under the card's head
 * and its «и ещё», at the most the verdict and the tiles above leave them, and
 * what one machine's rows take of it — a name long enough to need its second
 * line, and what Veeam said under it at one line or two. Each guessed long:
 * a machine left to the sessions' pages is said there, one cut off is not.
 */
const MACHINE_ROOM_MM = 74;
const machineHeight = (machine: ReportMachine): number => {
  const error = machine.error ? machine.error.length + (machine.errorTone === 'healed' ? 15 : 0) : 0;
  return 7.2 + (shortName(machine.name).length > 18 ? 3.3 : 0) + (error ? 4 + (error > 64 ? 3.3 : 0) : 0);
};

/** The machines the first page holds: the first ones, as many as their rows fit, and never fewer than one. */
const machinesShown = (machines: readonly ReportMachine[]): ReportMachine[] => {
  let room = MACHINE_ROOM_MM;
  const shown: ReportMachine[] = [];
  for (const machine of machines.slice(0, MACHINE_ROWS)) {
    room -= machineHeight(machine);
    if (room < 0 && shown.length) break;
    shown.push(machine);
  }
  return shown;
};

const machinesTable = (report: JobReport, timezone: string): string => {
  const shown = machinesShown(report.machines);
  if (!shown.length) return '<div class="js-dim">Сведений по машинам нет: запусков не было, или Veeam их не отдал.</div>';
  const rows = shown
    .map(
      (machine) =>
        `<tr${machine.error ? ' class="js-hasx"' : ''}><td><div class="js-name">${machineMark(machine)}<div><span>${breakable(shortName(machine.name))}</span></div></div></td><td><div class="js-hist${machine.history.length > DENSE_RUNS ? ' dense' : ''}">${machine.history.map((outcome) => `<i style="background:${outcome === 'none' ? COLOUR.empty : COLOUR[outcome]}"></i>`).join('')}</div></td>${machine.unread ? UNREAD : saves(machine, timezone)}</tr>${
          // Under the machine, across the row: the name's column is too narrow to hold what Veeam said.
          machine.error ? `<tr class="js-x"><td colspan="4"><div class="js-err">${esc(machine.error)}${machine.errorTone === 'healed' ? ' · повтор помог' : ''}</div></td></tr>` : ''
        }`,
    )
    .join('');
  const more = report.machines.length - shown.length;
  return `<table class="js-vms"><colgroup><col class="c-n"><col><col class="c-s"><col class="c-d"></colgroup><thead><tr><th>Машина</th><th>По ${report.history.byDay ? 'дням' : 'запускам'}</th><th class="r">Успешно</th><th class="r">Сохранена</th></tr></thead><tbody>${rows}</tbody></table>${more > 0 ? `<div class="js-more">и ещё ${more} — в сессиях на следующих страницах</div>` : ''}`;
};

const stepsTable = (report: JobReport): string => {
  const shown = report.steps.slice(0, STEP_ROWS);
  const rows = shown
    .map((step, index) => `<div class="js-step ${step.severity}"><span class="n">${index + 1}</span><div><b>${esc(step.title)}</b><p>${esc(step.detail)}</p>${step.tags.length ? `<div class="js-tags">${step.tags.slice(0, 4).map((tag) => `<span>${esc(shortName(tag))}</span>`).join('')}</div>` : ''}</div></div>`)
    .join('');
  const rest = report.steps.slice(STEP_ROWS);
  return `<div class="js-steps">${rows}</div>${rest.length ? `<div class="js-more">Ещё: ${rest.map((step) => esc(step.title.charAt(0).toLowerCase() + step.title.slice(1))).join('; ')}.</div>` : ''}`;
};

const neighboursTable = (report: JobReport, timezone: string): string => {
  const { neighbours, repository } = report;
  const window = neighbours.window as { start: number; end: number };
  const position = (at: number) => Math.max(0, Math.min(100, (100 * (at - neighbours.origin)) / 86_400_000));
  const rows = neighbours.rows.slice(0, NEIGHBOUR_ROWS + 1);
  return `<div class="js-panel"><h3>Кто ещё писал в ${esc(repository?.short ?? 'репозиторий')} ${dayLabel(window.start, timezone)}</h3><div class="js-sub">${neighbours.jobs} из ${neighbours.of} заданий${report.bottleneck ? ` · узкое место ${STAGE_NAMES[report.bottleneck]}` : ''}</div>
  <div class="js-nr js-ax"><span></span><span class="js-axis">${[12, 18, 0, 6, 12].map((hour) => `<span>${String(hour).padStart(2, '0')}</span>`).join('')}</span><span></span></div>
  <div class="js-nb">${rows
    .map(
      (row) =>
        `<div class="js-nr"><span class="js-nn${row.own ? ' own' : ''}">${esc(row.name)}</span><span class="js-track">${row.spans.map(({ start, end }) => `<i class="${row.own ? 'own' : ''}" style="left:${position(start).toFixed(1)}%;width:${Math.max(0.8, position(end) - position(start)).toFixed(1)}%"></i>`).join('')}</span><span class="js-nt">${timeOf(row.spans[0].start, timezone)}–${timeOf(row.spans[0].end, timezone)}${row.spans.length > 1 ? ` +${row.spans.length - 1}` : ''}</span></div>`,
    )
    .join('')}</div></div>`;
};

const errorsTable = (report: JobReport, timezone: string): string => `<div class="js-panel"><h3>Последние ошибки</h3><div class="js-sub">Что писал Veeam, новые сверху</div>
  <div class="js-errs">${[...report.errors]
    // The newest first: on this page it is the latest trouble that matters.
    .sort((a, b) => b.last - a.last)
    .slice(0, ERROR_ROWS)
    .map((group) => `<div class="js-er"><div class="js-et">${esc(group.text.slice(0, 170))}</div><div class="js-em"><b>${group.machines.length}</b> ${machinesWord(group.machines.length)} · ${group.runs} ${runsWord(group.runs)} · последний раз ${dayLabel(group.last, timezone)}</div></div>`)
    .join('')}</div></div>`;

/** The retained runs a day a row, as the Evidence has them; "—" where Veeam did not type a point, or no file names it. */
const chainTable = (report: JobReport): string => {
  const biggest = Math.max(1, ...report.chain.map((day) => day.disk ?? 0));
  return `<div class="js-panel"><h3>Цепочка на диске</h3><div class="js-sub">Сохранённые запуски по дням, новые сверху: на диске и сколько в них данных</div>
  <div class="js-chain">${
    report.chain.length
      ? report.chain
          .slice(0, CHAIN_ROWS)
          .map((day) => `<div class="js-ch"><span class="nw">${calendarLabel(day.day)}</span><span class="js-tag${day.full ? ' full' : ''}">${day.full === undefined ? '—' : day.full ? 'Full' : 'инкремент'}</span><span class="js-cb"><i class="${day.full ? 'full' : ''}" style="width:${Math.max(2, (100 * (day.disk ?? 0)) / biggest).toFixed(1)}%"></i></span><span class="r nw"><b>${day.disk !== undefined ? sizeOf(day.disk) : '—'}</b></span><span class="r nw js-dim">${day.data ? sizeOf(day.data) : '—'}</span></div>`)
          .join('')
      : `<div class="js-dim">${esc(report.pointsUnavailable ?? 'У задания нет ни одной точки восстановления.')}</div>`
  }</div></div>`;
};

/* ------------------------------------------------------------------ *
 * The look of Veeam's User Guide (./guide-look), and what is this report's own
 * ------------------------------------------------------------------ */

const STYLE = `
.js { page: cover; position: relative; height: 297mm; padding: 0 16mm; overflow: hidden; break-after: page; box-sizing: border-box; }
.js h1 { margin: 0; color: ${GUIDE.green}; font-weight: 300; font-size: 26pt; line-height: 1.12; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.js b, .js-rest b { font-weight: 650; }
.nw { white-space: nowrap; } .r { text-align: right; }
.js-mk { width: 3.6mm; height: 3.6mm; flex: none; vertical-align: -0.6mm; }
.g-state .js-mk { width: 4mm; height: 4mm; }
.js-bad { color: #e5484d; } .js-dim { color: ${GUIDE.muted}; }
.js-partial { color: ${GUIDE.muted}; font-size: 7.8pt; margin-top: 1.4mm; padding-left: 4.9mm; }

.js-tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); border: 0.25mm solid ${GUIDE.rule}; border-top: none; }
.js-tile { min-width: 0; border-left: 0.25mm solid ${GUIDE.rule}; display: flex; flex-direction: column; } .js-tile:first-child { border-left: none; }
.js-tk { background: ${GUIDE.head}; color: #fff; font-weight: 500; font-size: 8pt; padding: 1.9mm 2.6mm; min-height: 11.5mm; box-sizing: border-box; }
.js-tv { font-size: 16pt; font-weight: 300; line-height: 1.15; white-space: nowrap; padding: 2mm 2.6mm 0; } .js-tv small { font-size: 8.4pt; color: ${GUIDE.muted}; }
.js-tile.bad .js-tv { color: #e5484d; }
.js-td { font-size: 7.6pt; color: ${GUIDE.muted}; padding: 0.4mm 2.6mm 2.2mm; }

.js-chart { width: 100%; height: auto; display: block; font-family: 'Inter Variable', sans-serif; }
.js-chart text { font-size: 13px; fill: ${GUIDE.muted}; font-weight: 300; }
.js-chart .g { stroke: #e6e6e6; stroke-width: 1; } .js-chart .a { stroke: #9a9a9a; stroke-width: 1; }
.js-chart .u { stroke: #6b6b6b; stroke-width: 1.2; stroke-dasharray: 5 4; }
.js-chart .m { font-size: 16px; font-weight: 650; fill: ${GUIDE.ink}; }
.js-legend { display: flex; flex-wrap: wrap; gap: 0.6mm 4mm; font-size: 7.6pt; color: ${GUIDE.muted}; margin-top: 1.2mm; }
.js-legend span { white-space: nowrap; }
.js-legend i { display: inline-block; width: 2.8mm; height: 2.8mm; margin-right: 1.1mm; vertical-align: -0.4mm; }
.js-legend i.run { background: #fff; box-shadow: inset 0 0 0 0.3mm ${COLOUR.none}; }
.js-legend i.dash { height: 0; width: 4mm; border-top: 0.35mm dashed #6b6b6b; vertical-align: 0.7mm; }
.js-legend b { color: ${GUIDE.ink}; }

.js-steps { display: flex; flex-direction: column; gap: 2.6mm; }
.js-step { display: flex; gap: 2.6mm; break-inside: avoid; }
.js-step .n { flex: none; width: 5.2mm; height: 5.2mm; border-radius: 50%; background: ${GUIDE.green}; color: #fff; font-weight: 650; font-size: 8pt; display: flex; align-items: center; justify-content: center; margin-top: 0.2mm; }
.js-step.crit .n { background: ${COLOUR.failed}; } .js-step.warn .n { background: ${COLOUR.warning}; color: #3d2a00; }
.js-step b { font-weight: 650; display: block; font-size: 9pt; }
.js-step p { margin: 0.4mm 0 0; color: #333; }
.js-tags { display: flex; flex-wrap: wrap; gap: 1mm 3mm; margin-top: 0.8mm; } .js-tags span::before { content: '□ '; color: ${GUIDE.muted}; }
.js-more { color: ${GUIDE.muted}; font-size: 7.8pt; padding-top: 1.4mm; }

.js-vms { width: 100%; border-collapse: collapse; table-layout: fixed; }
.js-vms col.c-n { width: 40%; } .js-vms col.c-s { width: 22mm; } .js-vms col.c-d { width: 22mm; }
.js-vms th { background: ${GUIDE.head}; color: #fff; font-weight: 500; font-size: 8pt; text-align: left; padding: 1.9mm 2.6mm; border: 0.25mm solid ${GUIDE.head}; white-space: nowrap; }
.js-vms th.r { text-align: right; }
.js-vms td { padding: 1.7mm 2.6mm; vertical-align: top; border: 0.25mm solid ${GUIDE.rule}; }
.js-vms tr { break-inside: avoid; }
.js-vms tr.js-hasx td { border-bottom: none; padding-bottom: 0.4mm; } .js-vms tr.js-x td { border-top: none; padding: 0 2.6mm 1.7mm 7.6mm; }
.js-vms tr.js-hasx td:nth-child(n+2) { border-bottom: none; }
.js-name { display: flex; align-items: flex-start; gap: 1.6mm; font-weight: 500; line-height: 1.25; }
.js-name .js-mk { width: 3.2mm; height: 3.2mm; margin-top: 0.3mm; } .js-name > div { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.js-err { font-size: 7.6pt; color: ${GUIDE.muted}; line-height: 1.3; overflow-wrap: anywhere; }
.js-hist { display: flex; gap: 0.45mm; margin-top: 0.6mm; } .js-hist.dense { gap: 0.25mm; } .js-hist i { flex: 0 1 1.7mm; min-width: 0; height: 3.4mm; display: block; }

.js-sv { display: inline-flex; align-items: center; gap: 1.2mm; }
.js-sbar { height: 1.6mm; background: ${GUIDE.tealMist}; margin-top: 1.2mm; }
.js-sbar i { display: block; height: 100%; background: ${GUIDE.green}; } .js-sbar i.warn { background: ${COLOUR.warning}; } .js-sbar i.crit { background: ${COLOUR.failed}; }

.js-panel { break-inside: auto; }
.js-panel h3 { margin: 5.5mm 0 1mm; color: ${GUIDE.green}; font-weight: 300; font-size: 15pt; line-height: 1.2; break-after: avoid; }
.js-sub { color: ${GUIDE.muted}; font-size: 8pt; margin-bottom: 2mm; }
.js-nb { display: flex; flex-direction: column; gap: 1.2mm; }
.js-nr { display: grid; grid-template-columns: 46mm minmax(0, 1fr) 24mm; gap: 2.6mm; align-items: center; break-inside: avoid; }
.js-nn { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .js-nn.own { font-weight: 650; }
.js-nt { text-align: right; color: ${GUIDE.muted}; white-space: nowrap; }
.js-track { position: relative; height: 3.4mm; background: ${GUIDE.tealMist}; overflow: hidden; }
.js-track i { position: absolute; top: 0; bottom: 0; background: ${GUIDE.teal}; } .js-track i.own { background: ${GUIDE.green}; }
.js-axis { display: flex; justify-content: space-between; color: ${GUIDE.muted}; font-size: 7pt; }
.js-ax { margin-bottom: 0.6mm; }
.js-errs { display: flex; flex-direction: column; } 
.js-er { padding: 1.7mm 2.6mm; border: 0.25mm solid ${GUIDE.rule}; border-top: none; break-inside: avoid; } .js-er:first-child { border-top: 0.25mm solid ${GUIDE.rule}; }
.js-em { color: ${GUIDE.muted}; font-size: 7.8pt; }
.js-chain { border: 0.25mm solid ${GUIDE.rule}; }
.js-ch { display: grid; grid-template-columns: 16mm 20mm 1fr 20mm 20mm; gap: 2.6mm; align-items: center; padding: 1.4mm 2.6mm; border-top: 0.25mm solid ${GUIDE.rule}; } .js-ch:first-child { border-top: none; }
.js-tag { font-size: 7.4pt; padding: 0 1.4mm; background: ${GUIDE.tealMist}; color: ${GUIDE.muted}; justify-self: start; } .js-tag.full { background: ${GUIDE.full}; color: #fff; font-weight: 600; }
.js-cb { height: 2.6mm; background: ${GUIDE.tealMist}; } .js-cb i { display: block; height: 100%; background: ${GUIDE.increment}; } .js-cb i.full { background: ${GUIDE.full}; }
.js-next { color: ${GUIDE.muted}; font-size: 7.8pt; margin-top: 5mm; }
`;
