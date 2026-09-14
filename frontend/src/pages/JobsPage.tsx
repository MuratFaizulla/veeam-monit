import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { JobStatus } from '../api/types';
import { JobsTable } from '../components/JobsTable';
import { ErrorBox, Loader, Panel } from '../components/Panels';
import { STATUS_LABELS, STATUS_ORDER } from '../lib/format';

type Filter = JobStatus | 'all';

export function JobsPage() {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const query = useQuery({
    queryKey: ['jobs'],
    queryFn: api.jobs,
    refetchInterval: 60_000,
  });

  const jobs = useMemo(() => {
    const all = query.data ?? [];
    const needle = search.trim().toLowerCase();
    return all.filter((job) => {
      const matchesStatus = filter === 'all' || job.status === filter;
      const matchesSearch =
        needle === '' ||
        job.name.toLowerCase().includes(needle) ||
        (job.type ?? '').toLowerCase().includes(needle);
      return matchesStatus && matchesSearch;
    });
  }, [query.data, search, filter]);

  if (query.isPending) return <Loader />;
  if (query.isError) return <ErrorBox error={query.error} onRetry={() => query.refetch()} />;

  const present = STATUS_ORDER.filter((status) =>
    (query.data ?? []).some((job) => job.status === status),
  );

  return (
    <div className="stack">
      <div><div className="eyebrow">Защита данных</div><h1 className="page-title">Задания</h1><p className="page-subtitle">Откройте задание, чтобы посмотреть статистику, историю и отчёт по каждому запуску.</p></div>

      <div className="toolbar">
        <input
          type="search"
          className="toolbar__search"
          placeholder="Поиск по названию или типу"
          aria-label="Поиск заданий"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="chips">
          <Chip active={filter === 'all'} onClick={() => setFilter('all')}>
            Все ({query.data.length})
          </Chip>
          {present.map((status) => (
            <Chip key={status} active={filter === status} onClick={() => setFilter(status)}>
              {STATUS_LABELS[status]} ({query.data.filter((job) => job.status === status).length})
            </Chip>
          ))}
        </div>
      </div>

      <Panel title={`Найдено: ${jobs.length}`}>
        <JobsTable jobs={jobs} />
      </Panel>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className={`chip${active ? ' chip--active' : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}
