/**
 * Runs an alert has announced as failed while Veeam still had attempts left.
 *
 * What the monitor needs to say how the run ended. A failure is announced
 * when the job's result changes, which is after its first attempt; the
 * retries after it leave the result at "failed" and change nothing the job
 * list shows. So the run is followed here from the first alert until Veeam
 * either stops trying — which is announced — or the job's result changes,
 * which the ordinary alert already says.
 *
 * Kept in the state file: a restart between two attempts would otherwise
 * forget the run, and the one message that says "no more attempts" with it.
 */
export interface RetryingRun {
  /** Attempts seen so far. */
  attempt: number;
  /**
   * The job's last run as its state reported it when last looked at. Veeam
   * moves it when another attempt starts, which is when the run is worth
   * reading again; until then it costs nothing to follow.
   */
  lastRun?: string;
  /** Epoch ms after which Veeam has let its chance to retry pass. */
  retryBy: number;
}

/** Holds one server's part of the state and calls `save` after each change, like JobResults. */
export class RetryingRuns {
  constructor(
    private readonly byJob: Record<string, RetryingRun>,
    private readonly save: () => void,
  ) {}

  of(jobId: string): RetryingRun | undefined {
    return this.byJob[jobId];
  }

  follow(jobId: string, run: RetryingRun): void {
    this.byJob[jobId] = run;
    this.save();
  }

  forget(jobId: string): void {
    if (!(jobId in this.byJob)) return;
    delete this.byJob[jobId];
    this.save();
  }

  /** Jobs deleted in Veeam must not keep a slot in the file forever. */
  keepOnly(liveIds: Set<string | undefined>): void {
    let changed = false;
    for (const id of Object.keys(this.byJob)) {
      if (liveIds.has(id)) continue;
      delete this.byJob[id];
      changed = true;
    }
    if (changed) this.save();
  }
}
