import type { SessionSummary } from '../api/types';
import { formatDateTime, formatDuration } from '../lib/format';
import { ResultBadge } from './StatusBadge';
import { EmptyState } from './Panels';

export function SessionsTable({ sessions }: { sessions: SessionSummary[] }) {
  if (sessions.length === 0) {
    return <EmptyState>Сессий не найдено</EmptyState>;
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Сессия</th>
            <th>Результат</th>
            <th>Начало</th>
            <th>Длительность</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id}>
              <td>
                {session.name ?? session.id}
                {session.message && <div className="table__hint">{session.message}</div>}
              </td>
              <td>
                <ResultBadge result={session.result} state={session.state} />
              </td>
              <td>{formatDateTime(session.creationTime)}</td>
              <td>{formatDuration(session.durationSeconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
