import type { JobStatus } from '../api/types';

const dateTime = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : dateTime.format(parsed);
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value).getTime();
  if (Number.isNaN(parsed)) return '—';

  const diffMs = Date.now() - parsed;
  const future = diffMs < 0;
  const minutes = Math.round(Math.abs(diffMs) / 60000);

  if (minutes < 1) return 'только что';
  const text =
    minutes < 60
      ? `${minutes} мин`
      : minutes < 60 * 24
        ? `${Math.round(minutes / 60)} ч`
        : `${Math.round(minutes / (60 * 24))} дн`;

  return future ? `через ${text}` : `${text} назад`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${seconds} с`;

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
}

export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const units = ['Б', 'КиБ', 'МиБ', 'ГиБ', 'ТиБ'];
  const index = value > 0 ? Math.min(4, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  return `${(value / 1024 ** index).toLocaleString('ru-RU', { maximumFractionDigits: index ? 1 : 0 })} ${units[index]}`;
}

/** Veeam reports repository capacity in gigabytes. */
export function formatGb(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value >= 1024) return `${(value / 1024).toFixed(1)} ТБ`;
  return `${Math.round(value)} ГБ`;
}

export function formatLag(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—';
  if (minutes < 60) return `${minutes} мин`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} ч`;
  return `${Math.round(minutes / (60 * 24))} дн`;
}

export const STATUS_LABELS: Record<JobStatus, string> = {
  running: 'Выполняется',
  success: 'Успешно',
  warning: 'Предупреждение',
  failed: 'Ошибка',
  disabled: 'Отключено',
  idle: 'Не запускалось',
  unknown: 'Неизвестно',
};

/** Order used for the status tiles on the dashboard. */
export const STATUS_ORDER: JobStatus[] = [
  'running',
  'success',
  'warning',
  'failed',
  'idle',
  'disabled',
  'unknown',
];
