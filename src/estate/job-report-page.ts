import { escapeHtml as esc } from '../telegram/format';
import { plural } from '../telegram/time';
import { jobTypeWord } from '../telegram/words';
import { calendarLabel, dayLabel, JobReport, JobRun, Outcome, ReportMachine, sizeOf, spanOf } from './job-report';
import { envelope, ReportDocument, stampOf, Status, STATUS_WORD } from './report-envelope';
import { STAGE_NAMES } from './repository-report';
import { SessionReport } from './session-report';
import { SESSION_STYLE, sessionsHtml } from './session-report-page';
import { VEEAM_LOGO } from './veeam-logo';

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
    style: `${STYLE}${SESSION_STYLE}`,
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
const COLOUR = { success: '#00d15f', warning: '#ffb224', failed: '#ff5a5f', none: '#adacaf', empty: '#e9edf0' } as const;

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

// --- The first page
const summary = (report: JobReport, timezone: string, stamp: string): string => `<section class="js">
  ${side(report, timezone, stamp)}
  <div class="js-main">
    <div class="js-verdict ${report.status}">${MARK[report.status]}<span>${esc(report.verdict)}.</span></div>
    ${report.partial ? `<div class="js-partial">Прочитано не всё: ${esc(report.partial.slice(0, 220))}</div>` : ''}
    ${report.pointsUnavailable ? `<div class="js-partial">${esc(report.pointsUnavailable)}</div>` : ''}
    ${numbers(report, timezone, isReplica(report))}
    <div class="js-panel"><div class="js-ph"><h3>Запуски за ${report.days} дней</h3><div class="js-legend"><span><i style="background:${COLOUR.success}"></i>успешно</span><span><i style="background:${COLOUR.warning}"></i>с предупреждением</span><span><i style="background:${COLOUR.failed}"></i>ошибка</span><span><i class="run"></i>идёт</span><span><b>×</b> не было запуска по расписанию</span>${report.usual ? `<span><i class="dash"></i>обычно ${spanOf(report.usual)}</span>` : ''}</div></div>${chart(report, timezone)}</div>
    <div class="js-two">
      <div class="js-panel"><h3>Машины</h3>${machinesTable(report, timezone)}</div>
      <div class="js-col">
        <div class="js-panel"><h3>Что сделать</h3>${stepsTable(report)}</div>
        ${report.neighbours.jobs && report.neighbours.window ? neighboursTable(report, timezone) : report.errors.length ? errorsTable(report, timezone) : chainTable(report)}
      </div>
    </div>
    <div class="js-next"><span>Дальше — каждая сессия за ${report.days} дней, новые сверху: цифры сессии и каждая машина с тем, что Veeam о ней написал.</span><span>1</span></div>
  </div>
</section>`;

/** The dark panel: what the job is, how it is set up, and its last run, repository and Fulls. */
const side = (report: JobReport, timezone: string, stamp: string): string => {
  const total = report.machines.length;
  const { repository } = report;
  const free = repository ? (100 * repository.freeGB) / repository.capacityGB : 0;
  const facts: Array<[string, string | undefined | false]> = [
    ['Тип', `${jobTypeWord(report.type)}${total ? ` · ${total} ${machinesWord(total)}` : ''}`],
    ['Сервер', report.server],
    ['Расписание', report.schedule],
    ['Повторы', report.retry],
    ['Хранение', report.retention],
    ['Full', report.fulls],
  ];
  const last = report.runs.at(-1);
  const cards: string[] = [];
  if (last) {
    const [status, word] = RESULT[last.result];
    cards.push(
      `<div class="js-sc"><div class="js-sk">Последний запуск</div><div class="js-sv">${MARK[status]}<b>${word}</b></div><div class="js-sd">${dayLabel(last.start, timezone)} в ${timeOf(last.start, timezone)} · шёл ${spanOf(last.minutes)}${last.machines ? ` · машин ${last.saved ?? 0} из ${last.machines}` : ''}${last.pieces.length > 1 ? ` · попыток ${last.pieces.length}` : ''}</div></div>`,
    );
  }
  if (repository) {
    cards.push(
      `<div class="js-sc"><div class="js-sk">Репозиторий ${esc(repository.short)}</div><div class="js-sbar"><i class="${free < 10 ? 'crit' : free < 20 ? 'warn' : ''}" style="width:${(100 - free).toFixed(1)}%"></i></div><div class="js-sd"><b>${(repository.freeGB / 1024).toFixed(1).replace('.', ',')} ТБ</b> свободно из ${Math.round(repository.capacityGB / 1024)} ТБ · ${Math.round(free)}%${report.disk ? ` · задание занимает ${sizeOf(report.disk)}` : ''}</div></div>`,
    );
  }
  if (report.lastFull || report.nextFull) {
    cards.push(
      `<div class="js-sc"><div class="js-sk">Полные бэкапы</div><div class="js-s2">${report.lastFull ? `<div><span>последний</span><b>${dayLabel(report.lastFull.at, timezone)}</b><small>${sizeOf(report.lastFull.disk)} на диске</small></div>` : ''}${report.nextFull ? `<div><span>следующий</span><b>${calendarLabel(report.nextFull.day)}</b><small>${report.nextFull.kind === 'synthetic' ? 'Synthetic Full' : 'Active Full'}</small></div>` : ''}</div></div>`,
    );
  }
  return `<div class="js-side">
    <div class="js-brand">${VEEAM_LOGO}<span>Backup &amp; Replication</span></div>
    <div><div class="js-kind">Отчёт по заданию</div><h1>${esc(report.name).replace(/_/g, '_<wbr>')}</h1><div class="js-status">${MARK[report.status]}${STATUS_WORD[report.status]}</div></div>
    <dl class="js-facts">${facts.map(([label, value]) => (value ? `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>` : '')).join('')}</dl>
    <div class="js-cards">${cards.join('')}</div>
    <div class="js-stamp"><span>${esc(report.server)} · за ${report.days} дней</span><span>${stamp}</span></div>
  </div>`;
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
 * The first page's sheet: the dark panel, and cards with a tinted head
 * ------------------------------------------------------------------ */

const STYLE = `
@page { size: 297mm 210mm; margin: 0; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: #fff; }
.js { width: 297mm; height: 210mm; display: flex; overflow: hidden; break-after: page; font-family: 'Inter Variable', 'Segoe UI', sans-serif; font-size: 8.6pt; line-height: 1.35; color: #232323; font-feature-settings: 'tnum' 1; }
.js * { box-sizing: border-box; margin: 0; padding: 0; }
.js b { font-weight: 650; }
.js .nw { white-space: nowrap; } .js .r { text-align: right; }
.js-mk { width: 3.6mm; height: 3.6mm; flex: none; }
.js-bad { color: #e63946; } .js-dim { color: #6b727c; }

.js-side { width: 74mm; flex: none; background: #010d35; color: #d6dbe6; padding: 11mm 8mm 8mm; display: flex; flex-direction: column; gap: 6mm; }
.js-brand { display: flex; align-items: center; gap: 3mm; padding-bottom: 3mm; border-bottom: 0.25mm solid rgba(255, 255, 255, 0.18); font-size: 7.5pt; color: #adb4c6; }
.js-brand .veeam-logo { height: 8.4mm; width: auto; flex: none; }
.js-kind, .js-facts dt, .js-sk { font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #00d15f; }
.js-kind { font-size: 7.5pt; letter-spacing: 0.1em; }
.js-side h1 { font-size: 17pt; font-weight: 650; letter-spacing: -0.01em; color: #fff; line-height: 1.12; margin-top: 1.4mm; overflow-wrap: anywhere; }
.js-status { display: flex; align-items: center; gap: 1.6mm; margin-top: 2.4mm; font-size: 9.6pt; font-weight: 600; color: #fff; }
.js-status .js-mk { width: 4.4mm; height: 4.4mm; }
.js-facts > div { display: grid; grid-template-columns: 24mm 1fr; gap: 2mm; align-items: baseline; padding: 1.3mm 0; border-bottom: 0.25mm solid rgba(255, 255, 255, 0.12); }
.js-facts > div:last-child { border-bottom: none; }
.js-facts dt { font-size: 6.8pt; } .js-facts dd { font-size: 8.6pt; color: #fff; }
.js-cards { margin-top: auto; }
.js-sc { border-top: 0.25mm solid rgba(255, 255, 255, 0.18); padding: 2.4mm 0; }
.js-sk { font-size: 6.8pt; margin-bottom: 0.8mm; }
.js-sv { display: flex; align-items: center; gap: 1.6mm; font-size: 9.6pt; color: #fff; } .js-sv .js-mk { width: 3.8mm; height: 3.8mm; }
.js-sd { font-size: 7.5pt; color: #c3c9d8; line-height: 1.4; } .js-sd b { color: #fff; }
.js-sbar { height: 1.6mm; background: rgba(255, 255, 255, 0.16); margin: 1mm 0 1.2mm; }
.js-sbar i { display: block; height: 100%; background: ${COLOUR.success}; } .js-sbar i.warn { background: ${COLOUR.warning}; } .js-sbar i.crit { background: ${COLOUR.failed}; }
.js-s2 { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm; }
.js-s2 span { display: block; font-size: 7.5pt; color: #a3acc2; } .js-s2 b { display: block; font-size: 12.5pt; color: #fff; line-height: 1.2; } .js-s2 small { font-size: 7.5pt; color: #c3c9d8; }
.js-stamp { display: flex; justify-content: space-between; gap: 2mm; font-size: 7.5pt; color: #a3acc2; padding-top: 2.4mm; border-top: 0.25mm solid rgba(255, 255, 255, 0.18); }

.js-main { flex: 1; min-width: 0; padding: 9mm 10mm 7mm; display: flex; flex-direction: column; gap: 3.2mm; }
.js-verdict { display: flex; align-items: center; gap: 3mm; border-radius: 2.4mm; padding: 3.2mm 4mm; font-size: 12.5pt; font-weight: 650; line-height: 1.25; letter-spacing: -0.005em; background: #f5f7f8; color: #14171c; border: 0.3mm solid #dcdee2; }
.js-verdict .js-mk { width: 6mm; height: 6mm; }
.js-verdict.crit { background: #ff5a5f; border-color: #ff5a5f; color: #fff; } .js-verdict.ok { background: #00d15f; border-color: #00d15f; color: #fff; } .js-verdict.warn { background: #ffb224; border-color: #ffb224; color: #3d2a00; }
.js-verdict.crit .js-mk circle, .js-verdict.ok .js-mk circle { fill: #fff; } .js-verdict.crit .js-mk path { stroke: #ff5a5f; } .js-verdict.ok .js-mk path { stroke: #00d15f; }
.js-verdict.warn .js-mk path:first-child { fill: #3d2a00; } .js-verdict.warn .js-mk path + path { stroke: #ffb224; } .js-verdict.warn .js-mk circle { fill: #ffb224; }
.js-partial { color: #505861; font-size: 7.5pt; margin-top: -1.4mm; padding-left: 4mm; }
.js-tiles { display: grid; grid-template-columns: repeat(5, 1fr); border: 0.3mm solid #dcdee2; border-radius: 2.4mm; padding: 2.8mm 0 2.6mm; }
.js-tile { min-width: 0; padding: 0 3.6mm; border-left: 0.25mm solid #dcdee2; } .js-tile:first-child { border-left: none; }
.js-tk { font-size: 6.8pt; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #505861; }
.js-tv { font-size: 17pt; font-weight: 650; letter-spacing: -0.02em; line-height: 1.2; white-space: nowrap; } .js-tv small { font-size: 8.6pt; font-weight: 400; color: #505861; letter-spacing: 0; }
.js-tile.bad .js-tv { color: #e63946; }
.js-td { font-size: 7.5pt; color: #505861; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.js-panel { border: 0.3mm solid #dcdee2; border-radius: 2.4mm; overflow: hidden; padding: 0 3.6mm 2.6mm; min-width: 0; min-height: 0; }
.js-panel h3 { margin: 0 -3.6mm 2mm; padding: 1.9mm 3.6mm; background: #f5f7f8; border-bottom: 0.25mm solid #dcdee2; font-size: 9.6pt; font-weight: 650; }
.js-ph { display: flex; justify-content: space-between; align-items: center; gap: 4mm; margin: 0 -3.6mm 1.4mm; padding: 1.9mm 3.6mm; background: #f5f7f8; border-bottom: 0.25mm solid #dcdee2; }
.js-ph h3 { margin: 0; padding: 0; background: none; border: none; white-space: nowrap; }
.js-sub { font-size: 7.5pt; color: #505861; margin-bottom: 1.4mm; }
.js-two { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.18fr) minmax(0, 1fr); gap: 3.4mm; }
.js-col { display: flex; flex-direction: column; gap: 3.4mm; min-width: 0; min-height: 0; } .js-col > .js-panel:first-child { flex: none; } .js-col > .js-panel + .js-panel { flex: 1; display: flex; flex-direction: column; }
/* The card under the steps has what room they leave: a row that does not fit wraps into a column out of sight, whole, where it would be cut in half. Contained, so the browser does not shrink the page to print what is out of sight. */
.js-col > .js-panel + .js-panel > .js-nb, .js-col > .js-panel + .js-panel > .js-errs, .js-col > .js-panel + .js-panel > .js-chain { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; flex-wrap: wrap; align-content: flex-start; overflow: hidden; column-gap: 100mm; contain: strict; }
.js-nb > *, .js-errs > *, .js-chain > * { width: 100%; flex: none; }
.js-ax { margin-bottom: 0.6mm; }
.js-chart { width: 100%; height: auto; display: block; font-family: 'Inter Variable', sans-serif; }
.js-chart text { font-size: 13px; fill: #505861; }
.js-chart .g { stroke: #f0f0f0; stroke-width: 1; } .js-chart .a { stroke: #adacaf; stroke-width: 1; }
.js-chart .u { stroke: #3700ff; stroke-width: 1; stroke-dasharray: 5 4; opacity: 0.8; }
.js-chart .m { font-size: 16px; font-weight: 650; fill: #232323; }
.js-legend { display: flex; flex-wrap: wrap; gap: 0.6mm 3.2mm; justify-content: flex-end; font-size: 7.5pt; color: #505861; }
.js-legend span { white-space: nowrap; }
.js-legend i { display: inline-block; width: 2.8mm; height: 2.2mm; margin-right: 1mm; vertical-align: -0.25mm; }
.js-legend i.run { background: #fff; box-shadow: inset 0 0 0 0.3mm ${COLOUR.none}; }
.js-legend i.dash { height: 0; width: 4mm; border-top: 0.3mm dashed #3700ff; vertical-align: 0.7mm; }
.js-legend b { color: #232323; }
.js-vms { width: 100%; border-collapse: collapse; table-layout: fixed; }
.js-vms col.c-n { width: 42%; } .js-vms col.c-s { width: 17mm; } .js-vms col.c-d { width: 15mm; }
.js-vms th { text-align: left; font-size: 6.8pt; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #505861; padding: 0 1.6mm 0.8mm 0; border-bottom: 0.25mm solid #dcdee2; white-space: nowrap; }
.js-vms th.r { text-align: right; }
.js-vms td { padding: 1.4mm 1.6mm 1.4mm 0; vertical-align: middle; font-size: 8.6pt; border-bottom: 0.25mm solid #f0f0f0; }
.js-vms tr:last-child td { border-bottom: none; }
.js-vms tr.js-hasx td { border-bottom: none; padding-bottom: 0.3mm; } .js-vms tr.js-x td { padding: 0 0 1.4mm 4.6mm; }
.js-vms td:last-child, .js-vms th:last-child { padding-right: 0; }
.js-name { display: flex; align-items: flex-start; gap: 1.6mm; font-weight: 600; line-height: 1.2; }
.js-name .js-mk { width: 3mm; height: 3mm; margin-top: 0.3mm; } .js-name > div { flex: 1; min-width: 0; }
.js-name span { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.js-err { font-size: 7.5pt; font-weight: 400; color: #505861; line-height: 1.3; margin-top: 0.3mm; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.js-hist { display: flex; gap: 0.45mm; } .js-hist.dense { gap: 0.25mm; } .js-hist i { flex: 0 1 1.7mm; min-width: 0; height: 3.4mm; border-radius: 0.5mm; display: block; }
.js-more { color: #505861; font-size: 7.5pt; padding-top: 1.2mm; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.js-step { display: flex; gap: 2.2mm; padding: 1.8mm 0; border-bottom: 0.25mm solid #f0f0f0; }
.js-step:first-child { padding-top: 0; } .js-step:last-child { border-bottom: none; padding-bottom: 0; }
.js-step .n { flex: none; width: 4.6mm; height: 4.6mm; border-radius: 50%; background: ${COLOUR.none}; color: #fff; font-weight: 650; font-size: 8.6pt; display: flex; align-items: center; justify-content: center; }
.js-step.crit .n { background: ${COLOUR.failed}; } .js-step.warn .n { background: ${COLOUR.warning}; color: #232323; } .js-step.ok .n { background: ${COLOUR.success}; color: #010d35; }
.js-step b { font-size: 8.6pt; font-weight: 650; line-height: 1.25; display: block; }
.js-step p { font-size: 7.5pt; line-height: 1.4; color: #3a4048; margin-top: 0.5mm; }
.js-tags { display: flex; flex-wrap: wrap; gap: 1mm; margin-top: 0.8mm; } .js-tags span { background: #eef4f6; border-radius: 1mm; padding: 0.2mm 1.8mm; font-size: 7.5pt; }
.js-nb { display: flex; flex-direction: column; gap: 1mm; }
.js-nr { display: grid; grid-template-columns: 31mm minmax(0, 1fr) 18mm; gap: 2mm; align-items: center; font-size: 7.5pt; }
.js-nn { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .js-nn.own { font-weight: 650; }
.js-nt { text-align: right; color: #505861; white-space: nowrap; }
.js-track { position: relative; height: 3.4mm; background: #eef4f6; border-radius: 1mm; overflow: hidden; }
.js-track i { position: absolute; top: 0; bottom: 0; background: ${COLOUR.none}; } .js-track i.own { background: ${COLOUR.success}; }
.js-axis { display: flex; justify-content: space-between; color: #6b727c; font-size: 6.8pt; }
.js-errs { display: flex; flex-direction: column; gap: 1.4mm; }
.js-er { padding-bottom: 1.4mm; border-bottom: 0.25mm solid #f0f0f0; } .js-er:last-child { border-bottom: none; padding-bottom: 0; }
.js-et { font-size: 7.5pt; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
.js-em { font-size: 7.5pt; color: #505861; }
.js-ch { display: grid; grid-template-columns: 11mm 17mm 1fr 15mm 15mm; gap: 2mm; align-items: center; padding: 0.9mm 0; border-bottom: 0.25mm solid #f0f0f0; font-size: 7.5pt; }
.js-ch:last-child { border-bottom: none; }
.js-tag { font-size: 6.8pt; border-radius: 1mm; padding: 0 1.4mm; background: #eef4f6; color: #505861; justify-self: start; } .js-tag.full { background: #010d35; color: #fff; font-weight: 650; }
.js-cb { height: 2.4mm; background: #eef4f6; border-radius: 1mm; overflow: hidden; } .js-cb i { display: block; height: 100%; background: ${COLOUR.success}; } .js-cb i.full { background: #010d35; }
.js-next { display: flex; justify-content: space-between; color: #6b727c; font-size: 7.5pt; margin-top: auto; }
`;
