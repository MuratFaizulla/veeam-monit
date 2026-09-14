import type { JobStatus } from '../api/types';
import { STATUS_LABELS } from '../lib/format';

export function StatusBadge({ status }: { status: JobStatus }) {
  return <span className={`badge badge--${status}`}>{STATUS_LABELS[status]}</span>;
}

/** Session results reuse the job status palette. */
export function ResultBadge({ result, state }: { result: string | null; state: string | null }) {
  const normalized = (result ?? '').toLowerCase();
  const running = Boolean(state) && !['stopped', 'idle'].includes(state!.toLowerCase());

  const status: JobStatus = running
    ? 'running'
    : normalized === 'success'
      ? 'success'
      : normalized === 'warning'
        ? 'warning'
        : normalized === 'failed'
          ? 'failed'
          : 'unknown';

  const label = running ? 'Выполняется' : status !== 'unknown' ? STATUS_LABELS[status] : 'Нет результата';

  return <span className={`badge badge--${status}`}>{label}</span>;
}
