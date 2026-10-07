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
 * […] Login: […]" into the chat.
 *
 * Pure, and the one place that knows these words.
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
  return reason ?? text.split(/\r?\n/)[0].trim();
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

const reasonOf = (text: string | undefined): string | undefined =>
  (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^Logon attempt with parameters/.test(line))
    .slice(0, REASON_LINES)
    .join(' / ') || undefined;
