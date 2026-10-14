import { escapeHtml as esc } from '../telegram/format';
import { plural } from '../telegram/time';
import { calendarLabel, dayLabel, JobReport, ReportMachine, sizeOf, spanOf } from './job-report';
import { JOB_STYLE } from './job-report-style';
import { fonts, glyph, icon, kpi, pill, stampOf, tone } from './repository-report-page';
import { STYLE } from './repository-report-style';

/**
 * The Job report as one HTML document of A4 landscape pages, for the browser
 * to print, in the Repository report's look: an overview with the month of
 * runs, the machines by run, then the chain, the errors, the neighbours on
 * the repository and what to do.
 */
export const jobReportPage = (report: JobReport, timezone: string): string => {
  const stamp = stampOf(report.at, timezone);
  const view: View = { report, timezone, stamp };
  const machinePages: ReportMachine[][] = [];
  for (let from = 0; from < report.machines.length; from += MACHINE_ROWS) machinePages.push(report.machines.slice(from, from + MACHINE_ROWS));
  if (!machinePages.length) machinePages.push([]);
  const bodies = [overview(view), ...machinePages.map((machines, index) => machinesPage(view, machines, index === 0)), storagePage(view)];
  const top = (number: number) =>
    `<div class="top"><div class="crumb"><span class="logo"></span>Задания<em>›</em>${esc(report.server)}<em>›</em><b>${esc(report.name)}</b></div><div>${stamp} · ${report.days} дней · <b>${number}</b> / ${bodies.length}</div></div>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(report.name)} — ${stamp}</title><style>${fonts()}${STYLE}${JOB_STYLE}</style></head><body>${bodies
    .map((body, index) => `<section class="page">${top(index + 1)}${body}</section>`)
    .join('\n')}</body></html>`;
};

interface View {
  report: JobReport;
  timezone: string;
  stamp: string;
}

/** Machines on one page: a row each, about six millimetres. */
const MACHINE_ROWS = 24;
/** Up to this many runs each get their duration above the bar and their date below. */
const LABELLED_RUNS = 16;

const machinesWord = (count: number) => plural(count, 'машина', 'машины', 'машин');
const runsWord = (count: number) => plural(count, 'запуск', 'запуска', 'запусков');

const timeOf = (at: number, timezone: string): string =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: timezone || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
const weekdayOf = (at: number, timezone: string): string =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: timezone || undefined, weekday: 'short' }).format(new Date(at));

// --- Page 1: the job at a glance and its month of runs
const overview = ({ report, timezone }: View): string => {
  const { runs } = report;
  const good = runs.filter((run) => run.result === 'success').length;
  const warned = runs.filter((run) => run.result === 'warning').length;
  const failed = runs.filter((run) => run.result === 'failed').length;
  const never = report.machines.filter((machine) => machine.failing).length;
  const saved = report.machines.filter((machine) => machine.points).length;
  const chips = [
    report.schedule && `<span><b>${esc(report.schedule)}</b></span>`,
    report.retry && `<span>повторы: ${esc(report.retry)}</span>`,
    report.retention && `<span>${esc(report.retention)}</span>`,
    report.fulls && `<span>${esc(report.fulls)}</span>`,
    report.repository && `<span>репозиторий <b>${esc(report.repository.short)}</b></span>`,
  ].filter(Boolean);
  const where = [report.server, report.type, report.machines.length ? `${report.machines.length} ${machinesWord(report.machines.length)}` : '', report.repository?.name].filter(Boolean);
  const ago = report.newestPoint === undefined ? 0 : Math.max(0, Math.floor((report.at - report.newestPoint) / 86_400_000));
  const tiles =
    kpi('Запуски', good + warned, `из ${runs.length}`, `успешно ${good} · предупр. ${warned} · ошибка ${failed}`, runs.length && failed === runs.length ? 'crit' : failed ? 'warn' : '') +
    kpi(
      'Машины сохранены',
      report.machines.length ? saved : '—',
      report.machines.length ? `из ${report.machines.length}` : '',
      !report.machines.length ? 'сервер не отдаёт машины' : never ? `${never} — ни разу за ${report.days} дней` : 'у каждой есть точка',
      never ? 'crit' : '',
    ) +
    kpi(
      'Последняя точка',
      report.newestPoint === undefined ? '—' : dayLabel(report.newestPoint, timezone),
      report.newestPoint === undefined ? '' : timeOf(report.newestPoint, timezone),
      report.newestPoint === undefined
        ? 'точек нет'
        : `${ago} дн. назад${report.depth ? ` · откат на ${report.depth.points} ${plural(report.depth.points, 'точку', 'точки', 'точек')}, до ${dayLabel(report.depth.oldest, timezone)}` : ''}`,
      report.newestPoint === undefined ? 'crit' : '',
    ) +
    kpi(
      'Обычно идёт',
      report.usual ? spanOf(report.usual).replace(/ мин$/, '') : '—',
      report.usual && / мин$/.test(spanOf(report.usual)) ? 'мин' : '',
      report.longest ? `дольше всего ${spanOf(report.longest.minutes)} · ${dayLabel(report.longest.start, timezone)}` : '',
    ) +
    kpi('На диске', report.disk ? sizeOf(report.disk).split(' ')[0] : '—', report.disk ? sizeOf(report.disk).split(' ')[1] : '', report.data && report.disk ? `данных ${sizeOf(report.data)} · сжато в ${(report.data / report.disk).toFixed(1).replace('.', ',')} раза` : '');
  const status = report.status === 'unknown' ? 'ok' : report.status;
  return `
  <div class="rhead jr-head">
    <div>
      <div class="eyebrow">${glyph('pin')} ${where.map((part) => esc(String(part))).join(' · ')}</div>
      <h1>${esc(report.name)}</h1>
      <div class="srv">${chips.join('')}</div>
    </div>
    ${pill(report.status, true)}
  </div>
  <div class="verdict ${tone(report.status)}">${icon(status === 'ok' ? 'check' : 'alert', tone(report.status))}<div>${esc(report.verdict)}</div></div>
  ${report.partial ? `<div class="partial">Прочитано не всё: ${esc(report.partial.slice(0, 220))}</div>` : ''}
  <div class="kpis k5">${tiles}</div>
  <div class="panel grow runs">
    <div class="ph"><div><h3>Запуски за ${report.days} дней</h3><div class="sub">Высота — сколько шёл запуск; нижний кусок — первая попытка, выше — повторы. Под датой — сколько машин сохранено.</div></div>
    <div class="legend"><span><i class="lg-ok"></i>успешно</span><span><i class="lg-meh"></i>предупреждение</span><span><i class="lg-bad"></i>ошибка</span><span><i class="lg-miss"></i>нет запуска по расписанию</span></div></div>
    ${chart(report, timezone)}
  </div>
  ${report.findings.length ? `<div class="probs">${report.findings.slice(0, 3).map((finding) => `<div class="prob ${finding.severity}">${icon(finding.icon, finding.severity)}<div><div class="pt">${esc(finding.title)}</div><div class="pd">${esc(finding.detail)}</div></div></div>`).join('')}</div>` : ''}`;
};

const chart = (report: JobReport, timezone: string): string => {
  const { runs } = report;
  if (!runs.length) return `<div class="chart"><div class="ch-empty">За ${report.days} дней запусков не было</div></div>`;
  const from = report.at - report.days * 86_400_000;
  const x = (at: number) => (100 * (at - from)) / (report.at - from);
  const sorted = runs.map((run) => run.minutes).sort((a, b) => a - b);
  const typical = sorted[Math.floor((sorted.length - 1) / 2)];
  const cap = Math.max(60, Math.ceil((2.5 * typical) / 30) * 30);
  const width = Math.min(2.1, Math.max(0.35, 80 / runs.length));
  const labelled = runs.length <= LABELLED_RUNS;
  const grid = [0, 0.5, 1].map((share) => `<div class="ch-grid" style="bottom:${(share * 100).toFixed(1)}%"><span>${share ? spanOf(cap * share) : '0'}</span></div>`).join('');
  const xs = runs.map((run) => x(run.start));
  const lean = (index: number) => (index > 0 && xs[index] - xs[index - 1] < 4 ? ' right' : index < xs.length - 1 && xs[index + 1] - xs[index] < 4 ? ' left' : '');
  const bars = runs
    .map((run, index) => {
      const over = run.minutes > cap;
      const scale = over ? cap / run.minutes : 1;
      const pieces = run.pieces.map((piece, at) => `<i class="${piece.result}${at ? ' retry' : ''}" style="height:${((100 * piece.minutes * scale) / cap).toFixed(2)}%"></i>`).join('');
      const label = labelled || over
        ? `<div class="ch-lab">${over ? `<b class="crit">${spanOf(run.minutes)}</b>` : spanOf(run.minutes)}${run.pieces.length > 1 ? `<em>↻${run.pieces.length - 1}</em>` : ''}</div>`
        : '';
      const date = labelled
        ? `<div class="ch-d${lean(index)}" style="left:${xs[index].toFixed(2)}%"><b>${dayLabel(run.start, timezone)}</b><span>${weekdayOf(run.start, timezone)} ${timeOf(run.start, timezone)}</span>${run.machines ? `<span class="${(run.saved ?? 0) < run.machines ? 'bad' : ''}">${run.saved}/${run.machines}</span>` : ''}</div>`
        : '';
      return `<div class="ch-col" style="left:${xs[index].toFixed(2)}%;width:${width.toFixed(2)}%"><div class="ch-bar${over ? ' cut' : ''}" style="height:${Math.min(100, (100 * run.minutes) / cap).toFixed(2)}%">${label}${pieces}</div></div>${date}`;
    })
    .join('');
  // Many runs: a date every five days instead of under every bar.
  const ticks = labelled
    ? ''
    : Array.from({ length: Math.floor(report.days / 5) + 1 }, (_, step) => from + step * 5 * 86_400_000)
        .map((at) => `<div class="ch-d" style="left:${x(at).toFixed(2)}%"><b>${dayLabel(at, timezone)}</b></div>`)
        .join('');
  const missed = report.missed
    .map((at) => `<div class="ch-col" style="left:${x(at).toFixed(2)}%;width:${width.toFixed(2)}%"><div class="ch-miss"></div></div>${labelled ? `<div class="ch-d" style="left:${x(at).toFixed(2)}%"><b>${dayLabel(at, timezone)}</b><span>нет запуска</span></div>` : ''}`)
    .join('');
  return `<div class="chart"><div class="ch-plot">${grid}${bars}${missed}${ticks}</div></div>`;
};

// --- Page 2: every machine by run
const machinesPage = ({ report, timezone }: View, machines: ReportMachine[], first: boolean): string => {
  const { history } = report;
  const span = history.from !== undefined && history.to !== undefined ? `${dayLabel(history.from, timezone)} → ${dayLabel(history.to, timezone)}` : '';
  const head = history.byDay ? `по дням: ${span}` : `${history.runs} ${runsWord(history.runs)}${span ? `: ${span}` : ''}`;
  const cells = machines[0]?.history.length ?? 0;
  const historyWidth = Math.max(40, Math.min(84, (history.byDay ? 2.8 : 4.3) * cells + 6));
  const rows = machines
    .map(
      (machine) => `<tr class="${machine.failing ? 'bad' : ''}">
  <td><div class="vm-n"><span>${esc(machine.name)}</span>${machine.size ? `<small>${esc(machine.size)}</small>` : ''}</div></td>
  <td><div class="hist${history.byDay ? ' dense' : ''}">${machine.history.map((outcome) => `<i class="${outcome}"></i>`).join('')}</div></td>
  <td class="r"><b class="${machine.failing ? 'crit' : machine.succeeded < machine.tookPart ? 'warn' : 'ok'}">${machine.succeeded}</b><span class="dim"> / ${machine.tookPart}</span></td>
  <td class="r">${machine.points ? `${machine.points}<span class="dim"> · с ${dayLabel(machine.oldestPoint as number, timezone)}</span>` : '<b class="crit">нет</b>'}</td>
  <td class="r">${machine.lastSaved ? dayLabel(machine.lastSaved, timezone) : '<b class="crit">никогда</b>'}</td>
  <td class="r">${machine.minutes ? spanOf(machine.minutes) : '—'}</td>
  <td class="r">${machine.transferred !== undefined ? sizeOf(machine.transferred) : '—'}</td>
  <td class="err ${machine.errorTone ?? ''}">${machine.error ? `<div class="err-t">${esc(machine.error.slice(0, 110))}${machine.errorTone === 'healed' ? ' <em>· повтор помог</em>' : ''}</div>` : '<span class="dim">—</span>'}</td>
</tr>`,
    )
    .join('');
  const table = machines.length
    ? `<table class="mx vms"><colgroup><col style="width:62mm"><col style="width:${historyWidth.toFixed(0)}mm"><col style="width:17mm"><col style="width:23mm"><col style="width:19mm"><col style="width:15mm"><col style="width:16mm"><col></colgroup>
    <thead><tr><th>Машина</th><th>${head}</th><th class="r">Успешно</th><th class="r">Точек</th><th class="r">Сохранена</th><th class="r">Обычно</th><th class="r">Передано</th><th>Последняя ошибка или предупреждение</th></tr></thead>
    <tbody>${rows}</tbody></table>`
    : `<div class="empty">Сведений по машинам нет: этот сервер их не отдаёт (REST API 1.1), или запусков не было.</div>`;
  return `
  <div class="sect"><div><h2>Машины${first ? '' : ' (продолжение)'}</h2><div class="h2sub">Каждая машина по ${history.byDay ? 'дням' : 'запускам'} за ${report.days} дней, слева направо от старых к новым. Сверху — те, что не сохраняются.</div></div>
  <div class="legend"><span><i class="lg-ok"></i>сохранена</span><span><i class="lg-meh"></i>с предупреждением</span><span><i class="lg-bad"></i>ошибка</span><span><i class="lg-none"></i>не обрабатывалась</span></div></div>
  <div class="panel grow">${table}</div>`;
};

// --- Page 3: the chain, the errors, the neighbours and what to do
const storagePage = ({ report, timezone }: View): string => {
  const { chain, repository, neighbours } = report;
  const biggest = Math.max(1, ...chain.map((day) => day.disk));
  const files = chain.reduce((sum, day) => sum + day.files, 0);
  const free = repository?.capacityGB ? (100 * repository.freeGB) / repository.capacityGB : undefined;
  const position = (at: number) => Math.max(0, Math.min(100, (100 * (at - neighbours.origin)) / 86_400_000));
  const track = (spans: Array<{ start: number; end: number }>, kind: string) =>
    `<div class="track mini">${spans.map(({ start, end }) => `<i class="${kind}" style="left:${position(start).toFixed(2)}%;width:${Math.max(0.6, position(end) - position(start)).toFixed(2)}%"></i>`).join('')}</div>`;
  const hours = [12, 15, 18, 21, 0, 3, 6, 9];
  const window = neighbours.window;
  return `
  <div class="duo jr">
    <div class="panel">
      <h3>${glyph('layers')} Цепочка на диске</h3><div class="sub">${chain.length} ${plural(chain.length, 'день', 'дня', 'дней')} с точками · ${files} ${plural(files, 'файл', 'файла', 'файлов')} · ${sizeOf(report.disk)} на диске</div>
      ${chain.length ? `<div class="orph">${chain
        .slice(0, 9)
        .map((day) => `<div class="or ch"><div class="or-n">${calendarLabel(day.day)} <small>${day.full ? 'Full' : 'инкремент'}</small></div><div class="or-b"><i class="${day.full ? 'full' : ''}" style="width:${((100 * day.disk) / biggest).toFixed(1)}%"></i></div><div class="or-v">${sizeOf(day.disk)}</div><div class="or-d">${day.data ? `из ${sizeOf(day.data)}` : ''}</div></div>`)
        .join('')}</div>${chain.length > 9 ? `<div class="more">и ещё ${chain.length - 9}</div>` : ''}` : '<div class="empty">Файлов бэкапа не найдено.</div>'}
      ${repository ? `<div class="repo"><div><b>${esc(repository.name)}</b><span>${esc(repository.type)}</span></div>${free !== undefined ? `<div class="bar"><span class="b-used" style="width:${(100 - free).toFixed(1)}%"></span><span class="b-free ${free < 10 ? 'crit' : free < 20 ? 'warn' : 'ok'}" style="width:${free.toFixed(1)}%"></span></div><div class="rc-free">свободно <b>${Math.round(free)}%</b> · ${sizeOf(repository.freeGB * 1024 ** 3)} из ${sizeOf(repository.capacityGB * 1024 ** 3)}</div>` : ''}</div>` : ''}
    </div>
    <div class="panel">
      <h3>${glyph('fail')} Ошибки</h3><div class="sub">Что писал Veeam, по смыслу, за ${report.days} дней</div>
      <div class="errs">${
        report.errors
          .slice(0, 5)
          .map(
            (group) =>
              `<div class="er ${group.failed ? 'crit' : 'warn'}"><div class="er-c"><b>${group.machines.length}</b><span>${plural(group.machines.length, 'машина', 'машины', 'машин')}</span></div><div><div class="er-t">${esc(group.text.slice(0, 150))}</div><div class="er-d">${group.runs} ${runsWord(group.runs)} · последний ${dayLabel(group.last, timezone)} · ${esc(group.machines.slice(0, 3).join(', '))}${group.machines.length > 3 ? ` и ещё ${group.machines.length - 3}` : ''}</div></div></div>`,
          )
          .join('') || '<div class="empty">Ошибок не было.</div>'
      }</div>
    </div>
  </div>
  ${
    window && repository
      ? `<div class="panel nb">
    <div class="ph"><div><h3>${glyph('disk')} Кто ещё писал в ${esc(repository.short)} во время запуска ${dayLabel(window.start, timezone)} ${timeOf(window.start, timezone)}–${timeOf(window.end, timezone)}</h3><div class="sub">${neighbours.jobs} ${plural(neighbours.jobs, 'задача', 'задачи', 'задач')} из ${neighbours.of} на этом репозитории · шкала с 12:00 до 12:00${report.bottleneck ? ` · узкое место последних запусков — <b>${esc(report.bottleneck)}</b>` : ''}</div></div></div>
    <div class="nbs">${neighbours.rows
      .map((row) => `<div class="nb-r${row.own ? ' own' : ''}"><div class="g-n">${esc(row.name)}</div>${track(row.spans, row.own ? 't-run good' : 't-max good')}<div class="g-num">${row.spans.map((span) => `${timeOf(span.start, timezone)}–${timeOf(span.end, timezone)}`).join(', ')}</div></div>`)
      .join('')}
    <div class="nb-r"><div></div><div class="g-axis">${hours.map((hour, index) => `<span style="left:${(index * 12.5).toFixed(1)}%">${String(hour).padStart(2, '0')}</span>`).join('')}</div><div></div></div></div>
  </div>`
      : ''
  }
  <div class="sect"><div><h2>Что сделать</h2></div></div>
  <div class="acts">${report.steps
    .slice(0, 4)
    .map(
      (step, index) =>
        `<div class="act ${step.severity}"><span class="a-n">${index + 1}</span><div><div class="a-t">${esc(step.title)}</div><div class="a-x">${esc(step.detail)}</div>${step.tags.length ? `<div class="a-p">${step.tags.map((tag) => `<span>${esc(tag)}</span>`).join('')}</div>` : ''}</div></div>`,
    )
    .join('')}</div>`;
};
