import { Link } from 'react-router-dom';
import type { JobSummary } from '../api/types';
import { formatDateTime, formatRelative } from '../lib/format';
import { StatusBadge } from './StatusBadge';
import { EmptyState } from './Panels';

interface Props {
  jobs: JobSummary[];
  /** Hides the columns that make no sense in the narrow dashboard panels. */
  compact?: boolean;
}

export function JobsTable({ jobs, compact = false }: Props) {
  if (jobs.length === 0) {
    return <EmptyState>Нет заданий</EmptyState>;
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Задание</th>
            <th>Статус</th>
            <th>Последний запуск</th>
            {!compact && <th>Следующий запуск</th>}
            {!compact && <th>Тип</th>}
            {!compact && <th className="table__num">Объектов</th>}
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                <Link className="link" to={`/jobs/${encodeURIComponent(job.id)}`}>
                  {job.name}
                </Link>
                {job.description && !compact && (
                  <div className="table__hint">{job.description}</div>
                )}
              </td>
              <td>
                <StatusBadge status={job.status} />
                {job.status === 'running' && job.progressPercent !== null && (
                  <span className="table__hint">{job.progressPercent}%</span>
                )}
              </td>
              <td title={formatDateTime(job.lastRun)}>{formatRelative(job.lastRun)}</td>
              {!compact && <td>{formatDateTime(job.nextRun)}</td>}
              {!compact && <td>{job.type ?? '—'}</td>}
              {!compact && <td className="table__num">{job.objectsCount ?? '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
