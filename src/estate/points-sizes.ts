import { VeeamBackupFile } from '../veeam/types';
import { RetainedRun } from './evidence';

/**
 * What a job's restore points take up, as its backup files say.
 *
 * Whether a weekly Active Full is worth it is a question of terabytes: on
 * OPS_Exchange every run is a Full of 15.9 TB read from production and 7.8 TB
 * written, where an increment of OPS_vCloud_edge is a fifth of its Full. A
 * point carries no size; the file holding it does, and names the points it
 * holds, which is how each file is put in the run that wrote it.
 */

/** One run's files, added up. */
export interface RunSize {
  /** Bytes of the machines' data the run covered, before compression. */
  data: number;
  /** Bytes its files take up on the repository. */
  disk: number;
}

export interface PointSizes {
  /** Every file of the job: what its points take up altogether. */
  onDisk: number;
  /** The newest Full that has written its data, and when it began. */
  full?: RunSize & { at: number };
  /** When a newer Full began whose files hold nothing yet: it is still being written. */
  fullWriting?: number;
  /**
   * A typical increment: the median of the retained runs that wrote one. The
   * mean is the wrong question here — CUST_ERP_ISMR writes about 100 GB a
   * night, and the 1.3 TB of the night after its Full made its mean 407.
   */
  increment?: RunSize & { runs: number };
}

/** Undefined when the job has no files to say anything with. */
export const sizesOf = (files: VeeamBackupFile[], runs: RetainedRun[]): PointSizes | undefined => {
  if (files.length === 0) return undefined;
  const runOfPoint = new Map<string, RetainedRun>();
  for (const run of runs) for (const id of run.pointIds) runOfPoint.set(id, run);

  // A file whose points the scan does not know — written since, or by a run
  // whose points were set aside — still takes up its space, and is counted in
  // the total only.
  const byRun = new Map<RetainedRun, RunSize>();
  let onDisk = 0;
  for (const file of files) {
    onDisk += file.backupSize ?? 0;
    const run = (file.restorePointIds ?? []).map((id) => runOfPoint.get(id)).find(Boolean);
    if (!run) continue;
    const size = byRun.get(run) ?? { data: 0, disk: 0 };
    size.data += file.dataSize ?? 0;
    size.disk += file.backupSize ?? 0;
    byRun.set(run, size);
  }

  const written = (full: boolean) =>
    [...byRun].filter(([run, size]) => run.full === full && size.data > 0).sort(([a], [b]) => b.at - a.at);
  const [newestFull] = written(true);
  const increments = written(false);
  // Said only of a Full whose file is there and empty, as OPS_Exchange's was
  // on the morning of 5 October: a Full with no file found is a Full whose
  // file was not told apart, not one being written.
  const lastFull = runs.filter((run) => run.full).sort((a, b) => b.at - a.at)[0];
  const writing = lastFull !== undefined && byRun.get(lastFull)?.data === 0;

  return {
    onDisk,
    ...(newestFull ? { full: { ...newestFull[1], at: newestFull[0].at } } : {}),
    ...(writing ? { fullWriting: lastFull.at } : {}),
    ...(increments.length > 0
      ? {
          increment: {
            data: median(increments.map(([, size]) => size.data)),
            disk: median(increments.map(([, size]) => size.disk)),
            runs: increments.length,
          },
        }
      : {}),
  };
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
