import { escapeHtml as esc } from '../telegram/format';
import { plural } from '../telegram/time';
import { envelope, ReportDocument, stampOf, Status, STATUS_WORD } from './report-envelope';
import { STYLE } from './repository-report-style';
import { Stage } from './run-speed';
import {
  Attachment,
  dayName,
  hhmm,
  hours,
  Icon,
  localClock,
  num,
  ReportRepository,
  RepositoryReport,
  shortOf,
  STAGE_NAMES,
  tb,
  tbOfGB,
  WEEK,
  Writer,
} from './repository-report';

/**
 * The Repository report as one HTML document of A4 landscape pages, for the
 * browser to print. Every page is laid out here, to the page: a page that
 * does not fit is split by rows, never by the browser, which would cut a
 * table in half wherever the paper ended.
 *
 * The whole report opens on a cover — what burns, what to do first, where a
 * new job fits — then every repository as a card and which server attaches
 * what; each repository then gets a dashboard page, its jobs on a 24-hour
 * chart and what to do. Asked for one repository, only its own pages.
 */
export const reportPage = (report: RepositoryReport, only: ReportRepository[] | undefined, timezone: string): ReportDocument => {
  const stamp = stampOf(report.at, timezone);
  const nowMinute = localClock(timezone)(report.at).minute;
  const view = { report, stamp, nowMinute };
  const chosen = only ?? report.repositories;
  const sections = chosen.map((repository) => ({
    repository,
    pages: [overviewPage(repository, view), ...chartPages(repository, view), ...actionPages(repository)],
  }));
  const front = only ? 0 : 3;
  const pageOf = new Map<ReportRepository, number>();
  let next = front + 1;
  for (const { repository, pages } of sections) {
    pageOf.set(repository, next);
    next += pages.length;
  }
  const total = next - 1;
  const frame = (crumb: string[], number: number, body: string) => `<section class="page">${top(crumb, number, total, view)}${body}</section>`;
  const pages = only
    ? []
    : [cover(view), frame(['Репозитории', 'Все хранилища'], 2, cards(view, pageOf)), frame(['Репозитории', 'Подключения'], 3, attachments(view))];
  for (const { repository, pages: own } of sections) {
    own.forEach((body, index) =>
      pages.push(frame(['Репозитории', ...(repository.site ? [repository.site] : []), repository.short], (pageOf.get(repository) as number) + index, body)),
    );
  }
  return envelope({ lang: 'ru', title: `Репозитории Veeam — ${stamp}`, style: STYLE, body: pages.join('\n') });
};

interface View {
  report: RepositoryReport;
  stamp: string;
  nowMinute: number;
}

// --- Words
/** The stylesheet's name for a status. */
const tone = (status: Status | 'unknown'): string => (status === 'unknown' ? 'unk' : status);
const pill = (status: Status, big = false) => `<span class="pill ${tone(status)}${big ? ' big' : ''}"><i></i>${STATUS_WORD[status]}</span>`;
const freeTone = (repository: ReportRepository): string => (repository.freePercent < 10 ? 'crit' : repository.freePercent < 20 ? 'warn' : 'ok');
const slug = (repository: ReportRepository): string => `r-${repository.short.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
const jobsWord = (count: number) => plural(count, 'задача', 'задачи', 'задач');
const backupsWord = (count: number) => plural(count, 'бэкап', 'бэкапа', 'бэкапов');
const storagesWord = (count: number) => plural(count, 'хранилище', 'хранилища', 'хранилищ');
const dateOf = (iso: string | undefined): string => (iso ? iso.slice(0, 10).split('-').reverse().join('.') : '—');
const NOTABLE_BYTES = 0.05 * 1024 ** 4;
const BOTTLENECK: Record<Stage, string> = {
  source: 'чтение с продуктива',
  proxy: 'обработка на прокси',
  network: 'сеть',
  target: 'запись в хранилище',
};

// --- Icons: 16×16, drawn in the current colour
const ICONS: Record<Icon | 'check' | 'alert' | 'arrow' | 'down' | 'pin', string> = {
  disk: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M2 9h12"/><path d="M11 11h.01"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
  fail: '<circle cx="8" cy="8" r="6"/><path d="M6 6l4 4M10 6l-4 4"/>',
  layers: '<path d="M8 2l6 3-6 3-6-3z"/><path d="M2 8l6 3 6-3"/><path d="M2 11l6 3 6-3"/>',
  target: '<path d="M8 2v7"/><path d="M5 6l3 3 3-3"/><path d="M2 10v3h12v-3"/>',
  box: '<path d="M2 5l6-3 6 3v6l-6 3-6-3z"/><path d="M2 5l6 3 6-3M8 8v6"/>',
  link: '<rect x="2" y="2" width="12" height="5" rx="1.3"/><rect x="2" y="9" width="12" height="5" rx="1.3"/><path d="M5 4.5h.01M5 11.5h.01"/>',
  gear: '<path d="M3 4h10M3 8h10M3 12h10"/><circle cx="6" cy="4" r="1.3"/><circle cx="10.5" cy="8" r="1.3"/><circle cx="5" cy="12" r="1.3"/>',
  question: '<circle cx="8" cy="8" r="6"/><path d="M6.3 6.4a1.8 1.8 0 1 1 2.5 1.6c-.5.3-.8.6-.8 1.2"/><path d="M8 11.3h.01"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  alert: '<path d="M8 2.2l6.2 11H1.8z"/><path d="M8 6.5v3M8 11.4h.01"/>',
  arrow: '<path d="M3 8h10M9 4l4 4-4 4"/>',
  down: '<path d="M8 3v10M4 9l4 4 4-4"/>',
  pin: '<path d="M8 14s5-4.2 5-8A5 5 0 0 0 3 6c0 3.8 5 8 5 8z"/><circle cx="8" cy="6" r="1.6"/>',
};
const icon = (name: keyof typeof ICONS, colour = '') =>
  `<span class="ic ${colour}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg></span>`;
const glyph = (name: keyof typeof ICONS) =>
  `<svg class="gl" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

// --- Space: what jobs hold, what no job owns in disk terms, what is free
const space = (repository: ReportRepository) => {
  const capacity = repository.capacityGB * 1024 ** 3;
  const free = repository.freeGB * 1024 ** 3;
  const used = Math.max(0, capacity - free);
  // The files no job owns, as a share of what the disk holds: an array that
  // deduplicates stores more file bytes than it has disk.
  const orphan = repository.allBytes ? Math.min(used, used * (repository.orphanBytes / repository.allBytes)) : 0;
  return { capacity, free, used, orphan, owned: used - orphan, squeezed: repository.allBytes > 1.1 * used };
};
const bar = (repository: ReportRepository): string => {
  const { capacity, free, orphan, owned } = space(repository);
  const share = (bytes: number) => (capacity ? ((100 * bytes) / capacity).toFixed(2) : '0');
  return `<div class="bar"><span class="b-used" style="width:${share(owned)}%"></span>${orphan ? `<span class="b-orph" style="width:${share(orphan)}%"></span>` : ''}<span class="b-free ${freeTone(repository)}" style="width:${share(free)}%"></span></div>`;
};
const donut = (repository: ReportRepository): string => {
  const { capacity, free, orphan, owned } = space(repository);
  const radius = 15.9155;
  let at = 0;
  const arcs = ([[owned, 'var(--used)'], [orphan, 'var(--orph)'], [free, `var(--${freeTone(repository)})`]] as Array<[number, string]>)
    .filter(([bytes]) => bytes > 0 && capacity > 0)
    .map(([bytes, colour]) => {
      const share = (100 * bytes) / capacity;
      const arc = `<circle r="${radius}" cx="21" cy="21" fill="none" stroke="${colour}" stroke-width="5.2" stroke-dasharray="${Math.max(0.3, share - 0.7).toFixed(2)} ${(100 - share + 0.7).toFixed(2)}" stroke-dashoffset="${(25 - at).toFixed(2)}"/>`;
      at += share;
      return arc;
    })
    .join('');
  return `<svg class="donut" viewBox="0 0 42 42"><circle r="${radius}" cx="21" cy="21" fill="none" stroke="#EEF2F7" stroke-width="5.2"/>${arcs}<text x="21" y="22" text-anchor="middle" class="d-v">${Math.round(repository.freePercent)}%</text><text x="21" y="27.4" text-anchor="middle" class="d-l">свободно</text></svg>`;
};

// --- Load hour by hour: calm blue, busy amber, overload red
const HEAT: Array<[string, string]> = [
  ['#F1F5F9', 'transparent'],
  ['#E0E7FF', '#3730A3'],
  ['#C7D2FE', '#312E81'],
  ['#A5B4FC', '#1E1B4B'],
  ['#FDE68A', '#78350F'],
  ['#FCD34D', '#78350F'],
  ['#FB923C', '#FFFFFF'],
  ['#FB923C', '#FFFFFF'],
  ['#F43F5E', '#FFFFFF'],
  ['#F43F5E', '#FFFFFF'],
  ['#9F1239', '#FFFFFF'],
];
const heatOf = (count: number): [string, string] => HEAT[Math.min(HEAT.length - 1, count)];
const inWindow = (hour: number) => hour >= 18 || hour < 7;
const heatScale = () =>
  `<div class="scale"><span>спокойно</span>${[1, 2, 3, 4, 5, 6, 8, 10].map((count) => `<i style="background:${heatOf(count)[0]}"></i>`).join('')}<span>перегруз</span></div>`;
const heatmap = (repository: ReportRepository): string =>
  `<div class="heat"><div></div>${Array.from({ length: 24 }, (_, hour) => `<div class="hh${inWindow(hour) ? ' win' : ''}">${String(hour).padStart(2, '0')}</div>`).join('')}${repository.heat
    .map(
      (row, index) =>
        `<div class="hd">${dayName(WEEK[index])}</div>${row
          .map((count) => {
            const [background, colour] = heatOf(count);
            return `<div class="hc${count === repository.peak && count ? ' peak' : ''}" style="background:${background};color:${colour}">${count || ''}</div>`;
          })
          .join('')}`,
    )
    .join('')}</div>`;

// --- A job on 24 hours: its usual run solid, its longest pale, what runs now hatched
const share = (minute: number) => ((100 * minute) / 1440).toFixed(3);
const pieces = (start: number, length: number): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  let from = ((start % 1440) + 1440) % 1440;
  let left = Math.min(length, 1440);
  while (left > 0) {
    const part = Math.min(left, 1440 - from);
    out.push([from, part]);
    left -= part;
    from = 0;
  }
  return out;
};
const health = (writer: Writer): string =>
  writer.hanging || (writer.runs.length >= 3 && writer.failed / writer.runs.length >= 0.5) ? 'bad' : writer.failed ? 'meh' : 'good';
const bars = (className: string, start: number, length: number) =>
  pieces(start, length).map(([from, part]) => `<i class="${className}" style="left:${share(from)}%;width:${share(part)}%"></i>`).join('');
const track = (writer: Writer, nowMinute: number): string => {
  const kind = health(writer);
  const starts = writer.plan.starts.length ? writer.plan.starts : writer.startMinute !== undefined ? [writer.startMinute] : [];
  let html = '';
  for (const start of starts) {
    if (writer.longestHours) html += bars(`t-max ${kind}`, start, writer.longestHours * 60);
    html += bars(`t-run ${kind}`, start, Math.max(12, (writer.usualHours ?? 0.15) * 60));
  }
  if (writer.running) html += bars(`t-live${writer.hanging ? ' hang' : ''}`, writer.running.sinceMinute, Math.min(1440, writer.running.hours * 60));
  return `<div class="track">${html}<b class="t-now" style="left:${share(nowMinute)}%"></b></div>`;
};
const axis = (nowMinute: number) =>
  `<div class="g-axis">${[0, 3, 6, 9, 12, 15, 18, 21].map((hour) => `<span style="left:${share(hour * 60)}%">${String(hour).padStart(2, '0')}</span>`).join('')}<em style="left:${share(nowMinute)}%">сейчас</em></div>`;

// --- Small parts
const kpi = (label: string, value: string | number, unit: string, hint: string, colour = '') =>
  `<div class="kpi ${colour}"><div class="k-l">${label}</div><div class="k-v">${value}<small>${unit}</small></div><div class="k-h">${hint}</div></div>`;
const chip = (colour: string, text: string) => `<span class="chip ${colour}">${text}</span>`;
const top = (crumb: string[], number: number, total: number, view: View) =>
  `<div class="top"><div class="crumb"><span class="logo"></span>${crumb.map((part, index) => (index === crumb.length - 1 ? `<b>${esc(part)}</b>` : esc(part))).join('<em>›</em>')}</div><div>${view.stamp} · ${view.report.days} дней · <b>${number}</b> / ${total}</div></div>`;
const section = (title: string, sub: string, aside = '') => `<div class="sect"><div><h2>${title}</h2>${sub ? `<div class="h2sub">${sub}</div>` : ''}</div>${aside}</div>`;

// --- A repository's dashboard
const overviewPage = (repository: ReportRepository, view: View): string => {
  const { owned, orphan, used, squeezed } = space(repository);
  const tiles = repository.unknown
    ? kpi('Задач пишет', '?', '', 'сервер не ответил') + kpi('Пик одновременно', '?', '', 'нет данных') + kpi('Узкое место', '?', '', 'нет данных') + kpi('Проблемные задачи', '?', '', 'нет данных')
    : kpi('Задач пишет', repository.active.length, jobsWord(repository.active.length), `${repository.servers.length} ${plural(repository.servers.length, 'сервер', 'сервера', 'серверов')} · ещё ${repository.writers.length - repository.active.length} выкл.`) +
      kpi('Пик одновременно', repository.peak, jobsWord(repository.peak), repository.peakAt ? `${repository.peakAt} · по плану ${repository.plannedBefore}` : 'нет запусков', repository.peak >= 10 ? 'crit' : repository.peak >= 6 ? 'warn' : '') +
      kpi(
        'Узкое место',
        repository.mainBottleneck ? STAGE_NAMES[repository.mainBottleneck] : '—',
        '',
        repository.mainBottleneck ? `у ${repository.spread[0][1]} из ${repository.measured} задач · ${BOTTLENECK[repository.mainBottleneck]}` : 'нет данных о нагрузке',
        repository.mainBottleneck === 'target' ? 'warn' : '',
      ) +
      kpi('Проблемные задачи', repository.hanging.length + repository.failing.length, '', `висят ${repository.hanging.length} · часто падают ${repository.failing.length}`, repository.hanging.length ? 'crit' : repository.failing.length ? 'warn' : '');
  const spread = repository.spread.length
    ? `<div class="panel spread"><div class="sp-h"><b>Где тормозит</b> — главное узкое место каждой задачи по её последним запускам</div><div class="sp-bar">${repository.spread
        .map(([stage, count]) => `<span class="sp-${STAGE_NAMES[stage]}" style="flex:${count} 0 auto">${STAGE_NAMES[stage]} · ${count}</span>`)
        .join('')}</div><div class="sp-n">Source — ${BOTTLENECK.source}; Proxy — ${BOTTLENECK.proxy}; Network — ${BOTTLENECK.network}; Target — ${BOTTLENECK.target}. Чем больше Target, тем сильнее хранилище — бутылочное горлышко.</div></div>`
    : '';
  const plain = repository.name.split(' · ')[0];
  const where = [repository.site, repository.type, repository.path].filter(Boolean).map(esc).join(' · ');
  return `
  <div class="rhead">
    <div>
      <div class="eyebrow">${glyph('pin')} ${where}</div>
      <h1 id="${slug(repository)}">${esc(repository.short)}<span>${esc(plain)}</span></h1>
      <div class="srv">${repository.members
        .map((member) => `<span class="${member.answered ? '' : 'off'}"><b>${esc(member.server)}</b>${member.repository !== plain ? ` · ${esc(member.repository)}` : ''}${member.answered ? '' : ' · не ответил'}</span>`)
        .join('')}</div>
    </div>
    ${pill(repository.status, true)}
  </div>
  <div class="verdict ${tone(repository.status)}">${icon(repository.status === 'ok' ? 'check' : repository.status === 'unknown' ? 'question' : 'alert', tone(repository.status))}<div>${esc(repository.verdict)}</div></div>
  <div class="rowA">
    <div class="panel cap">
      ${donut(repository)}
      <div class="lg">
        <div><i style="background:var(--used)"></i><span>${repository.unknown ? 'Занято' : 'Бэкапы задач'}</span><b>${tb(owned)} ТБ</b></div>
        ${orphan > NOTABLE_BYTES ? `<div><i style="background:var(--orph)"></i><span>Без задачи<small>можно освободить</small></span><b>≈ ${tb(orphan)} ТБ</b></div>` : ''}
        <div><i style="background:var(--${freeTone(repository)})"></i><span>Свободно</span><b>${tbOfGB(repository.freeGB)} ТБ</b></div>
        <div class="lg-tot"><span>Всего</span><b>${tbOfGB(repository.capacityGB)} ТБ</b></div>
        ${squeezed ? `<p>Файлов ${tb(repository.allBytes)} ТБ лежит на ${tb(used)} ТБ диска — массив сжимает. «Без задачи» пересчитано в место на диске.</p>` : ''}
      </div>
    </div>
    <div class="rcol">
      <div class="kpis">${tiles}</div>
      ${spread}
    </div>
  </div>
  ${repository.problems.length ? `<div class="probs${repository.problems.length > 6 ? ' tight' : ''}">${repository.problems.map((problem) => `<div class="prob ${tone(problem.severity)}">${icon(problem.icon, tone(problem.severity))}<div><div class="pt">${esc(problem.title)}</div><div class="pd">${esc(problem.detail)}</div></div></div>`).join('')}</div>` : ''}
  ${
    repository.unknown
      ? `${section('Что сделать', '')}${actionCards(repository)}`
      : `<div class="panel heatp grow">
    <div class="ph"><div><h3>Нагрузка по часам</h3><div class="sub">Сколько задач пишут одновременно — максимум за ${view.report.days} дней. Фиолетовые часы — окно бэкапов 18:00–07:00.</div></div>${heatScale()}</div>
    ${heatmap(repository)}
  </div>`
  }`;
};

// --- Its jobs on 24 hours
const FIRST_ROWS = 20;
const MORE_ROWS = 23;

const chartPages = (repository: ReportRepository, view: View): string[] => {
  const rows = repository.active.filter((writer) => writer.runs.length || writer.running).sort((a, b) => (a.startMinute ?? 9999) - (b.startMinute ?? 9999));
  const idle = repository.active.filter((writer) => !writer.runs.length && !writer.running);
  const off = repository.writers.filter((writer) => writer.disabled);
  const errors = (writer: Writer) => {
    if (!writer.runs.length) return '<span class="dim">—</span>';
    const bad = writer.runs.length >= 3 && writer.failed / writer.runs.length >= 0.5;
    return chip(bad ? 'crit' : writer.failed ? 'warn' : 'ok', `${writer.failed} из ${writer.runs.length}`);
  };
  const bottleneck = (writer: Writer) => {
    if (!writer.bottleneck) return '<span class="dim">—</span>';
    const said = `${STAGE_NAMES[writer.bottleneck.stage]} ${writer.bottleneck.percent}%`;
    return writer.bottleneck.stage === 'target' && writer.bottleneck.percent >= 80 ? chip('warn', said) : `<span class="bn">${said}</span>`;
  };
  const row = (writer: Writer) => `<div class="g-row">
    <div class="g-start">${writer.plan.time ?? (writer.startMinute !== undefined ? hhmm(writer.startMinute) : '—')}</div>
    <div class="g-name"><div class="g-n">${esc(writer.name)}</div><div class="g-s">${esc(writer.server)} · ${esc(writer.plan.label)}${writer.role === 'metadata' ? ' · метаданные реплик' : ''}</div></div>
    ${track(writer, view.nowMinute)}
    <div class="g-num">${hours(writer.usualHours)}</div>
    <div class="g-num${(writer.longestHours ?? 0) > 6 ? ' hot' : ''}">${hours(writer.longestHours)}</div>
    <div class="g-c">${errors(writer)}</div>
    <div class="g-c">${bottleneck(writer)}</div>
    <div class="g-c">${writer.running ? chip(writer.hanging ? 'crit' : 'run', `идёт ${hours(writer.running.hours)}`) : ''}</div>
  </div>`;
  const head = `<div class="g-row g-head"><div>Старт</div><div>Задача</div>${axis(view.nowMinute)}<div class="r">Обычно</div><div class="r">Макс</div><div>Ошибки</div><div>Узкое место</div><div>Сейчас</div></div>`;
  const legend = `<div class="legend"><span><i class="lg-run"></i>обычный прогон</span><span><i class="lg-max"></i>самый долгий за ${view.report.days} дней</span><span><i class="lg-meh"></i>бывают ошибки</span><span><i class="lg-bad"></i>падает или висит</span><span><i class="lg-live"></i>идёт сейчас</span><span><i class="lg-win"></i>окно бэкапов</span><span><i class="lg-now"></i>сейчас, ${hhmm(view.nowMinute)}</span></div>`;
  const notes = [
    idle.length ? `<div><b>Без запусков за ${view.report.days} дней:</b> ${idle.map((writer) => esc(writer.name)).join(', ')}</div>` : '',
    off.length ? `<div><b>Выключены:</b> ${off.map((writer) => esc(writer.name)).join(', ')}</div>` : '',
  ].join('');
  if (!rows.length && !notes) return [];
  const chunks: Writer[][] = [];
  for (let from = 0; from < rows.length; ) {
    const size = chunks.length ? MORE_ROWS : FIRST_ROWS;
    chunks.push(rows.slice(from, from + size));
    from += size;
  }
  if (!chunks.length) chunks.push([]);
  const sub = `${rows.length} ${plural(rows.length, 'задача запускалась', 'задачи запускались', 'задач запускались')} за ${view.report.days} дней · время по часам сервера Veeam`;
  return chunks.map(
    (chunk, index) => `
    ${section(index ? 'Кто пишет и когда — продолжение' : 'Кто пишет и когда', sub, index ? '' : legend)}
    <div class="gantt">${head}${chunk.map(row).join('')}</div>
    ${index === chunks.length - 1 && notes ? `<div class="notes">${notes}</div>` : ''}`,
  );
};

// --- What to do
const actionCards = (repository: ReportRepository): string =>
  `<div class="acts">${repository.actions
    .map(
      (action, index) =>
        `<div class="act ${action.severity}"><div class="a-n">${index + 1}</div><div class="a-b"><div class="a-t">${esc(action.what)}</div><div class="a-f"><div class="a-p">${action.where
          .map((step) => `<span>${esc(step)}</span>`)
          .join('<em>›</em>')}</div><div class="a-e">${glyph('down')}${esc(action.effect)}</div></div></div></div>`,
    )
    .join('')}</div>`;

const movesPanel = (repository: ReportRepository): string => {
  const row = (move: ReportRepository['moves'][number]) => `<div class="mv">
    <div class="mv-n"><div class="g-n">${esc(move.writer.name)}</div><div class="g-s">${esc(move.writer.server)} · прогон ~${hours(move.minutes / 60)}</div></div>
    <div class="track mini">${bars('t-old', move.fromMinute, move.minutes)}${bars('t-new', move.toMinute, move.minutes)}</div>
    <div class="mv-x"><s>${move.from}</s> ${glyph('arrow')} <b>${move.to}</b></div>
    <div class="mv-e">${chip('ok', `пик ${move.before} → ${move.after}`)}</div>
  </div>`;
  return `<div class="panel"><h3>${glyph('clock')} Перенести старт</h3><div class="sub">Серым — сейчас, фиолетовым — куда перенести. Весь прогон остаётся в окне 18:00–07:00. Пик по расписанию: ${repository.plannedBefore} → ${repository.plannedAfter}.</div><div class="mvs">${repository.moves.map(row).join('')}</div></div>`;
};

const SHOWN_ORPHANS = 10;
const orphansPanel = (repository: ReportRepository): string => {
  const list = repository.orphans.slice(0, SHOWN_ORPHANS);
  const biggest = Math.max(1, ...list.map((backup) => backup.size));
  const rest = repository.orphans.slice(SHOWN_ORPHANS);
  return `<div class="panel"><h3>${glyph('box')} Бэкапы без задачи${repository.orphanBytes > NOTABLE_BYTES ? ` — ${tb(repository.orphanBytes)} ТБ` : ''}</h3><div class="sub">${repository.orphans.length} ${backupsWord(repository.orphans.length)}, ни одна задача ни на одном сервере их не ведёт. Перед удалением — уточнить у владельцев.</div>
    <div class="orph">${list
      .map(
        (backup) =>
          `<div class="or"><div class="or-n">${esc(backup.name)}<small>${esc(backup.platform ?? '')}</small></div><div class="or-b">${backup.size ? `<i style="width:${((100 * backup.size) / biggest).toFixed(1)}%"></i>` : ''}</div><div class="or-v">${backup.size ? `${tb(backup.size)} ТБ` : '<span class="dim">не прочитан</span>'}</div><div class="or-d">${dateOf(backup.newest)}</div></div>`,
      )
      .join('')}</div>
    ${rest.length ? `<div class="more">И ещё ${rest.length} ${backupsWord(rest.length)} поменьше — ${tb(rest.reduce((sum, backup) => sum + backup.size, 0))} ТБ.</div>` : ''}</div>`;
};

/** Millimetres the action cards and the panels under them take, to tell whether they share a page. */
const PAGE_ROOM_MM = 175;
const actionPages = (repository: ReportRepository): string[] => {
  if (repository.unknown || (!repository.actions.length && !repository.moves.length && !repository.orphans.length)) return [];
  const actions = `${section('Что сделать', 'По порядку: красное — сначала. Зелёным — что это даст.')}${actionCards(repository)}`;
  const panels = [repository.moves.length ? movesPanel(repository) : '', repository.orphans.length ? orphansPanel(repository) : ''].filter(Boolean);
  const below = panels.length ? `<div class="duo${panels.length === 1 ? ' one' : ''}">${panels.join('')}</div>` : '';
  const actionsTall = 16 + 17 * Math.ceil(repository.actions.length / 2);
  const panelsTall = Math.max(
    repository.moves.length ? 24 + 7.5 * repository.moves.length : 0,
    repository.orphans.length ? 26 + 5.6 * Math.min(SHOWN_ORPHANS, repository.orphans.length) : 0,
  );
  return actionsTall + panelsTall > PAGE_ROOM_MM && below ? [actions, below] : [actions + below];
};

// --- The cover
const cover = (view: View): string => {
  const { report } = view;
  const all = report.repositories;
  const capacity = all.reduce((sum, repository) => sum + repository.capacityGB, 0);
  const free = all.reduce((sum, repository) => sum + repository.freeGB, 0);
  const orphaned = all.reduce((sum, repository) => sum + repository.orphanBytes, 0);
  const named = report.sites.filter((site) => site.name);
  const silent = report.servers.filter((server) => !server.answered).map((server) => esc(server.name));
  const percent = (part: number, whole: number) => (whole ? Math.round((100 * part) / whole) : 0);
  const bySite = (each: (site: (typeof report.sites)[number]) => string) => (named.length ? report.sites.map(each).join(' · ') : '');
  const statuses = (['crit', 'warn', 'ok', 'unknown'] as const).map((status) => [status, all.filter((repository) => repository.status === status).length] as const).filter(([, count]) => count);
  const hot = all.filter((repository) => repository.status === 'crit' || repository.status === 'unknown').sort((a, b) => b.score - a.score);
  const recommendations = report.sites.map((site) => {
    const label = `<div class="rec-s">${glyph('pin')} ${esc(site.name || 'Все хранилища')}</div>`;
    const fits = site.repositories.filter((repository) => repository.fit !== undefined).sort((a, b) => (b.fit as number) - (a.fit as number));
    if (!fits.length) return `<div class="rec none">${label}<div class="rec-x">Хорошего варианта нет — сначала освободить место или разгрузить пики.</div></div>`;
    const [best, next] = fits;
    const why = [
      `свободно ${Math.round(best.freePercent)}%`,
      `пик ${best.peak}`,
      best.mainBottleneck ? `тормозит ${STAGE_NAMES[best.mainBottleneck]}` : undefined,
      best.failing.length ? `падают ${best.failing.length}` : undefined,
    ].filter((reason): reason is string => Boolean(reason));
    return `<div class="rec">${label}<div class="rec-n">${esc(best.short)}</div><div class="rec-w">${why.map((reason) => `<span>${reason}</span>`).join('')}</div>${next ? `<div class="rec-2">Запасной: ${esc(next.short)}</div>` : ''}</div>`;
  });
  return `<section class="page cover">
    <div class="hero">
      <div class="eyebrow"><span><span class="logo"></span>VEEAM · РЕПОЗИТОРИИ</span><span>${view.stamp}</span></div>
      <h1>Состояние репозиториев</h1>
      <p class="lead">За ${report.days} дней: ${report.servers.length} ${plural(report.servers.length, 'сервер', 'сервера', 'серверов')} Veeam, ${all.length} ${storagesWord(all.length)}${named.length > 1 ? ` на ${named.length} площадках` : ''}.${silent.length ? ` Не ${silent.length === 1 ? 'ответил' : 'ответили'}: ${silent.join(', ')}.` : ''}</p>
      <div class="hk-row">
        <div class="hk"><div class="hk-l">Хранилищ</div><div class="hk-v">${all.length}</div><div class="hk-h">${bySite((site) => `${esc(site.name)} ${site.repositories.length}`)}</div></div>
        <div class="hk"><div class="hk-l">Ёмкость</div><div class="hk-v">${Math.round(capacity / 1024)}<small>ТБ</small></div><div class="hk-h">${bySite((site) => `${esc(site.name)} ${Math.round(site.repositories.reduce((sum, repository) => sum + repository.capacityGB, 0) / 1024)}`)}</div></div>
        <div class="hk"><div class="hk-l">Свободно</div><div class="hk-v">${Math.round(free / 1024)}<small>ТБ · ${percent(free, capacity)}%</small></div><div class="hk-h">${bySite((site) => `${esc(site.name)} ${percent(site.repositories.reduce((sum, repository) => sum + repository.freeGB, 0), site.repositories.reduce((sum, repository) => sum + repository.capacityGB, 0))}%`)}</div></div>
        <div class="hk"><div class="hk-l">Без задачи</div><div class="hk-v">${Math.round(orphaned / 1024 ** 4)}<small>ТБ</small></div><div class="hk-h">размер файлов · можно освободить после проверки</div></div>
      </div>
    </div>
    <div class="strip">${statuses.map(([status, count]) => `<div class="seg ${tone(status)}" style="flex:${count}"><b>${count}</b> ${STATUS_WORD[status].toLowerCase()}</div>`).join('')}</div>
    <div class="cols3">
      <div class="panel"><h3>${glyph('alert')} Горит</h3><div class="sub">Хранилища, где нужны действия сейчас</div>
        <div class="hot">${
          hot.length
            ? hot
                .map(
                  (repository) =>
                    `<a class="hot-r" href="#${slug(repository)}"><div class="hr-n">${esc(repository.short)}</div><div class="hr-d">${repository.problems
                      .filter((problem) => problem.severity !== 'warn')
                      .map((problem) => esc(problem.title))
                      .join(' · ')}</div>${pill(repository.status)}</a>`,
                )
                .join('')
            : '<div class="empty">Критичных нет.</div>'
        }</div>
        <div class="fill"><div class="fill-h">Свободно по хранилищам</div>${[...all]
          .sort((a, b) => a.freePercent - b.freePercent)
          .map((repository) => `<div class="fl"><span>${esc(repository.short)}</span><div class="fl-b"><i class="${freeTone(repository)}" style="width:${repository.freePercent.toFixed(1)}%"></i></div><b class="${freeTone(repository)}">${Math.round(repository.freePercent)}%</b></div>`)
          .join('')}</div>
      </div>
      <div class="panel"><h3>${glyph('check')} Сделать в первую очередь</h3><div class="sub">По всем хранилищам сразу</div>
        <div class="first">${report.first
          .map((thing, index) => `<div class="fi ${thing.severity}"><div class="a-n">${index + 1}</div><div><div class="fi-t">${esc(thing.title)}</div><div class="fi-d">${esc(thing.detail)}</div></div></div>`)
          .join('')}</div>
      </div>
      <div class="panel accent"><h3>${glyph('arrow')} Куда ставить новую задачу</h3><div class="sub">Место, тихие часы и запись не узкое место.${named.length > 1 ? ' Хранилище — на той же площадке, что и машины.' : ''}</div>
        <div class="recs">${recommendations.join('')}</div>
      </div>
    </div>
  </section>`;
};

// --- Every repository as a card
const cards = (view: View, pageOf: Map<ReportRepository, number>): string => `
  ${section('Все хранилища', 'Полоса — заполнение: тёмное — бэкапы задач, сиреневое — без задачи, цветное — свободно. Нажмите карточку — откроется хранилище.')}
  ${view.report.sites
    .map((site) => {
      const capacity = site.repositories.reduce((sum, repository) => sum + repository.capacityGB, 0);
      const free = site.repositories.reduce((sum, repository) => sum + repository.freeGB, 0);
      return `<div class="site"><div class="site-h">${glyph('pin')}<b>${esc(site.name || 'Хранилища')}</b><span>${site.repositories.length} ${storagesWord(site.repositories.length)} · ${Math.round(capacity / 1024)} ТБ · свободно ${num(free / 1024)} ТБ (${capacity ? Math.round((100 * free) / capacity) : 0}%)</span></div>
      <div class="cards">${site.repositories
        .map(
          (repository) => `<a class="rc ${tone(repository.status)}" href="#${slug(repository)}">
        <div class="rc-h"><div class="rc-n">${esc(repository.short)}</div>${pill(repository.status)}</div>
        <div class="rc-f">${esc(repository.name.split(' · ')[0])} · ${esc(repository.type)}</div>
        ${bar(repository)}
        <div class="rc-free"><b class="${freeTone(repository)}">${Math.round(repository.freePercent)}%</b> свободно · ${tbOfGB(repository.freeGB)} из ${tbOfGB(repository.capacityGB)} ТБ</div>
        <div class="rc-s"><div><b>${repository.unknown ? '?' : repository.active.length}</b><span>задач</span></div><div><b class="${repository.peak >= 10 ? 'crit' : repository.peak >= 6 ? 'warn' : ''}">${repository.unknown ? '?' : repository.peak}</b><span>пик</span></div><div><b>${repository.orphanBytes > NOTABLE_BYTES ? tb(repository.orphanBytes) : '0'}</b><span>ТБ без задачи</span></div></div>
        <div class="rc-b"><div class="rc-i">${esc(repository.problems[0]?.title ?? 'Всё в порядке')}</div><div class="rc-p">стр. ${pageOf.get(repository)} ${glyph('arrow')}</div></div>
      </a>`,
        )
        .join('')}</div></div>`;
    })
    .join('')}`;

// --- Which server attaches what
const attachments = (view: View): string => {
  const { report } = view;
  const cell = (attachment: Attachment) =>
    attachment === null
      ? '<span class="mx-no">—</span>'
      : attachment === 'unknown'
        ? '<span class="mx-q">?</span>'
        : `<span class="mx-c ${attachment.on ? 'on' : 'idle'}${attachment.twice ? ' twice' : ''}">${attachment.on}<small>/${attachment.all}</small>${attachment.twice ? '<em>2 репоз.</em>' : ''}</span>`;
  const settings = report.repositories.flatMap((repository) => repository.settings.map((setting) => ({ setting, repository })));
  const shared = report.repositories.filter((repository) => repository.servers.length > 1);
  return `
  ${section('Кто к чему подключён', 'В ячейке — задачи этого сервера, которые пишут в хранилище: работают / всего. 0 — подключено, но никто не пишет. «—» — не подключено.')}
  <table class="mx">
    <thead><tr><th>Хранилище</th>${report.servers
      .map((server) => `<th><div class="sv"><i class="${server.answered ? 'ok' : 'unk'}"></i>${esc(server.name)}</div><div class="sv-s">${server.answered ? 'на связи' : 'не ответил'}</div></th>`)
      .join('')}<th class="r">Свободно</th></tr></thead>
    <tbody>${report.sites
      .map(
        (site) =>
          `${site.name ? `<tr class="mx-site"><td colspan="${report.servers.length + 2}">${glyph('pin')} ${esc(site.name)}</td></tr>` : ''}${site.repositories
            .map(
              (repository) =>
                `<tr><td><div class="mx-n">${esc(repository.short)} ${pill(repository.status)}</div><div class="mx-p">${esc(repository.path)}</div></td>${(report.attachments.get(repository) ?? [])
                  .map((attachment) => `<td>${cell(attachment)}</td>`)
                  .join('')}<td class="r"><b class="${freeTone(repository)}">${Math.round(repository.freePercent)}%</b><div class="mx-p">${tbOfGB(repository.freeGB)} из ${tbOfGB(repository.capacityGB)} ТБ</div></td></tr>`,
            )
            .join('')}`,
      )
      .join('')}</tbody>
  </table>
  <div class="duo">
    <div class="panel"><h3>${glyph('gear')} Ошибки настройки</h3>
      <div class="cfg">${settings
        .map(
          ({ setting, repository }) =>
            `<div>${icon('gear', 'warn')}<div><b>${
              setting.kind === 'name'
                ? `${esc(setting.server)}: «${esc(shortOf(setting.repositories[0]))}» пишет в папку ${esc(shortOf(setting.folder ?? ''))}`
                : `${esc(setting.server)}: ${esc(setting.repositories.map(shortOf).join(' и '))} — одна папка`
            }</b><span>${
              setting.kind === 'name' ? 'Переименовать; путь не менять — там цепочка бэкапов.' : repository.unknown ? 'Уточнить у СХД, куда должен смотреть второй.' : 'Место считается дважды — оставить один.'
            }</span></div></div>`,
        )
        .join('')}
      ${
        shared.length
          ? `<div>${icon('link', 'warn')}<div><b>${shared.length} ${plural(shared.length, 'репозиторий подключён', 'репозитория подключены', 'репозиториев подключены')} к нескольким серверам Veeam</b><span>Каждый сервер сам чистит и пересканирует папку. Лучше закрепить папку за одним сервером, на остальных — Remove repository (данные остаются).</span></div></div>`
          : ''
      }
      ${!settings.length && !shared.length ? '<div class="empty">Ошибок не найдено.</div>' : ''}</div>
    </div>
    <div class="panel"><h3>${glyph('question')} Как читать отчёт</h3>
      <div class="howto">
        <div>${pill('crit')}<span>места меньше 10% или задача висит больше суток</span></div>
        <div>${pill('warn')}<span>места меньше 20%, задачи висят или падают, пик от 6 задач, упирается в запись, бэкапы без задачи, ошибки настройки</span></div>
        <div>${pill('ok')}<span>места достаточно, задачи идут без ошибок</span></div>
        <div>${pill('unknown')}<span>сервер Veeam не ответил — видно только место</span></div>
        <div><span class="chip warn">Target</span><span>узкое место — запись в хранилище: диски не успевают. Source — чтение с продуктива, Proxy — прокси, Network — сеть.</span></div>
      </div>
    </div>
  </div>`;
};
