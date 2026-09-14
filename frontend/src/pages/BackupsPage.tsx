import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { ErrorBox, Loader, Panel, SectionBody } from '../components/Panels';
import { formatDateTime } from '../lib/format';

export function BackupsPage() {
  const [search, setSearch] = useState('');

  const backups = useQuery({ queryKey: ['backups'], queryFn: api.backups });
  const objects = useQuery({ queryKey: ['backupObjects'], queryFn: api.backupObjects });

  const needle = search.trim().toLowerCase();

  const filteredBackups = useMemo(() => {
    const section = backups.data;
    if (!section) return null;
    return {
      ...section,
      items: section.items.filter((item) => item.name.toLowerCase().includes(needle)),
    };
  }, [backups.data, needle]);

  const filteredObjects = useMemo(() => {
    const section = objects.data;
    if (!section) return null;
    return {
      ...section,
      items: section.items.filter((item) => item.name.toLowerCase().includes(needle)),
    };
  }, [objects.data, needle]);


  return (
    <div className="stack">
      <h1 className="page-title">Бэкапы</h1>

      <div className="toolbar">
        <input
          type="search"
          className="toolbar__search"
          placeholder="Поиск по имени"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <Panel title={`Объекты (${filteredObjects?.items.length ?? 0})`}>
        {objects.isPending ? <Loader /> : objects.isError ? <ErrorBox error={objects.error} onRetry={() => objects.refetch()} /> : <SectionBody
          section={filteredObjects ?? { available: false, items: [] }}
          what="Объекты бэкапов"
          empty="Объектов не найдено"
        >
          {(items) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Объект</th>
                    <th>Тип</th>
                    <th>Платформа</th>
                    <th className="table__num">Точек восстановления</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((object) => (
                    <tr key={object.id}>
                      <td>
                        <Link
                          className="link"
                          to={`/backups/objects/${encodeURIComponent(object.id)}`}
                        >
                          {object.name}
                        </Link>
                        {object.path && <div className="table__hint">{object.path}</div>}
                      </td>
                      <td>{object.type ?? '—'}</td>
                      <td>{object.platform ?? '—'}</td>
                      <td className="table__num">{object.restorePointsCount ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionBody>}
      </Panel>

      <Panel title={`Бэкапы (${filteredBackups?.items.length ?? 0})`}>
        {backups.isPending ? <Loader /> : backups.isError ? <ErrorBox error={backups.error} onRetry={() => backups.refetch()} /> : <SectionBody
          section={filteredBackups ?? { available: false, items: [] }}
          what="Бэкапы"
          empty="Бэкапов не найдено"
        >
          {(items) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Бэкап</th>
                    <th>Тип</th>
                    <th>Платформа</th>
                    <th>Создан</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((backup) => (
                    <tr key={backup.id}>
                      <td>
                        {backup.name}
                        {backup.jobId && (
                          <div className="table__hint">
                            <Link className="link" to={`/jobs/${encodeURIComponent(backup.jobId)}`}>
                              к заданию
                            </Link>
                          </div>
                        )}
                      </td>
                      <td>{backup.type ?? '—'}</td>
                      <td>{backup.platform ?? '—'}</td>
                      <td>{formatDateTime(backup.creationTime)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionBody>}
      </Panel>
    </div>
  );
}
