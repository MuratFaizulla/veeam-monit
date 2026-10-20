import { escapeHtml as esc } from '../telegram/format';
import { envelope, ReportDocument } from './report-envelope';
import { SessionBlock, SessionMachine, SessionReport, SessionStatus } from './session-report';

/**
 * The Session report: Veeam's own session report, block for block — the
 * header coloured by the result, the day, the three rows of numbers with
 * what Veeam said beside them, and the machines under «Details». Veeam's
 * words, Veeam's colours, its English.
 *
 * `sessionsHtml` is the part the Job report prints after its first page, on
 * pages of its own with margins (`SESSION_STYLE` keeps to them);
 * `sessionReportPage` is the same as a document by itself.
 */
export const sessionReportPage = (report: SessionReport, timezone: string): ReportDocument =>
  envelope({ lang: 'en', title: `${report.name} — sessions`, style: SESSION_STYLE, body: sessionsHtml(report, timezone) });

export const sessionsHtml = (report: SessionReport, timezone: string): string => {
  const view: View = { report, timezone };
  const first = report.sessions.at(-1)?.start;
  const period = first === undefined ? '' : `${dateOf(first, timezone)} – ${dateOf(report.at, timezone)}`;
  const top = `<div class="vt"><div><b>${esc(report.name)}</b> · ${esc(report.server)}${period ? ` · ${period}` : ''}</div><div>${report.sessions.length} ${report.sessions.length === 1 ? 'session' : 'sessions'} in ${report.days} days</div></div>`;
  const blocks = report.sessions.length ? report.sessions.map((session) => block(view, session)).join('\n') : `<div class="empty">No sessions in the last ${report.days} days.</div>`;
  const foot = `<div class="vf">Read from ${esc(report.server)} on ${esc(clockOf(report.at, timezone))} · newest first</div>`;
  return `<div class="vr">${top}${blocks}${foot}</div>`;
};

interface View {
  report: SessionReport;
  timezone: string;
}

const TONE: Record<SessionStatus, string> = { Success: 'ok', Warning: 'warn', Error: 'bad', 'In progress': 'run', Pending: 'run' };

const block = ({ report, timezone }: View, session: SessionBlock): string => {
  // Veeam counts whole days since the session started, not midnights: 21:48 to 19:41 two days on is "(+1)".
  const shift = (at: number | undefined) => {
    if (at === undefined) return '';
    const days = Math.floor((at - session.start) / 86_400_000);
    return `${timeOf(at, timezone)}${days > 0 ? ` (+${days})` : ''}`;
  };
  const machines = session.machines
    ? session.machines.length
      ? session.machines.map((machine) => machineRow(machine, shift)).join('')
      : '<tr><td colspan="9" class="dim">No machines were processed.</td></tr>'
    : '<tr><td colspan="9" class="dim">Machines of this session were not read.</td></tr>';
  const minutes = session.end !== undefined ? (session.end - session.start) / 60_000 : (report.at - session.start) / 60_000;
  const processed = session.of !== undefined ? `${session.processed} of ${session.of} VMs processed` : '';
  return `<div class="vb">
  <table class="vh ${TONE[session.status]}"><tr><td class="vh-t">${esc(report.kind)}: ${esc(session.title)}${report.description ? `<div class="vh-d">${esc(report.description)}</div>` : ''}</td><td class="vh-s">${esc(session.status)}<div class="vh-d">${processed}</div></td></tr></table>
  <table class="vi">
    <colgroup><col class="c1"><col class="cv"><col class="cv"><col class="cv"><col class="cv"><col class="cv"><col class="cv"><col class="cv"><col></colgroup>
    <tbody class="keep">
    <tr><td colspan="9" class="vd">${esc(longDateOf(session.start, timezone))}</td></tr>
    <tr><td class="k">Success</td><td>${session.counts.success}</td><td class="k">Start time</td><td>${timeOf(session.start, timezone)}</td><td class="k">Total size</td><td>${veeamSize(session.totalSize)}</td><td class="k">Backup size</td><td>${veeamSize(session.backupSize)}</td><td rowspan="3" class="note">${session.notes.map(esc).join('<br>') || '&nbsp;'}</td></tr>
    <tr><td class="k">Warning</td><td>${session.counts.warning}</td><td class="k">End time</td><td>${session.end !== undefined ? shift(session.end) : '—'}</td><td class="k">Data read</td><td>${veeamSize(session.read)}</td><td class="k">Dedupe</td><td>${ratioOf(session.dedupe)}</td></tr>
    <tr><td class="k">Error</td><td>${session.counts.error}</td><td class="k">Duration</td><td>${veeamDuration(minutes)}</td><td class="k">Transferred</td><td>${veeamSize(session.transferred)}</td><td class="k">Compression</td><td>${ratioOf(session.compression)}</td></tr>
    <tr><td colspan="9" class="vd">Details</td></tr>
    <tr class="th"><td>Name</td><td>Status</td><td>Start time</td><td>End time</td><td>Size</td><td>Read</td><td>Transferred</td><td>Duration</td><td>Details</td></tr>
    </tbody>
    <tbody>${machines}</tbody>
  </table>
</div>`;
};

const machineRow = (machine: SessionMachine, shift: (at: number | undefined) => string): string =>
  `<tr><td class="vm">${esc(machine.name)}</td><td class="nw"><span class="st ${TONE[machine.status]}">${esc(machine.status)}</span></td><td class="nw">${shift(machine.start) || '—'}</td><td class="nw">${shift(machine.end) || '—'}</td><td class="nw">${veeamSize(machine.size)}</td><td class="nw">${veeamSize(machine.read)}</td><td class="nw">${veeamSize(machine.transferred)}</td><td class="nw">${machine.minutes !== undefined ? veeamDuration(machine.minutes) : '—'}</td><td class="note">${machine.details.map(esc).join('<br>') || '&nbsp;'}</td></tr>`;

/* ------------------------------------------------------------------ *
 * Veeam's ways of writing things
 * ------------------------------------------------------------------ */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** "40.3 TB", "9 TB", "0 B": one decimal, none when it is nought, in units of 1024. */
export const veeamSize = (bytes: number | undefined): string => {
  if (bytes === undefined) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit ? (Math.round(value * 10) / 10).toString() : String(Math.round(value));
  return `${shown} ${UNITS[unit]}`;
};

/** "1.4x". */
const ratioOf = (ratio: number | undefined): string => (ratio === undefined ? '—' : `${ratio.toFixed(1)}x`);

/** "45:53:02": hours past a day go on counting. */
export const veeamDuration = (minutes: number): string => {
  // Whole seconds, the part of one dropped, as Veeam does.
  const seconds = Math.max(0, Math.floor(minutes * 60 + 1e-6));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
};

/** Newer ICU puts a narrow no-break space before PM and "at" before the time; Veeam has neither. */
const plain = (text: string) => text.replace(/[  ]/g, ' ').replace(' at ', ' ');

/** "9:48:48 PM". */
const timeOf = (at: number, timezone: string): string =>
  plain(new Intl.DateTimeFormat('en-US', { timeZone: timezone || undefined, hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(at)));

/** "Friday, October 16, 2026 9:48:48 PM". */
const longDateOf = (at: number, timezone: string): string =>
  plain(new Intl.DateTimeFormat('en-US', { timeZone: timezone || undefined, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(at)));

/** "10/16/2026". */
const dateOf = (at: number, timezone: string): string =>
  new Intl.DateTimeFormat('en-US', { timeZone: timezone || undefined, month: 'numeric', day: 'numeric', year: 'numeric' }).format(new Date(at));

/** "10/19/2026 10:40 AM". */
const clockOf = (at: number, timezone: string): string =>
  plain(new Intl.DateTimeFormat('en-US', { timeZone: timezone || undefined, month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(at))).replace(',', '');

/* ------------------------------------------------------------------ *
 * Veeam's look: its colours, its grey rules, its bold labels
 * ------------------------------------------------------------------ */

/**
 * Everything under `.vr`, so that it can share a document with the Job
 * report's first page, whose pages have no margins of their own: the
 * sessions go on pages named `sessions`, which have.
 */
export const SESSION_STYLE = `
@page sessions { size: 297mm 210mm; margin: 9mm 10mm; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.vr { page: sessions; font-family: 'Inter Variable', Tahoma, sans-serif; font-size: 7.9pt; line-height: 1.3; color: #000; background: #fff; }
.vr * { box-sizing: border-box; margin: 0; padding: 0; }
.vr .vt, .vr .vf { display: flex; justify-content: space-between; color: #626365; font-size: 7.6pt; }
.vr .vt { margin-bottom: 3mm; }
.vr .vt b { color: #000; }
.vr .vf { margin-top: 2mm; }
.vr .empty { color: #626365; font-size: 10pt; padding: 10mm 0; }
.vr .vb { margin-bottom: 5mm; }
.vr table { width: 100%; border-collapse: collapse; }
.vr .vh { break-after: avoid; }
.vr .vh td { color: #fff; font-weight: 700; font-size: 11pt; height: 15mm; vertical-align: bottom; padding: 0 0 3.4mm 3.6mm; }
.vr .vh-t { width: 80%; }
.vr .vh-d { font-size: 7.9pt; margin-top: 1mm; }
.vr .vh.ok td { background: #00b050; }
.vr .vh.warn td { background: #ffd96c; }
.vr .vh.bad td { background: #fb9895; }
.vr .vh.run td { background: #7ea7d0; }
.vr .vi { table-layout: auto; }
.vr .vi col.c1 { width: 46mm; }
.vr .vi col.cv { width: 21mm; }
.vr .vi td { border: 0.25mm solid #a7a9ac; padding: 0.5mm 0.8mm; vertical-align: top; }
.vr .vi tbody.keep { break-inside: avoid; }
.vr .vi tbody.keep td:not(.note):not(.vd) { white-space: nowrap; }
.vr .vi tr { break-inside: avoid; }
.vr .vi td.vd { height: 8mm; background: #f3f4f4; color: #626365; font-size: 11pt; vertical-align: middle; padding: 1mm 0 0 3.6mm; }
.vr .k { font-weight: 700; white-space: nowrap; }
.vr .th td { background: #e3e3e3; font-weight: 700; border-top: none; white-space: nowrap; }
.vr .nw { white-space: nowrap; }
.vr .vm { word-break: break-word; }
.vr .note { font-size: 6.6pt; word-break: break-word; }
.vr .dim { color: #626365; }
.vr .st.ok { color: #00b050; }
.vr .st.warn { color: #d9a300; }
.vr .st.bad { color: #ff0000; }
.vr .st.run { color: #2f6fb0; }
`;
