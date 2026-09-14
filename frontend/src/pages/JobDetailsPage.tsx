import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { ErrorBox, EmptyState, Loader, Panel } from '../components/Panels';
import { JobReportPanel } from '../components/JobReportPanel';
import { StatusBadge } from '../components/StatusBadge';
import { formatDateTime } from '../lib/format';

export function JobDetailsPage() {
  const { id = '' } = useParams<{ id: string }>();
  const [tab, setTab] = useState<'report' | 'settings'>('report');
  const query = useQuery({ queryKey: ['job', id], queryFn: () => api.job(id), enabled: id !== '', refetchInterval: 60_000 });
  if (query.isPending) return <Loader />;
  if (query.isError) return <ErrorBox error={query.error} onRetry={() => query.refetch()} />;
  const job = query.data;
  return <div className="stack">
    <Link className="link link--back" to="/jobs">← Все задания</Link>
    <div className="job-heading">
      <div className="job-heading__icon" aria-hidden="true">▣</div>
      <div><div className="eyebrow">Задание Veeam</div><h1 className="page-title">{job.name}</h1><p className="page-subtitle">{job.type ?? 'Veeam Backup & Replication'}{job.description ? ` · ${job.description}` : ''}</p></div>
      <div className="job-heading__status"><StatusBadge status={job.status} /><span className="section-caption">Следующий запуск: {formatDateTime(job.nextRun)}</span></div>
    </div>
    <div className="page-tabs" aria-label="Разделы задания">
      <button type="button" aria-pressed={tab === 'report'} onClick={() => setTab('report')}>Отчёт и статистика</button>
      <button type="button" aria-pressed={tab === 'settings'} onClick={() => setTab('settings')}>Параметры и объекты <span>{job.includedObjects.length}</span></button>
    </div>
    {tab === 'report' ? <JobReportPanel jobId={id} /> : <div className="stack">
      <Panel title="Параметры задания"><dl className="facts">
        <Fact label="Тип" value={job.type ?? '—'} /><Fact label="Нагрузка" value={job.workload ?? '—'} />
        <Fact label="Последний запуск" value={formatDateTime(job.lastRun)} /><Fact label="Следующий запуск" value={formatDateTime(job.nextRun)} />
        <Fact label="По расписанию" value={job.isScheduled === null ? '—' : job.isScheduled ? 'Да' : 'Нет'} />
        <Fact label="Объектов" value={job.objectsCount ?? '—'} />
        <Fact label="Хранение" value={job.retention ? `${job.retention.quantity ?? '—'} ${job.retention.type ?? ''}` : '—'} />
        <Fact label="Репозиторий" value={job.repositoryId ?? '—'} />
      </dl></Panel>
      <Panel title="Объекты задания">{job.includedObjects.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Имя</th><th>Тип</th><th>Хост</th></tr></thead><tbody>{job.includedObjects.map((item, index) => <tr key={index}><td>{item.name ?? '—'}</td><td>{item.type ?? '—'}</td><td>{item.hostName ?? '—'}</td></tr>)}</tbody></table></div> : <EmptyState>Список объектов недоступен для этого типа задания</EmptyState>}</Panel>
    </div>}
  </div>;
}
function Fact({ label, value }: { label: string; value: string | number }) {
  return <div className="facts__item"><dt>{label}</dt><dd>{value}</dd></div>;
}
