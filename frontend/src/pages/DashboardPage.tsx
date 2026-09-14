import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { DashboardSummary, JobStatus } from '../api/types';
import { Link } from 'react-router-dom';
import { JobsTable } from '../components/JobsTable';
import { RepositoryTable } from '../components/RepositoryTable';
import { SessionsTable } from '../components/SessionsTable';
import { ErrorBox, Loader, Panel, Unavailable } from '../components/Panels';
import { STATUS_LABELS, STATUS_ORDER, formatDateTime } from '../lib/format';

export function DashboardPage() {
  const query = useQuery({
    queryKey: ['dashboard'],
    queryFn: api.dashboard,
    refetchInterval: 60_000,
  });

  if (query.isPending) return <Loader />;
  if (query.isError) return <ErrorBox error={query.error} onRetry={() => query.refetch()} />;

  const data = query.data;

  return (
    <div className="stack">
      <ServerCard data={data} />

      {data.available.jobs ? <div className="tiles">
        <Tile label="Всего заданий" value={data.jobs.total} />
        {STATUS_ORDER.filter((status) => data.jobs.byStatus[status] > 0).map((status) => (
          <Tile
            key={status}
            label={STATUS_LABELS[status]}
            value={data.jobs.byStatus[status]}
            status={status}
          />
        ))}
        <Tile
          label="Доля успешных"
          value={data.jobs.successRate === null ? '—' : `${data.jobs.successRate}%`}
        />
      </div> : <Unavailable what="Задания" />}

      {data.running.length > 0 && (
        <Panel title="Сейчас выполняются">
          <JobsTable jobs={data.running} compact />
        </Panel>
      )}

      {data.available.jobs && <Panel title="Требуют внимания">
        <JobsTable jobs={data.attention} compact />
      </Panel>}

      {data.repositories.length > 0 && (
        <Panel
          title="Репозитории"
          action={
            <Link className="link" to="/infrastructure">
              Вся инфраструктура →
            </Link>
          }
        >
          <RepositoryTable repositories={data.repositories} />
        </Panel>
      )}

      <div className="columns">
        <Panel title="Ближайшие запуски">
          {data.available.jobs ? <JobsTable jobs={data.upcoming} compact /> : <Unavailable what="Задания" />}
        </Panel>

        <Panel title="Последние сессии">
          {data.available.sessions ? <SessionsTable sessions={data.recentSessions} /> : <Unavailable what="Сессии" />}
        </Panel>
      </div>
    </div>
  );
}

function ServerCard({ data }: { data: DashboardSummary }) {
  return (
    <div className="server-card">
      <div>
        <h1 className="page-title">{data.server?.name ?? 'Backup server'}</h1>
        <p className="page-subtitle">
          {data.server?.buildVersion ? `Сборка ${data.server.buildVersion}` : 'Версия недоступна'}
          {data.server?.databaseVendor ? ` · БД: ${data.server.databaseVendor}` : ''}
        </p>
      </div>
      <div className="server-card__meta">
        Обновлено: {formatDateTime(data.generatedAt)}
        {data.server === null && (
          <div className="table__hint">
            Сведения о сервере недоступны для текущей роли.
          </div>
        )}
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  status,
}: {
  label: string;
  value: number | string;
  status?: JobStatus;
}) {
  return (
    <div className={`tile${status ? ` tile--${status}` : ''}`}>
      <span className="tile__value">{value}</span>
      <span className="tile__label">{label}</span>
    </div>
  );
}
