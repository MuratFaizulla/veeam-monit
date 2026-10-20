/**
 * What Veeam's words about a session mean: which machine a message blames,
 * why, and what of it is worth showing anybody.
 *
 * Veeam writes one machine's failure the same way in a task's message, a
 * session's message and a line of a session log, and wraps it in boilerplate:
 * "Processing <machine> Error:", then the reason, then a line repeating the
 * connection parameters — the service account among them — then the agent's
 * call stack in prose. Reading that used to be split between the estate reader
 * (a machine's reason), the job queries (a session's reason against its
 * machines) and each place that showed a session's message, which showed it
 * raw: the run list of a Job card could carry "Logon attempt with parameters
 * […] Login: […]" into the chat. The Job report and its Session report cut
 * Veeam's words by rules of their own after that, and printed a machine's log
 * and a session's message with the parameters in them.
 *
 * Pure, and the one place that knows these words: whatever shows any of
 * them — a line, a reason, a session's message — has it cut here, and the
 * connection parameters are cut from every line.
 */

/**
 * Veeam's ways of writing that one machine went wrong:
 *
 *   Processing APPDB1-T3Q4 Error: Failed to open VDDK disk […]
 *   Failed to create processing task for VM dc02 Error: Failed to retrieve object hierarchy […]
 *   Virtual Machine dc01 is unavailable and will be skipped from processing
 *   Error: Выдано исключение типа "…AgentClosedException".
 *
 * A bare "Processing <machine>" names the machine and gives no reason. Any
 * other text is a reason with no machine named in it.
 */
const MACHINE_LINES: Array<{ pattern: RegExp; reasonIsLine?: boolean }> = [
  { pattern: /^Processing (.+?)(?:\s+Error:\s*([\s\S]*))?$/ },
  { pattern: /^Failed to create processing task for VM (.+?)\s+Error:\s*([\s\S]*)$/ },
  { pattern: /^Virtual Machine (.+?)(?: \([0-9a-f-]{36}\))? is unavailable\b/, reasonIsLine: true },
];

/** Lines of a reason kept; see machineLine. */
const REASON_LINES = 2;

/**
 * "Processing <machine>" before Veeam's verdict on it. A machine's name may
 * hold spaces, "db-01 (4f2e…)": what follows it starts with "Error:" or
 * "Warning:".
 */
const PROCESSING = /^(Processing .+?)\s+(?=(?:Error|Warning):)/;

/**
 * Where Veeam repeats the connection parameters, the service account among
 * them: "Logon attempt with parameters [VC/ESX: [vc01];Port: 443;Login:
 * [svc@example.com];VMX Spec: [moref=vm-31466]]". On a line of its own after
 * the reason, as a rule; see withoutCredentials.
 */
const LOGON = /Logon attempt with parameters/i;

/**
 * The machine one line of Veeam's is about, and the reason it gives.
 *
 * The reason is the first two lines that explain the failure — "Cannot get
 * service content. / Soap fault. Temporary failure in name resolution…" is
 * two, and the second is the one that says DNS. The line that only repeats the
 * connection parameters, service account included, is not one of them, and
 * the rest is the agent's call stack in prose: "Failed to upload disk. /
 * Agent failed to process method {DataTransfer.SyncDisk}."
 */
export const machineLine = (text: string): { machine?: string; reason?: string } => {
  const line = text.trim();
  for (const { pattern, reasonIsLine } of MACHINE_LINES) {
    const found = pattern.exec(line);
    if (found) return { machine: found[1], reason: reasonOf(reasonIsLine ? line : found[2]) };
  }
  return { reason: reasonOf(line.replace(/^Error:\s*/, '')) };
};

/**
 * A session's message as it is worth showing, or nothing when it is empty:
 *
 *   APPDB1-T3Q4 — Failed to open VDDK disk […] ( is read-only mode - [true] ) / Failed to open disk for read.
 *   Processing APPDB1-T3Q4
 *   Virtual Machine CORE-DBS03 (…) is unavailable and will be skipped from processing
 *
 * A machine and its reason read as one; a name with no reason stays as Veeam
 * wrote it, since "Processing" is what says the name is a machine; any other
 * message loses the boilerplate a reason loses.
 */
export const sessionText = (message: string | undefined): string | undefined => {
  const text = message?.trim();
  if (!text) return undefined;
  const { machine, reason } = machineLine(text);
  // "Virtual Machine X is unavailable…" is its own reason and names its
  // machine already; a reason taken from after "Error:" does not — even when
  // the disk path in it happens to spell the machine's name.
  const whole = reason !== undefined && text.startsWith(reason.split(' / ')[0]);
  if (machine && reason) return whole ? reason : `${machine} — ${reason}`;
  return reason ?? linesOf(text)[0];
};

/**
 * The machine a session's message blames, and why — only when it says both.
 * A session names one of its machines when the whole run stopped on it, and
 * then its message is often the better reason: the machine's own task may say
 * no more than the step it stopped at, "Getting VM info from vSphere".
 */
export const blameOf = (message: string | undefined): { machine: string; reason: string } | undefined => {
  const { machine, reason } = machineLine(message ?? '');
  return machine && reason ? { machine, reason } : undefined;
};

/**
 * What Veeam said, one line worth reading, without the machine it is about —
 * which whoever shows it names already: no "Processing <machine>", no
 * "Error:", its first line. What the Job report says of a machine, and groups
 * its errors by.
 */
export const saidOf = (message: string | null | undefined): string =>
  linesOf(
    String(message ?? '')
      .replace(PROCESSING, '')
      .replace(/^Processing \S+\s*/, '')
      .replace(/^Error:\s*/, ''),
  )[0] ?? '';

/**
 * A session's message a line each, as Veeam's own report prints it:
 * "Processing <machine>" on one line, and what Veeam said of it on the next.
 */
export const sessionLines = (message: string | null | undefined): string[] =>
  linesOf(String(message ?? '').replace(PROCESSING, '$1\n'));

/**
 * Veeam's words a line each, as worth showing: spaces run together, no blank
 * line, and never the connection parameters. What a machine's log reads as in
 * the Session report, and what every shorter reading here starts from.
 */
export const linesOf = (text: string | null | undefined): string[] =>
  String(text ?? '')
    .split(/\r?\n/)
    .map((line) => withoutCredentials(line).replace(/\s+/g, ' ').trim())
    .filter(Boolean);

/**
 * A line without the connection parameters, wherever in it Veeam put them:
 * from "Logon attempt with parameters" to the bracket that closes their list,
 * or to the end of the line when none does. A line that was nothing else
 * comes out empty.
 */
const withoutCredentials = (line: string): string => {
  const kept: string[] = [];
  let rest = line;
  for (let at = rest.search(LOGON); at >= 0; at = rest.search(LOGON)) {
    kept.push(rest.slice(0, at));
    rest = rest.slice(pastList(rest, at));
  }
  return kept.length ? [...kept, rest].join(' ').trim() : line;
};

/** Past the bracketed list that follows `from`, its brackets within it counted; the end of `text` when it does not close. */
const pastList = (text: string, from: number): number => {
  const open = text.indexOf('[', from);
  if (open < 0) return text.length;
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '[') depth += 1;
    if (text[index] === ']' && --depth === 0) return index + 1;
  }
  return text.length;
};

const reasonOf = (text: string | undefined): string | undefined =>
  linesOf(text).slice(0, REASON_LINES).join(' / ') || undefined;
