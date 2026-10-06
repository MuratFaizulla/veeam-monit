import { VeeamTaskSession } from '../veeam/types';

/**
 * How fast one run went and what held it back: the ⚡ block of the job card.
 *
 * Veeam's console says it per session — "Primary bottleneck: Target" — and on
 * 2 October that was the whole of what anyone had: fifty jobs every weekend
 * running into Wednesday, and Source and Target both blamed by turns. What
 * settled it was further down the logs. Each machine's names the proxy and
 * the transport mode of every disk, and OPS_Exchange's said its 15.5 TB Full
 * had been read over NBD by "VMware Backup Proxy" — the Veeam server itself —
 * for five and a half days, because the five proxies of the cluster were
 * disabled. That is what this reads, for one run of one job, when somebody
 * asks about the job.
 *
 * Read on demand only, never by a cycle: the session's log and task list, then
 * the logs of its longest machines, at most `MACHINE_LOGS` of them.
 */

/** Machines whose own logs are read, the longest first. Billing_Prod, among the largest, has 23. */
export const MACHINE_LOGS = 30;

/** Veeam's four stages, each as busy as it was, in per cent. */
export interface Load {
  source: number;
  proxy: number;
  network: number;
  target: number;
}

export type Stage = keyof Load;

export interface MachineTime {
  name: string;
  ms: number;
}

/** One run, as fast as it went. */
export interface RunSpeed {
  /** When the attempt began, epoch ms. */
  startedAt: number;
  /** How long it took, ms; absent when Veeam's times did not say. */
  took?: number;
  /** Machines that took a Full and that took an increment. */
  fulls: number;
  increments: number;
  /** Bytes read from the machines, and sent on to the repository. Absent when they could not be added up. */
  read?: number;
  transferred?: number;
  /** How busy each stage was across the run, and the one Veeam blamed. */
  load?: Load;
  bottleneck?: Stage;
  /** Disks read, by transport mode as Veeam writes it: `nbd`, `hotadd`, `san`, `nfs`. */
  modes: Map<string, number>;
  /** The proxies that read the disks, and the gateways that wrote the repository. */
  proxies: string[];
  gateways: string[];
  /** The machines that took longest, longest first. */
  slowest: MachineTime[];
  /** Machines in the run, and how many of their logs were read. */
  machines: number;
  logged: number;
}

/** What `speedOf` is given: one attempt and everything Veeam wrote about it. */
export interface RunRecord {
  startedAt?: string;
  endedAt?: string;
  /** Titles of the session's own log. */
  log: string[];
  tasks: VeeamTaskSession[];
  /** Titles of each machine's log that was read, by task id. */
  machineLogs: ReadonlyMap<string, string[]>;
  /**
   * A vCloud backup: every machine is processed inside a task for its vApp,
   * which reports the machines' bytes over again.
   */
  cloud: boolean;
}

const LOAD = /(?:Load|Busy): Source (\d+)% > Proxy (\d+)% > Network (\d+)% > Target (\d+)%/;
const PRIMARY = /Primary bottleneck: (\w+)/;
const DISK = /^Using backup proxy (.+) for disk .+ \[(\w+)\]$/;
const GATEWAY = /^Using gateway (\S+) for repository /;
/** The lines only a vApp's own task writes. */
const VAPP = /^(vApp processing started|Waiting for all VM backup tasks)/;
const OWNER = /^VM owner: (.+)$/;
const STAGES: readonly Stage[] = ['source', 'proxy', 'network', 'target'];

/** The longest of a session's tasks first: the ones whose logs are worth reading. */
export const byLongest = (a: VeeamTaskSession, b: VeeamTaskSession): number =>
  (taskMs(b) ?? -1) - (taskMs(a) ?? -1);

/**
 * The run, or nothing when Veeam has nothing to say about its speed — a run
 * that never reached a machine reads 0 bytes and blames no stage.
 */
export const speedOf = (run: RunRecord): RunSpeed | undefined => {
  const startedAt = Date.parse(run.startedAt ?? '');
  if (!Number.isFinite(startedAt)) return undefined;
  const endedAt = Date.parse(run.endedAt ?? '');

  // A vApp's task is told apart by its log, or by a machine's naming it its owner.
  const owners = new Set([...run.machineLogs.values()].flatMap((log) => log.flatMap((line) => OWNER.exec(line)?.[1] ?? [])));
  const isVapp = (task: VeeamTaskSession): boolean =>
    Boolean(task.name && owners.has(task.name)) || (run.machineLogs.get(task.id ?? '') ?? []).some((line) => VAPP.test(line));
  const vapps = run.tasks.filter(isVapp);
  const machines = run.tasks.filter((task) => !isVapp(task));

  const load = loadOf(run.log);
  const bottleneck = bottleneckOf(run.log) ?? (load ? busiest(load) : undefined);
  const read = sum(machines, 'readSize');
  const transferred = sum(machines, 'transferredSize');
  if (!load && !bottleneck && !read) return undefined;

  // A vApp's bytes are its machines' again. Where one was not recognised the
  // sum would count some machines twice, so it is not given at all.
  const counted = !run.cloud || Math.abs((sum(vapps, 'readSize') ?? 0) - (read ?? 0)) <= 0.02 * (read ?? 0);

  const logs = machines.flatMap((task) => run.machineLogs.get(task.id ?? '') ?? []);
  const modes = new Map<string, number>();
  const proxies = new Set<string>();
  for (const line of logs) {
    const disk = DISK.exec(line);
    if (!disk) continue;
    proxies.add(disk[1]);
    modes.set(disk[2].toLowerCase(), (modes.get(disk[2].toLowerCase()) ?? 0) + 1);
  }
  const gateways = new Set(logs.flatMap((line) => GATEWAY.exec(line)?.[1] ?? []));

  return {
    startedAt,
    took: Number.isFinite(endedAt) && endedAt >= startedAt ? endedAt - startedAt : undefined,
    fulls: machines.filter((task) => task.algorithm?.toLowerCase() === 'full').length,
    increments: machines.filter((task) => task.algorithm?.toLowerCase() === 'increment').length,
    read: counted ? read : undefined,
    transferred: counted ? transferred : undefined,
    load,
    bottleneck,
    modes,
    proxies: [...proxies],
    gateways: [...gateways],
    slowest: machines
      .flatMap((task) => {
        const ms = taskMs(task);
        return task.name && ms !== undefined ? [{ name: task.name, ms }] : [];
      })
      .sort((a, b) => b.ms - a.ms),
    machines: machines.length,
    logged: machines.filter((task) => run.machineLogs.has(task.id ?? '')).length,
  };
};

const loadOf = (log: string[]): Load | undefined => {
  // The last one written: a session that was retried within itself says it again at the end.
  const match = [...log].reverse().map((line) => LOAD.exec(line)).find(Boolean);
  if (!match) return undefined;
  const [source, proxy, network, target] = match.slice(1).map(Number);
  return { source, proxy, network, target };
};

const bottleneckOf = (log: string[]): Stage | undefined => {
  const named = [...log].reverse().map((line) => PRIMARY.exec(line)?.[1]?.toLowerCase()).find(Boolean);
  return STAGES.find((stage) => stage === named);
};

const busiest = (load: Load): Stage => STAGES.reduce((best, stage) => (load[stage] > load[best] ? stage : best));

const sum = (tasks: VeeamTaskSession[], key: 'readSize' | 'transferredSize'): number | undefined => {
  const values = tasks.map((task) => task.progress?.[key]).filter((value): value is number => Number.isFinite(value));
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) : undefined;
};

/**
 * How long one machine took: Veeam's own "04:40:31" or "1.02:03:04", else the
 * span between its times, which carry no offset but share one.
 */
const taskMs = (task: VeeamTaskSession): number | undefined => {
  const spelled = /^(?:(\d+)\.)?(\d+):(\d{2}):(\d{2})/.exec(task.progress?.duration ?? '');
  if (spelled) {
    const [days, hours, minutes, seconds] = spelled.slice(1).map((part) => Number(part ?? 0));
    return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  }
  const span = Date.parse(task.endTime ?? '') - Date.parse(task.creationTime ?? '');
  return Number.isFinite(span) && span >= 0 ? span : undefined;
};
