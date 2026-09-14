import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { ErrorBox, Loader, Panel, SectionBody } from '../components/Panels';
import { formatDateTime, formatRelative } from '../lib/format';

export function BackupObjectPage() {
  const { id = '' } = useParams<{ id: string }>();

  const query = useQuery({
    queryKey: ['backupObject', id],
    queryFn: () => api.backupObject(id),
    enabled: id !== '',
  });

  if (query.isPending) return <Loader />;
  if (query.isError) return <ErrorBox error={query.error} onRetry={() => query.refetch()} />;

  const { object, restorePoints } = query.data;
  const latest = restorePoints.items[0]?.creationTime ?? null;

  return (
    <div className="stack">
      <div>
        <Link className="link link--back" to="/backups">
          ← Ко всем бэкапам
        </Link>
        <h1 className="page-title">{object.name}</h1>
        <p className="page-subtitle">
          {[object.type, object.platform, object.path].filter(Boolean).join(' · ') || '—'}
        </p>
      </div>

      <div className="tiles">
        <div className="tile">
          <span className="tile__value">{restorePoints.items.length}</span>
          <span className="tile__label">Точек восстановления</span>
        </div>
        <div className="tile">
          <span className="tile__value">{formatRelative(latest)}</span>
          <span className="tile__label">Последняя точка</span>
        </div>
      </div>

      <Panel title="Точки восстановления">
        <SectionBody
          section={restorePoints}
          what="Точки восстановления"
          empty="Точек восстановления не найдено"
        >
          {(items) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Создана</th>
                    <th>Тип</th>
                    <th>Malware</th>
                    <th>Имя</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((point) => (
                    <tr key={point.id}>
                      <td title={formatDateTime(point.creationTime)}>
                        {formatDateTime(point.creationTime)}
                        <div className="table__hint">{formatRelative(point.creationTime)}</div>
                      </td>
                      <td>{point.type ?? '—'}</td>
                      <td>{point.malwareStatus ?? '—'}</td>
                      <td>{point.name ?? '—'}</td>
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
