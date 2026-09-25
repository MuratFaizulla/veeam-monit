/**
 * The last result reported for each Veeam job, keyed by job id.
 *
 * What the monitor compares a new result against to decide whether anything
 * changed. The rule about *what* to record — never `none` over a known result —
 * is `rememberedResult` in job-state.ts; this only remembers.
 *
 * Holds a record owned by the state store and calls `save` after each change;
 * it knows nothing about files. A test hands it a plain object.
 */
export class JobResults {
  constructor(
    private readonly byJob: Record<string, string>,
    private readonly save: () => void,
  ) {}

  /** False on an installation never observed before — the seeding cycle. */
  seeded(): boolean {
    return this.count() > 0;
  }

  count(): number {
    return Object.keys(this.byJob).length;
  }

  of(jobId: string): string | undefined {
    return this.byJob[jobId];
  }

  record(jobId: string, result: string): void {
    if (this.byJob[jobId] === result) return;
    this.byJob[jobId] = result;
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
