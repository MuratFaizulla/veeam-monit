import { escapeHtml, truncate } from '../telegram/format';
import { bottleneckWord } from '../telegram/words';
import { dayOf, fitted, footerOf, Clock } from './format';
import { ACTIVE_SESSION_STATES } from '../veeam/estate';
import { VeeamSession, VeeamTaskSession } from '../veeam/types';

/** A task is active in the same states its session is. */
const ACTIVE_TASK_STATES = ACTIVE_SESSION_STATES;
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
  /** Job runs in progress; Veeam's own sessions are `serviceSessions`. */
  activeCount: number;
  statisticsAvailable: boolean;
  /**
   * The server has no task sessions to read (REST API 1.1): no rate or size
   * will ever come, which is a different sentence from "not read this time".
   */
  statisticsUnsupported?: boolean;
  /** Veeam's own sessions in progress — a malware scan, a configuration backup — by name. */
  serviceSessions?: string[];
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

const TITLE = '📈 <b>Скорость выполняющихся заданий</b>';

export const renderPerformance = (snapshot: PerformanceSnapshot, clock: Clock): string => {
  const footer = footerOf(clock);
  const service = snapshot.serviceSessions?.length
    ? `<i>Служебные сессии Veeam: ${escapeHtml(snapshot.serviceSessions.join(', '))}</i>`
    : null;
  if (snapshot.unavailable) return truncate([
    TITLE, '', '⚠️ Скорость не прочитана.', escapeHtml(snapshot.unavailable), '', footer,
  ].join('\n'));
  if (!snapshot.activeCount) return truncate(
    [TITLE, '', '✅ Сейчас задания не выполняются.', ...(service ? ['', service] : []), '', footer].join('\n'),
  );

  // The jobs are listed whether or not their rate could be read: which job is
  // running, since when and how far along is worth having without it.
  const note = snapshot.statisticsAvailable
    ? null
    : snapshot.statisticsUnsupported
      ? 'ℹ️ Скорость и объёмы этот Veeam не сообщает: у его REST API (1.1) их нет. Вернутся после обновления Veeam до 12.1 или новее.'
      : 'ℹ️ Скорость и объёмы сейчас не прочитаны.';
  const sorted = sortPerformanceJobs(snapshot.jobs);
  const summary = bottleneckSummary(sorted);
  return truncate(
    fitted(Math.min(SLOWEST_SHOWN, sorted.length), (shown) => {
      const lines = [
        TITLE,
        '',
        ...(note ? [note, ''] : []),
        snapshot.statisticsAvailable ? '🐢 <b>Самые медленные сначала</b>' : '<b>Выполняются</b>',
        '',
      ];
      for (const job of sorted.slice(0, shown)) lines.push(...jobLines(job, clock), '');
      lines.push(`<b>Выполняется заданий:</b> ${snapshot.activeCount}`);
      if (shown < snapshot.activeCount) lines.push(`<b>Показаны самые медленные:</b> ${shown}`);
      if (summary) lines.push(`<b>Узкие места:</b> ${escapeHtml(summary)}`);
      if (service) lines.push(service);
      lines.push('', footer);
      return lines.join('\n');
    }),
  );
};

/** The slowest few are the point of the slot; the rest is noise beside them. */
const SLOWEST_SHOWN = 10;

const jobLines = (job: PerformanceJob, clock: Clock): string[] => {
  const mbps = job.rateBps === undefined ? undefined : job.rateBps / 1024 ** 2;
  const icon = mbps === undefined ? '⚪' : mbps < 20 ? '🔴' : mbps < 50 ? '🟠' : mbps < 100 ? '🟡' : '🟢';
  const going = `идёт ${formatPerformanceDuration(job.creationTime, clock.now)}`;
  const lines = [
    `${icon} <b>${escapeHtml(job.name)}</b>`,
    // "нет данных · идёт 3 д" read as if the job itself had no data.
    job.rateBps === undefined ? going : `${formatRate(job.rateBps)} · ${going}`,
  ];
  if (job.creationTime && clock.now.getTime() - Date.parse(job.creationTime) >= 86_400_000) {
    lines.push(`старт ${dayOf(job.creationTime, clock)}`);
  }
  if (job.processedSize !== undefined) lines.push(`Обработано: ${formatBytes(job.processedSize)}`);
  if (job.readSize !== undefined) lines.push(`Прочитано: ${formatBytes(job.readSize)}`);
  if (job.transferredSize !== undefined) lines.push(`Передано: ${formatBytes(job.transferredSize)}`);
  if (job.progressPercent !== undefined) lines.push(`Прогресс: ${Math.round(job.progressPercent)}%`);
  if (job.bottleneck) lines.push(`Узкое место: ${escapeHtml(bottleneckWord(job.bottleneck) ?? job.bottleneck)}`);
  return lines;
};

const bottleneckSummary = (jobs: PerformanceJob[]): string => {
  const counts = new Map<string, number>();
  for (const job of jobs) if (job.bottleneck) counts.set(job.bottleneck, (counts.get(job.bottleneck) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${bottleneckWord(name) ?? name} — ${count}`)
    .join(' · ');
};
const trim = (value: number): string => value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, '');
