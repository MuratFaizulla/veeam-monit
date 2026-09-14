import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { EmptyState, ErrorBox, Loader, Panel, Unavailable } from '../components/Panels';
import { formatDateTime, formatRelative } from '../lib/format';

export function LicensePage() {
  const query = useQuery({
    queryKey: ['license'],
    queryFn: api.license,
    refetchInterval: 300_000,
  });

  if (query.isPending) return <Loader />;
  if (query.isError) return <ErrorBox error={query.error} onRetry={() => query.refetch()} />;

  const license = query.data;

  if (!license.available) {
    return (
      <div className="stack">
        <h1 className="page-title">Лицензии</h1>
        <Panel title="Лицензия">
          <Unavailable what="Сведения о лицензии" />
        </Panel>
      </div>
    );
  }

  return (
    <div className="stack">
      <h1 className="page-title">Лицензии</h1>

      <div className="tiles">
        {license.instances && (
          <Tile
            label="Instances"
            used={license.instances.used}
            licensed={license.instances.licensed}
          />
        )}
        {license.sockets && (
          <Tile label="Sockets" used={license.sockets.used} licensed={license.sockets.licensed} />
        )}
        {license.capacityTb && (
          <Tile
            label="Capacity, ТБ"
            used={license.capacityTb.used}
            licensed={license.capacityTb.licensed}
          />
        )}
      </div>

      <Panel title="Лицензия">
        <dl className="facts">
          <Fact label="Статус" value={license.status ?? '—'} />
          <Fact label="Редакция" value={license.edition ?? '—'} />
          <Fact label="Тип" value={license.type ?? '—'} />
          <Fact label="Выдана" value={license.licensedTo ?? '—'} />
          <Fact
            label="Истекает"
            value={`${formatDateTime(license.expirationDate)} (${formatRelative(license.expirationDate)})`}
          />
          <Fact label="Поддержка до" value={formatDateTime(license.supportExpirationDate)} />
          <Fact
            label="Автообновление"
            value={
              license.autoUpdateEnabled === null ? '—' : license.autoUpdateEnabled ? 'Да' : 'Нет'
            }
          />
        </dl>
      </Panel>

      <Panel title="Топ потребителей">
        {license.topWorkloads.length === 0 ? (
          <EmptyState>Потребление не детализировано</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Объект</th>
                  <th>Хост</th>
                  <th>Тип</th>
                  <th className="table__num">Потребление</th>
                </tr>
              </thead>
              <tbody>
                {license.topWorkloads.map((workload) => (
                  <tr key={`${workload.unit}-${workload.id}`}>
                    <td>{workload.name}</td>
                    <td>{workload.hostName ?? '—'}</td>
                    <td>{workload.type ?? '—'}</td>
                    <td className="table__num">
                      {workload.amount ?? '—'} {workload.unit}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function Tile({
  label,
  used,
  licensed,
}: {
  label: string;
  used: number | null;
  licensed: number | null;
}) {
  const percent =
    used !== null && licensed !== null && licensed > 0 ? Math.round((used / licensed) * 100) : null;

  return (
    <div className={`tile${percent !== null && percent >= 90 ? ' tile--failed' : ''}`}>
      <span className="tile__value">
        {used ?? '—'}
        <span className="tile__value-secondary"> / {licensed ?? '—'}</span>
      </span>
      <span className="tile__label">
        {label}
        {percent !== null ? ` · ${percent}%` : ''}
      </span>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="facts__item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
