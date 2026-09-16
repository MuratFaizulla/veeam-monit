import { escapeHtml, MAX_LENGTH } from '../telegram/format';
import { LiveClock } from './format';
import { VeeamSession, VeeamTaskSession } from '../veeam/types';

export const ACTIVE_SESSION_STATES = new Set([
  'starting', 'working', 'postprocessing', 'waitingrepository', 'waitingslot',
  'waitingtape', 'pausing', 'resuming',
]);
const ACTIVE_TASK_STATES = new Set(ACTIVE_SESSION_STATES);
const TASK_TYPES = new Set(['backup', 'replica']);

export interface PerformanceJob {
  id: string;
  name: string;
  state?: string;
  sessionType?: string;
  creationTime?: string;
  progressPercent?: number;
  processedSize?: number;
  readSize?: number;
  transferredSize?: number;
  rateBps?: number;
  bottleneck?: string;
}

export interface PerformanceSnapshot {
  jobs: PerformanceJob[];
  activeCount: number;
  statisticsAvailable: boolean;
  unavailable?: string;
}

/** Strict, exception-free parser for Veeam rates such as "1.2 GB/s". */
export const parseProcessingRate = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return undefined;
  const match = value.trim().match(/^(\d+(?:[.,]\d+)?)\s*(KB|MB|GB)\/s$/i);
  if (!match) return undefined;
  const amount = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(amount)) return undefined;
  const power = { KB: 1, MB: 2, GB: 3 }[match[2].toUpperCase() as 'KB' | 'MB' | 'GB'];
  return amount * 1024 ** power;
};

export const formatRate = (bps: number | undefined): string => {
  if (bps === undefined || !Number.isFinite(bps)) return 'нет данных';
  if (bps >= 1024 ** 3) return `${trim(bps / 1024 ** 3)} GB/s`;
  if (bps >= 1024 ** 2) return `${trim(bps / 1024 ** 2)} MB/s`;
  return `${trim(bps / 1024)} KB/s`;
};

export const formatBytes = (bytes: number | undefined): string => {
  if (bytes === undefined || !Number.isFinite(bytes)) return 'нет данных';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Math.max(0, bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${trim(value)} ${units[index]}`;
};

export const formatPerformanceDuration = (startedAt: string | undefined, now: Date): string => {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start)) return 'нет данных';
  const totalMinutes = Math.max(0, Math.floor((now.getTime() - start) / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days} д ${hours} ч`;
  if (hours) return `${hours} ч ${minutes} мин`;
  return `${minutes} мин`;
};

export const aggregatePerformance = (
  session: VeeamSession,
  tasks: VeeamTaskSession[],
): PerformanceJob => {
  const eligible = tasks.filter((task) => TASK_TYPES.has((task.type ?? '').toLowerCase()));
  const sum = (key: 'processedSize' | 'readSize' | 'transferredSize'): number | undefined => {
    const values = eligible.map((task) => task.progress?.[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
  };
  const activeEligible = eligible.filter((task) => {
      const state = (task.state ?? task.status)?.toLowerCase();
      return !state || ACTIVE_TASK_STATES.has(state);
    });
  const rates = activeEligible
    .map((task) => parseProcessingRate(task.progress?.processingRate))
    .filter((v): v is number => v !== undefined);
  const bottlenecks = activeEligible
    .map((task) => task.progress?.bottleneck?.trim())
    .filter((v): v is string =>
      typeof v === 'string' && v.length > 0 && !['none', 'notdefined'].includes(v.toLowerCase()),
    );
  const counts = new Map<string, number>();
  for (const value of bottlenecks) counts.set(value, (counts.get(value) ?? 0) + 1);
  const bottleneck = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];

  return {
    id: session.id ?? '',
    name: session.name ?? session.id ?? 'без имени',
    state: session.state,
    sessionType: session.sessionType,
    creationTime: session.creationTime,
    progressPercent: session.progressPercent,
    processedSize: sum('processedSize'),
    readSize: sum('readSize'),
    transferredSize: sum('transferredSize'),
    rateBps: rates.length ? rates.reduce((a, b) => a + b, 0) : undefined,
    bottleneck,
  };
};

export const sortPerformanceJobs = (jobs: PerformanceJob[]): PerformanceJob[] =>
  [...jobs].sort((a, b) => {
    if (a.rateBps === undefined) return b.rateBps === undefined ? a.name.localeCompare(b.name) : 1;
    if (b.rateBps === undefined) return -1;
    return a.rateBps - b.rateBps || a.name.localeCompare(b.name);
  });

export const renderPerformance = (snapshot: PerformanceSnapshot, clock: LiveClock): string => {
  const footer = `Обновлено ${stamp(clock.now, clock.timezone)}`;
  if (snapshot.unavailable) return limit([
    '📈 <b>VEEAM PERFORMANCE</b>', '', '⚠️ Данные производительности временно недоступны.',
    escapeHtml(snapshot.unavailable), '', `<i>${footer}</i>`,
  ]);
  if (!snapshot.activeCount) return limit([
    '📈 <b>VEEAM PERFORMANCE</b>', '', '✅ Сейчас активных заданий нет.', '', `<i>${footer}</i>`,
  ]);
  if (!snapshot.statisticsAvailable) return limit([
    '📈 <b>VEEAM PERFORMANCE</b>', '', `⚠️ Активных заданий: ${snapshot.activeCount}`,
    'Данные производительности временно недоступны.', '', `<i>${footer}</i>`,
  ]);

  const sorted = sortPerformanceJobs(snapshot.jobs);
  for (let shown = Math.min(10, sorted.length); shown >= 0; shown -= 1) {
    const lines = ['📈 <b>VEEAM PERFORMANCE</b>', '', '🐢 <b>Самые медленные активные задания</b>', ''];
    for (const job of sorted.slice(0, shown)) lines.push(...jobLines(job, clock), '');
    lines.push(`Активных заданий: ${snapshot.activeCount}`, `Показано самых медленных: ${shown}`);
    const summary = bottleneckSummary(sorted);
    if (summary) lines.push('', `Узкие места: ${escapeHtml(summary)}`);
    lines.push('', `<i>${footer}</i>`);
    if (lines.join('\n').length <= MAX_LENGTH) return lines.join('\n');
  }
  return limit(['📈 <b>VEEAM PERFORMANCE</b>', '', `Активных заданий: ${snapshot.activeCount}`, '', `<i>${footer}</i>`]);
};

const jobLines = (job: PerformanceJob, clock: LiveClock): string[] => {
  const mbps = job.rateBps === undefined ? undefined : job.rateBps / 1024 ** 2;
  const icon = mbps === undefined ? '⚪' : mbps < 20 ? '🔴' : mbps < 50 ? '🟠' : mbps < 100 ? '🟡' : '🟢';
  const lines = [
    `${icon} <b>${escapeHtml(job.name)}</b>`,
    `${formatRate(job.rateBps)} · идёт ${formatPerformanceDuration(job.creationTime, clock.now)}`,
  ];
  if (job.creationTime && clock.now.getTime() - Date.parse(job.creationTime) >= 86_400_000) {
    lines.push(`старт ${shortDate(job.creationTime, clock.timezone)}`);
  }
  if (job.processedSize !== undefined) lines.push(`Обработано: ${formatBytes(job.processedSize)}`);
  if (job.readSize !== undefined) lines.push(`Прочитано: ${formatBytes(job.readSize)}`);
  if (job.transferredSize !== undefined) lines.push(`Передано: ${formatBytes(job.transferredSize)}`);
  if (job.progressPercent !== undefined) lines.push(`Прогресс: ${Math.round(job.progressPercent)}%`);
  lines.push(`Узкое место: ${escapeHtml(job.bottleneck ?? 'Не определено')}`);
  return lines;
};

const bottleneckSummary = (jobs: PerformanceJob[]): string => {
  const counts = new Map<string, number>();
  for (const job of jobs) if (job.bottleneck) counts.set(job.bottleneck, (counts.get(job.bottleneck) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(' · ');
};
const trim = (value: number): string => value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, '');
const stamp = (date: Date, timezone: string): string => new Intl.DateTimeFormat('ru-RU', { timeZone: timezone || undefined, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
const shortDate = (iso: string, timezone: string): string => new Intl.DateTimeFormat('ru-RU', { timeZone: timezone || undefined, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const limit = (lines: string[]): string => {
  let text = lines.join('\n');
  while (text.length > MAX_LENGTH && lines.length > 1) { lines.splice(-2, 1); text = lines.join('\n'); }
  return text.slice(0, MAX_LENGTH);
};
