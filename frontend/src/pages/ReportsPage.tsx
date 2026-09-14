import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, downloads } from '../api/client';
import { RepositoryTable } from '../components/RepositoryTable';
import { EmptyState, ErrorBox, Loader, Panel } from '../components/Panels';
import { STATUS_LABELS, STATUS_ORDER, formatDateTime, formatDuration } from '../lib/format';

const PERIODS = [1, 7, 30, 90];

export function ReportsPage() {
  const [days, setDays] = useState(7);

  const query = useQuery({
    queryKey: ['reportSummary', days],
    queryFn: () => api.reportSummary(days),
  });

  return (
    <div className="stack">
      <h1 className="page-title">Отчёты</h1>

      <div className="toolbar">
        <div className="chips">
          {PERIODS.map((period) => (
            <button
              key={period}
              type="button"
              className={`chip${period === days ? ' chip--active' : ''}`}
              onClick={() => setDays(period)}
            >
              {period === 1 ? 'Сутки' : `${period} дн.`}
            </button>
          ))}
        </div>
      </div>

      <Panel title="Выгрузка">
        <div className="downloads">
          {/*
            Plain links, not fetch: the browser saves the file itself and sends
            the session cookie because /api is same-origin via the dev proxy.
          */}
          <a className="button" href={downloads.summaryHtml(days)} target="_blank" rel="noreferrer">
            Сводный отчёт (HTML → PDF)
          </a>
          <a className="button button--ghost" href={downloads.jobsCsv()}>
            Задания, CSV
          </a>
          <a className="button button--ghost" href={downloads.sessionsCsv(days)}>
            Сессии за период, CSV
          </a>
          <a className="button button--ghost" href={downloads.repositoriesCsv()}>
            Репозитории, CSV
          </a>
        </div>
        <p className="downloads__hint">
          CSV открывается в Excel напрямую: UTF-8 с BOM, разделитель «;». Сводный отчёт
          открывается в новой вкладке — «Печать» → «Сохранить как PDF».
        </p>
      </Panel>

      {query.isPending && <Loader />}
      {query.isError && <ErrorBox error={query.error} onRetry={() => query.refetch()} />}

      {query.data && (
        <>
          <div className="tiles">
            <Tile label="Заданий" value={query.data.jobs.total} />
            <Tile
              label="Успешных заданий"
              value={
                query.data.jobs.successRate === null ? '—' : `${query.data.jobs.successRate}%`
              }
            />
            <Tile label={`Запусков за ${days} дн.`} value={query.data.runs.totalRuns} />
            <Tile label="С ошибкой" value={query.data.runs.failed} status="failed" />
            <Tile label="С предупреждением" value={query.data.runs.warning} status="warning" />
            <Tile
              label="Средняя длительность"
              value={formatDuration(query.data.runs.avgDurationSeconds)}
            />
          </div>

          <div className="columns">
            <Panel title="Задания по статусам">
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Статус</th>
                      <th className="table__num">Заданий</th>
                    </tr>
                  </thead>
                  <tbody>
                    {STATUS_ORDER.filter((status) => query.data.jobs.byStatus[status] > 0).map(
                      (status) => (
                        <tr key={status}>
                          <td>{STATUS_LABELS[status]}</td>
                          <td className="table__num">{query.data.jobs.byStatus[status]}</td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title="Длительность запусков">
              <dl className="facts">
                <Fact label="Средняя" value={formatDuration(query.data.runs.avgDurationSeconds)} />
                <Fact
                  label="Минимальная"
                  value={formatDuration(query.data.runs.minDurationSeconds)}
                />
                <Fact
                  label="Максимальная"
                  value={formatDuration(query.data.runs.maxDurationSeconds)}
                />
                <Fact
                  label="Последний успех"
                  value={formatDateTime(query.data.runs.lastSuccess)}
                />
                <Fact
                  label="Последняя ошибка"
                  value={formatDateTime(query.data.runs.lastFailure)}
                />
              </dl>
            </Panel>
          </div>

          <Panel title={`Проблемные задания за ${days} дн.`}>
            {query.data.worstJobs.length === 0 ? (
              <EmptyState>За период ошибок и предупреждений не было</EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Задание</th>
                      <th className="table__num">Ошибок</th>
                      <th className="table__num">Предупреждений</th>
                      <th className="table__num">Успешно</th>
                      <th className="table__num">Успешность</th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.worstJobs.map((job) => (
                      <tr key={job.id}>
                        <td>{job.name}</td>
                        <td className="table__num">{job.failed}</td>
                        <td className="table__num">{job.warning}</td>
                        <td className="table__num">{job.success}</td>
                        <td className="table__num">
                          {job.successRate === null ? '—' : `${job.successRate}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="Репозитории с заполнением выше 80%">
            {!query.data.repositories.available ? (
              <EmptyState>Репозитории недоступны для текущей роли</EmptyState>
            ) : query.data.repositories.lowOnSpace.length === 0 ? (
              <EmptyState>
                Все {query.data.repositories.total} репозиториев заполнены меньше чем на 80%
              </EmptyState>
            ) : (
              <RepositoryTable repositories={query.data.repositories.lowOnSpace} />
            )}
          </Panel>
        </>
      )}
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
  status?: 'failed' | 'warning';
}) {
  const highlight = status && typeof value === 'number' && value > 0 ? ` tile--${status}` : '';
  return (
    <div className={`tile${highlight}`}>
      <span className="tile__value">{value}</span>
      <span className="tile__label">{label}</span>
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
