import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { ErrorBox, Loader, Panel, SectionBody } from '../components/Panels';
import { formatDateTime, formatLag, formatRelative } from '../lib/format';

export function ReplicaDetailsPage() {
  const { id = '' } = useParams<{ id: string }>();

  const query = useQuery({
    queryKey: ['replica', id],
    queryFn: () => api.replica(id),
    enabled: id !== '',
  });

  if (query.isPending) return <Loader />;
  if (query.isError) return <ErrorBox error={query.error} onRetry={() => query.refetch()} />;

  const { replica, restorePoints } = query.data;

  return (
    <div className="stack">
      <div>
        <Link className="link link--back" to="/replicas">
          ← Ко всем репликам
        </Link>
        <h1 className="page-title">{replica.name}</h1>
        <p className="page-subtitle">
          {[replica.state, replica.platform, replica.hostName].filter(Boolean).join(' · ') || '—'}
        </p>
      </div>

      <Panel title="Параметры">
        <dl className="facts">
          <Fact label="Исходная ВМ" value={replica.originalVmName ?? '—'} />
          <Fact label="Реплика" value={replica.replicaVmName ?? '—'} />
          <Fact label="Хост" value={replica.hostName ?? '—'} />
          <Fact
            label="Задание"
            value={
              replica.jobId ? (
                <Link className="link" to={`/jobs/${encodeURIComponent(replica.jobId)}`}>
                  {replica.jobName ?? replica.jobId}
                </Link>
              ) : (
                (replica.jobName ?? '—')
              )
            }
          />
          <Fact label="Отставание" value={formatLag(replica.lagMinutes)} />
          <Fact
            label="Последняя точка"
            value={`${formatDateTime(replica.latestRestorePointTime)} (${formatRelative(replica.latestRestorePointTime)})`}
          />
          <Fact label="Точек восстановления" value={replica.restorePointsCount ?? '—'} />
        </dl>
      </Panel>

      <Panel title="Точки восстановления реплики">
        <SectionBody
          section={restorePoints}
          what="Точки восстановления реплик"
          empty="Точек восстановления не найдено"
        >
          {(items) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Создана</th>
                    <th>Тип</th>
                    <th>Состояние</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((point) => (
                    <tr key={point.id}>
                      <td>
                        {formatDateTime(point.creationTime)}
                        <div className="table__hint">{formatRelative(point.creationTime)}</div>
                      </td>
                      <td>{point.type ?? '—'}</td>
                      <td>{point.state ?? '—'}</td>
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

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="facts__item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
