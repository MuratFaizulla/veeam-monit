import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { ErrorBox, Loader, Panel, SectionBody } from '../components/Panels';
import { formatDateTime, formatRelative } from '../lib/format';

/** Maps a Veeam compliance status to one of the badge colours. */
function badgeFor(status: string | null): string {
  switch (status?.toLowerCase()) {
    case 'ok':
    case 'passed':
    case 'compliant':
      return 'success';
    case 'notcompliant':
    case 'noncompliant':
    case 'failed':
      return 'failed';
    case 'suppressed':
      return 'disabled';
    case 'unabletocheck':
      return 'warning';
    default:
      return 'unknown';
  }
}

export function SecurityPage() {
  const query = useQuery({
    queryKey: ['security'],
    queryFn: api.security,
    refetchInterval: 300_000,
  });

  if (query.isPending) return <Loader />;
  if (query.isError) return <ErrorBox error={query.error} onRetry={() => query.refetch()} />;

  const { analyzer, malware } = query.data;

  return (
    <div className="stack">
      <h1 className="page-title">Безопасность</h1>

      {analyzer.available && (
        <div className="tiles">
          {Object.entries(analyzer.counts).map(([status, count]) => (
            <div key={status} className={`tile tile--${badgeFor(status)}`}>
              <span className="tile__value">{count}</span>
              <span className="tile__label">{status}</span>
            </div>
          ))}
        </div>
      )}

      <Panel
        title="Security & Compliance Analyzer"
        action={
          analyzer.lastRun && (
            <span className="panel__meta">
              Последний запуск: {formatDateTime(analyzer.lastRun.endTime)}
              {analyzer.lastRun.result ? ` · ${analyzer.lastRun.result}` : ''}
            </span>
          )
        }
      >
        <SectionBody
          section={{ available: analyzer.available, items: analyzer.items }}
          what="Результаты анализатора"
          empty="Анализатор ещё не запускался"
        >
          {(items) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Проверка</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((practice) => (
                    <tr key={practice.id || practice.name}>
                      <td>
                        {practice.name ?? '—'}
                        {practice.description && (
                          <div className="table__hint">{practice.description}</div>
                        )}
                        {practice.suppressComment && (
                          <div className="table__hint">
                            Подавлено: {practice.suppressComment}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={`badge badge--${badgeFor(practice.status)}`}>
                          {practice.status ?? '—'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionBody>
      </Panel>

      <Panel title="События malware detection">
        <SectionBody
          section={{ available: malware.available, items: malware.items }}
          what="События malware detection"
          empty="Событий не зафиксировано"
        >
          {(items) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Обнаружено</th>
                    <th>Машина</th>
                    <th>Важность</th>
                    <th>Состояние</th>
                    <th>Источник</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((event) => (
                    <tr key={event.id}>
                      <td>
                        {formatDateTime(event.detectedAt)}
                        <div className="table__hint">{formatRelative(event.detectedAt)}</div>
                      </td>
                      <td>
                        {event.machineName ?? '—'}
                        {event.details && <div className="table__hint">{event.details}</div>}
                      </td>
                      <td>{event.severity ?? '—'}</td>
                      <td>{event.state ?? '—'}</td>
                      <td>{event.source ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionBody>
      </Panel>
    </div>
  );
}
