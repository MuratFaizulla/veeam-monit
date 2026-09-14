import type { RepositoryView } from '../api/types';
import { formatGb } from '../lib/format';
import { EmptyState } from './Panels';

/** Used space bar turns amber past 80% and red past 90%. */
function fillLevel(percent: number | null): string {
  if (percent === null) return 'neutral';
  if (percent >= 90) return 'failed';
  if (percent >= 80) return 'warning';
  return 'success';
}

export function RepositoryTable({ repositories }: { repositories: RepositoryView[] }) {
  if (repositories.length === 0) {
    return <EmptyState>Репозиториев не найдено</EmptyState>;
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Репозиторий</th>
            <th>Заполнено</th>
            <th className="table__num">Свободно</th>
            <th className="table__num">Ёмкость</th>
            <th>Тип</th>
          </tr>
        </thead>
        <tbody>
          {repositories.map((repository) => (
            <tr key={repository.id}>
              <td>
                {repository.name}
                {(repository.hostName || repository.path) && (
                  <div className="table__hint">
                    {[repository.hostName, repository.path].filter(Boolean).join(' · ')}
                  </div>
                )}
              </td>
              <td>
                {repository.usedPercent === null ? (
                  '—'
                ) : (
                  <div className="meter">
                    <div
                      className={`meter__fill meter__fill--${fillLevel(repository.usedPercent)}`}
                      style={{ width: `${Math.min(repository.usedPercent, 100)}%` }}
                    />
                    <span className="meter__label">{repository.usedPercent}%</span>
                  </div>
                )}
              </td>
              <td className="table__num">{formatGb(repository.freeGB)}</td>
              <td className="table__num">{formatGb(repository.capacityGB)}</td>
              <td>{repository.type ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
