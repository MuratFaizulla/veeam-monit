import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { ErrorBox, Loader, Panel, SectionBody } from '../components/Panels';
import { formatDateTime, formatLag } from '../lib/format';

export function ReplicasPage() {
  const query = useQuery({
    queryKey: ['replicas'],
    queryFn: api.replicas,
    refetchInterval: 120_000,
  });

  if (query.isPending) return <Loader />;
  if (query.isError) return <ErrorBox error={query.error} onRetry={() => query.refetch()} />;

  return (
    <div className="stack">
      <h1 className="page-title">Реплики</h1>

      <Panel title={`Всего: ${query.data.items.length}`}>
        <SectionBody section={query.data} what="Реплики" empty="Реплик не найдено">
          {(items) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Реплика</th>
                    <th>Состояние</th>
                    <th>Отставание</th>
                    <th>Последняя точка</th>
                    <th className="table__num">Точек</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((replica) => (
                    <tr key={replica.id}>
                      <td>
                        <Link className="link" to={`/replicas/${encodeURIComponent(replica.id)}`}>
                          {replica.name}
                        </Link>
                        {(replica.originalVmName || replica.hostName) && (
                          <div className="table__hint">
                            {[replica.originalVmName, replica.hostName].filter(Boolean).join(' → ')}
                          </div>
                        )}
                      </td>
                      <td>{replica.state ?? '—'}</td>
                      <td>{formatLag(replica.lagMinutes)}</td>
                      <td>{formatDateTime(replica.latestRestorePointTime)}</td>
                      <td className="table__num">{replica.restorePointsCount ?? '—'}</td>
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
