import { JobReport, SessionReport } from './job-report.model';
import { SessionSummary } from './jobs.model';
import { toCsv } from '../reports/csv';

export function jobReportCsv(report: JobReport): string {
  return toCsv(report.sessions, [
    { header: 'Задание', value: () => report.job.name },
    { header: 'Период с (UTC)', value: () => report.period.from },
    { header: 'Период по (UTC)', value: () => report.period.to },
    { header: 'ID запуска', value: item => item.id },
    { header: 'Начало (UTC)', value: item => utc(item.creationTime) },
    { header: 'Окончание (UTC)', value: item => utc(item.endTime) },
    { header: 'Результат', value: item => result(item) },
    { header: 'Длительность, с', value: item => item.durationSeconds },
    { header: 'Сообщение', value: item => item.message },
  ]);
}

const esc = (value: unknown) => String(value ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const utc = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const date = (value: string | null) => utc(value)?.replace('T', ' ').replace(/\.\d+Z$/, ' UTC') ?? '—';
const duration = (value: number | null) => value === null ? '—' : `${Math.floor(value / 60)} мин ${value % 60} с`;
const bytes = (value: number | null) => value === null ? '—' : `${(value / 1073741824).toFixed(2)} ГиБ`;
function result(item: SessionSummary): string {
  if (item.state && !['stopped', 'idle'].includes(item.state.toLowerCase())) return 'Выполняется';
  return ({ Success: 'Успешно', Warning: 'Предупреждение', Failed: 'Ошибка', None: 'Нет результата' } as Record<string, string>)[item.result ?? ''] ?? item.result ?? 'Нет результата';
}
const table = (headers: string[], rows: unknown[][]) => `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}">Данных за период нет</td></tr>`}</tbody></table></div>`;
function document(title: string, subtitle: string, body: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
  *{box-sizing:border-box}body{font:14px/1.6 system-ui,sans-serif;color:#182b3c;background:#f3f6f9;margin:0;padding:40px}main{max-width:1200px;margin:auto;background:white;padding:36px;border-radius:18px}h1{font-size:28px;overflow-wrap:anywhere;margin:12px 0}h2{font-size:18px;margin-top:32px}.brand{font-weight:700;letter-spacing:2px;color:#087b5a}p{color:#536778}.metrics{display:flex;flex-wrap:wrap;gap:16px;margin:28px 0}.metric{padding:16px;background:#f0f8f5;border:1px solid #dbe9e2;border-radius:10px;flex:1;min-width:140px}.metric strong{display:block;font-size:26px;color:#116348}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:10px;text-align:left;border-bottom:1px solid #dfe7ed;vertical-align:top;overflow-wrap:anywhere}th{background:#eff4f7}footer{margin-top:32px;color:#657889;font-size:12px}@media print{body{background:white;padding:0}main{padding:0}h2,tr,.metric{break-inside:avoid}thead{display:table-header-group}.table-wrap{overflow:visible}table{font-size:10px}.print-hint{display:none}}@page{size:A4 landscape;margin:14mm}</style></head><body><main><div class="brand">VEEAM · ОТЧЁТ</div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p><p class="print-hint">Для сохранения в PDF используйте «Печать → Сохранить как PDF» в браузере.</p>${body}<footer>Сформировано приложением из Veeam Backup & Replication REST API 1.2-rev1. Доступная история зависит от хранения сессий на сервере.</footer></main></body></html>`;
}

export function jobReportHtml(report: JobReport): string {
  const s = report.stats;
  const metrics = [['Запусков', s.totalRuns], ['Успешность', s.successRate === null ? '—' : `${s.successRate}%`], ['Ошибок', s.failed], ['Предупреждений', s.warning], ['Средняя длительность', duration(s.avgDurationSeconds)]];
  return document(report.job.name, `${date(report.period.from)} — ${date(report.period.to)} · ${report.period.days} дн.`,
    `<div class="metrics">${metrics.map(([label, value]) => `<div class="metric">${esc(label)}<strong>${esc(value)}</strong></div>`).join('')}</div><p>Успешность рассчитана по завершённым запускам с результатом Success, Warning или Failed. Запусков в работе: ${s.running}.</p><h2>История запусков</h2>` +
    table(['Начало', 'Окончание', 'Результат', 'Длительность', 'Сообщение'], report.sessions.map(item => [date(item.creationTime), date(item.endTime), result(item), duration(item.durationSeconds), item.message])));
}

export function sessionReportHtml(report: SessionReport): string {
  const tasks = report.tasks.available ? table(['Объект', 'Результат', 'Длительность', 'Обработано', 'Прочитано', 'Передано', 'Скорость (Veeam)', 'Узкое место'],
    report.tasks.items.map(item => [item.name, result(item), duration(item.durationSeconds), bytes(item.processedBytes), bytes(item.readBytes), bytes(item.transferredBytes), item.processingRate, item.bottleneck])) : '<p>Статистика объектов недоступна для этой роли или типа запуска.</p>';
  const logs = report.logs.available ? table(['Время', 'Статус', 'Событие', 'Описание'], report.logs.items.map(item => [date(item.startTime), item.status, item.title, item.description])) : '<p>Журнал недоступен.</p>';
  return document(report.session.name ?? 'Отчёт запуска', `${date(report.session.creationTime)} · ${result(report.session)} · ${duration(report.session.durationSeconds)}`,
    `<h2>Объекты запуска (${report.tasks.items.length} из ${report.tasks.total})</h2>${tasks}<h2>Журнал (${report.logs.items.length} из ${report.logs.total})</h2>${logs}`);
}
