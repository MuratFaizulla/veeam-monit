import { JobStatus } from '../jobs/jobs.model';
import { csvDateTime } from './csv';
import { ReportSummary, STATUS_LABELS } from './reports.service';

/** Minimal HTML escaping — every value here comes from Veeam object names. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds} с`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
}

/**
 * A self-contained, print-ready report. The browser's "Print -> Save as PDF"
 * turns it into a PDF without a PDF library on the server.
 */
export function renderSummaryHtml(summary: ReportSummary): string {
  const statusRows = (Object.entries(summary.jobs.byStatus) as Array<[JobStatus, number]>)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `<tr><td>${esc(STATUS_LABELS[status])}</td><td>${count}</td></tr>`)
    .join('');

  const worstRows =
    summary.worstJobs.length === 0
      ? '<tr><td colspan="5">Проблемных заданий за период нет</td></tr>'
      : summary.worstJobs
          .map(
            (job) => `<tr>
        <td>${esc(job.name)}</td>
        <td class="num">${job.failed}</td>
        <td class="num">${job.warning}</td>
        <td class="num">${job.success}</td>
        <td class="num">${job.successRate === null ? '—' : `${job.successRate}%`}</td>
      </tr>`,
          )
          .join('');

  const repoRows =
    summary.repositories.lowOnSpace.length === 0
      ? '<tr><td colspan="4">Репозиториев с заполнением выше 80% нет</td></tr>'
      : summary.repositories.lowOnSpace
          .map(
            (repository) => `<tr>
        <td>${esc(repository.name)}</td>
        <td class="num">${repository.usedPercent ?? '—'}%</td>
        <td class="num">${repository.freeGB === null ? '—' : Math.round(repository.freeGB)}</td>
        <td class="num">${repository.capacityGB === null ? '—' : Math.round(repository.capacityGB)}</td>
      </tr>`,
          )
          .join('');

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Отчёт Veeam — ${esc(csvDateTime(summary.generatedAt))}</title>
<style>
  body { font: 13px/1.5 "Segoe UI", Arial, sans-serif; color: #14181d; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .05em; color: #5b6670;
       margin: 28px 0 8px; }
  .meta { color: #5b6670; margin-bottom: 24px; }
  .tiles { display: flex; gap: 12px; flex-wrap: wrap; }
  .tile { border: 1px solid #d8dde2; border-radius: 8px; padding: 10px 14px; min-width: 130px; }
  .tile b { display: block; font-size: 22px; }
  .tile span { color: #5b6670; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; }
  th, td { border-bottom: 1px solid #e3e7ea; padding: 6px 10px; text-align: left; }
  th { color: #5b6670; font-weight: 600; }
  .num { text-align: right; }
  footer { margin-top: 32px; color: #8a939c; font-size: 11px; }
  @media print { body { margin: 0; } .noprint { display: none; } }
</style>
</head>
<body>
  <h1>Отчёт Veeam Backup &amp; Replication</h1>
  <p class="meta">
    Сформирован: ${esc(csvDateTime(summary.generatedAt))} · период: последние ${summary.periodDays} дн.
  </p>

  <button class="noprint" onclick="window.print()">Печать / сохранить в PDF</button>

  <h2>Задания</h2>
  <div class="tiles">
    <div class="tile"><b>${summary.jobs.total}</b><span>всего заданий</span></div>
    <div class="tile"><b>${summary.jobs.successRate === null ? '—' : `${summary.jobs.successRate}%`}</b><span>успешных (по последнему запуску)</span></div>
    <div class="tile"><b>${summary.runs.totalRuns}</b><span>запусков за период</span></div>
    <div class="tile"><b>${summary.runs.failed}</b><span>с ошибкой</span></div>
    <div class="tile"><b>${summary.runs.warning}</b><span>с предупреждением</span></div>
    <div class="tile"><b>${duration(summary.runs.avgDurationSeconds)}</b><span>средняя длительность</span></div>
  </div>

  <table>
    <thead><tr><th>Статус</th><th>Заданий</th></tr></thead>
    <tbody>${statusRows}</tbody>
  </table>

  <h2>Проблемные задания за период</h2>
  <table>
    <thead><tr><th>Задание</th><th class="num">Ошибок</th><th class="num">Предупр.</th><th class="num">Успешно</th><th class="num">Успешность</th></tr></thead>
    <tbody>${worstRows}</tbody>
  </table>

  <h2>Репозитории с заполнением выше 80%</h2>
  <table>
    <thead><tr><th>Репозиторий</th><th class="num">Занято</th><th class="num">Свободно, ГБ</th><th class="num">Ёмкость, ГБ</th></tr></thead>
    <tbody>${repoRows}</tbody>
  </table>

  <footer>
    Данные получены из Veeam Backup &amp; Replication REST API в режиме только чтение.
    Длительность и успешность посчитаны по сессиям за указанный период.
  </footer>
</body>
</html>`;
}
