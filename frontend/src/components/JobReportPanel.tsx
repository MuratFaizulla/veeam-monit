import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, downloads } from '../api/client';
import type { JobReport, LogReport, SessionSummary } from '../api/types';
import { EmptyState, ErrorBox, Loader, Panel, SectionBody } from './Panels';
import { ResultBadge } from './StatusBadge';
import { formatBytes, formatDateTime, formatDuration } from '../lib/format';

function tone(session: SessionSummary) {
  if (session.state && !['stopped', 'idle'].includes(session.state.toLowerCase())) return 'running';
  return ['success', 'warning', 'failed'].includes(session.result?.toLowerCase() ?? '') ? session.result!.toLowerCase() : 'unknown';
}

export function JobReportPanel({ jobId }: { jobId: string }) {
  const [params, setParams] = useSearchParams();
  const period = Number(params.get('days'));
  const days = [7, 30, 90].includes(period) ? period : 7;
  const query = useQuery({ queryKey: ['jobReport', jobId, days], queryFn: () => api.jobReport(jobId, days), refetchInterval: 60_000 });
  const select = (id: string) => setParams(previous => { const next = new URLSearchParams(previous); next.set('run', id); return next; }, { replace: true });
  const selected = query.data?.sessions.find(item => item.id === params.get('run'))?.id ?? query.data?.sessions[0]?.id;

  return <div className="stack">
    <div className="report-toolbar">
      <div><h2 className="section-title">Отчёт по заданию</h2><p className="section-caption">История, результаты и статистика каждого запуска</p></div>
      <div className="toolbar">
        <div className="segmented" aria-label="Период отчёта">{[7, 30, 90].map(value => <button type="button" key={value} aria-pressed={days === value} onClick={() => setParams(previous => { const next = new URLSearchParams(previous); next.set('days', String(value)); next.delete('run'); return next; }, { replace: true })}>{value} дней</button>)}</div>
        <a className="button button--ghost" href={downloads.jobCsv(jobId, days)}>↓ CSV</a>
        <a className="button" href={downloads.jobHtml(jobId, days)} target="_blank" rel="noreferrer">Отчёт для печати ↗</a>
      </div>
    </div>
    {query.isPending ? <Loader label="Собираем историю задания…" /> : query.isError ? <ErrorBox error={query.error} onRetry={() => query.refetch()} /> : <>
      <ReportMetrics report={query.data} />
      <div className="report-note">{formatDateTime(query.data.period.from)} — {formatDateTime(query.data.period.to)} · Успешность по завершённым запускам. История ограничена сроком хранения на Veeam.</div>
      <Panel title="Длительность запусков" action={<span className="panel__meta">Нажмите на столбец, чтобы открыть запуск</span>}>
        <RunChart sessions={query.data.sessions} selected={selected} onSelect={select} />
      </Panel>
      <div className="run-layout">
        <Panel title={`История · ${query.data.sessions.length}`}>
          <div className="run-list" aria-label="Запуски задания">{query.data.sessions.length ? query.data.sessions.map(item => <button type="button" key={item.id} className={`run-option${selected === item.id ? ' run-option--active' : ''}`} aria-pressed={selected === item.id} onClick={() => select(item.id)}>
            <span className={`status-dot status-dot--${tone(item)}`} /><span><strong>{formatDateTime(item.creationTime)}</strong><span className="run-option__meta">{formatDuration(item.durationSeconds)} · {item.type ?? 'Запуск'}</span></span><span className="run-option__arrow">→</span>
          </button>) : <EmptyState>За выбранный период запусков нет</EmptyState>}</div>
        </Panel>
        {selected ? <RunDetails key={selected} jobId={jobId} sessionId={selected} /> : <Panel title="Детали запуска"><EmptyState>Выберите другой период, чтобы найти запуски</EmptyState></Panel>}
      </div>
    </>}
  </div>;
}

export function ReportMetrics({ report }: { report: JobReport }) {
  const s = report.stats;
  return <div className="tiles report-metrics">
    <Metric label="Всего запусков" value={s.totalRuns} note={`${s.running} сейчас в работе`} />
    <Metric label="Успешность" value={s.successRate === null ? '—' : `${s.successRate}%`} note={`${s.success} успешных запусков`} tone="success" />
    <Metric label="Требуют внимания" value={s.failed + s.warning} note={`${s.failed} ошибок · ${s.warning} предупреждений`} tone={s.failed ? 'failed' : s.warning ? 'warning' : 'neutral'} />
    <Metric label="Средняя длительность" value={formatDuration(s.avgDurationSeconds)} note={`Максимум: ${formatDuration(s.maxDurationSeconds)}`} />
  </div>;
}
function Metric({ label, value, note, tone = 'neutral' }: { label: string; value: string | number; note: string; tone?: string }) {
  return <div className={`tile tile--${tone}`}><span className="tile__label">{label}</span><strong className="tile__value">{value}</strong><span className="tile__note">{note}</span></div>;
}

function RunChart({ sessions, selected, onSelect }: { sessions: SessionSummary[]; selected?: string; onSelect: (id: string) => void }) {
  const items = sessions.slice(0, 60).reverse();
  const max = Math.max(1, ...items.map(item => item.durationSeconds ?? 0));
  if (!items.length) return <EmptyState>График появится после первого запуска в выбранном периоде</EmptyState>;
  return <div className="chart-block"><div className="chart-axis"><span>{formatDuration(max)}</span><span>0</span></div><div className="chart-content"><div className="run-chart" aria-label="Длительность последних 60 запусков">{items.map(item => <button type="button" key={item.id} className={`chart-column chart-column--${tone(item)}${item.id === selected ? ' chart-column--selected' : ''}`} style={{ height: `${Math.max(5, (item.durationSeconds ?? 0) / max * 100)}%` }} title={`${formatDateTime(item.creationTime)} · ${formatDuration(item.durationSeconds)} · ${item.result ?? item.state}`} aria-label={`Запуск ${formatDateTime(item.creationTime)}, ${formatDuration(item.durationSeconds)}, ${item.result ?? item.state}`} aria-pressed={item.id === selected} onClick={() => onSelect(item.id)} />)}</div><div className="chart-labels"><span>{formatDateTime(items[0].creationTime)}</span><span>{sessions.length > 60 ? 'Последние 60 запусков · ' : ''}Цвет — результат запуска</span><span>{formatDateTime(items[items.length - 1].creationTime)}</span></div><div className="chart-legend"><span><i className="status-dot status-dot--success" />Успешно</span><span><i className="status-dot status-dot--warning" />Предупреждение</span><span><i className="status-dot status-dot--failed" />Ошибка</span><span><i className="status-dot status-dot--running" />В работе</span></div></div></div>;
}

function RunDetails({ jobId, sessionId }: { jobId: string; sessionId: string }) {
  const [taskId, setTaskId] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['sessionReport', jobId, sessionId], queryFn: () => api.sessionReport(jobId, sessionId), refetchInterval: 60_000 });
  if (query.isPending) return <Panel title="Детали запуска"><Loader /></Panel>;
  if (query.isError) return <ErrorBox error={query.error} onRetry={() => query.refetch()} />;
  const { session, tasks, logs } = query.data;
  return <div className="stack run-detail">
    <Panel title="Выбранный запуск" action={<a className="link" href={downloads.sessionHtml(jobId, sessionId)} target="_blank" rel="noreferrer">Отчёт запуска ↗</a>}>
      <div className="run-summary"><ResultBadge result={session.result} state={session.state} /><strong>{formatDateTime(session.creationTime)}</strong><span>{formatDuration(session.durationSeconds)}</span></div>
      {session.message && <p className="session-message">{session.message}</p>}
      <div className="run-summary run-summary--secondary"><span>Окончание: {formatDateTime(session.endTime)}</span>{session.progressPercent !== null && <span>Прогресс: {session.progressPercent}%</span>}</div>
    </Panel>
    <Panel title={`Объекты запуска · ${tasks.items.length}`}>
      {tasks.total > tasks.items.length && <p className="report-note">Veeam вернул {tasks.items.length} из {tasks.total} объектов.</p>}
      <SectionBody section={tasks} what="Статистика объектов" empty="Для этого запуска статистика объектов отсутствует">{items => <div className="table-wrap"><table className="table task-table"><thead><tr><th>Объект / результат</th><th>Прочитано / передано</th><th>Длительность / скорость</th><th>Узкое место</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td><button className="text-button" type="button" onClick={() => setTaskId(taskId === item.id ? null : item.id)} aria-expanded={taskId === item.id}>{item.name ?? item.id} ↗</button><div><ResultBadge result={item.result} state={item.state} /></div>{item.message && item.result !== 'Success' && <div className="table__hint">{item.message}</div>}</td><td>{formatBytes(item.readBytes)} / {formatBytes(item.transferredBytes)}<div className="table__hint">Обработано: {formatBytes(item.processedBytes)}</div></td><td>{formatDuration(item.durationSeconds)}<div className="table__hint">{item.processingRate ?? '—'} · {item.algorithm ?? '—'}</div></td><td>{item.bottleneck ?? '—'}</td></tr>)}</tbody></table></div>}</SectionBody>
    </Panel>
    {taskId && <TaskLogs jobId={jobId} sessionId={sessionId} taskId={taskId} name={tasks.items.find(item => item.id === taskId)?.name ?? 'Объект'} onClose={() => setTaskId(null)} />}
    <Panel title="Журнал запуска"><LogList logs={logs} /></Panel>
  </div>;
}

function TaskLogs({ jobId, sessionId, taskId, name, onClose }: { jobId: string; sessionId: string; taskId: string; name: string; onClose: () => void }) {
  const query = useQuery({ queryKey: ['taskLogs', jobId, sessionId, taskId], queryFn: () => api.taskLogs(jobId, sessionId, taskId) });
  return <Panel title={`Журнал объекта · ${name}`} action={<button className="button button--ghost" onClick={onClose}>Закрыть</button>}>{query.isPending ? <Loader /> : query.isError ? <ErrorBox error={query.error} onRetry={() => query.refetch()} /> : <LogList logs={query.data} />}</Panel>;
}
function LogList({ logs }: { logs: LogReport }) {
  return <SectionBody section={logs} what="Журнал" empty="Событий пока нет">{items => <div className="log-list">{logs.total > items.length && <p className="report-note">Показано {items.length} из {logs.total} событий</p>}{items.map(item => <div className={`log-entry log-entry--${item.status?.toLowerCase()}`} key={item.id}><span className="log-entry__status">{item.status === 'Succeeded' ? '✓' : item.status === 'Failed' ? '×' : item.status === 'Warning' ? '!' : '·'}<span className="sr-only">{item.status}</span></span><div><strong>{item.title}</strong>{item.description && <p>{item.description}</p>}</div><time>{formatDateTime(item.startTime)}</time></div>)}</div>}</SectionBody>;
}
