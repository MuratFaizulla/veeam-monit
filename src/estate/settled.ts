/**
 * Requests in flight to one Veeam server at a time, for whatever one answer
 * reads there — a job's month, a server's repositories and what writes to
 * them: a hundred at once is a burst Veeam has no need of. The Job reads and
 * the Repository report kept a pool each.
 */
const AT_ONCE = 6;

/**
 * `work` over `items`, `AT_ONCE` at a time, and how each went, in its place,
 * as `Promise.allSettled` says it. A failure is kept for the caller to say,
 * or to do without: the Job report's reads used to leave an empty place,
 * which nobody could tell from a machine never saved.
 */
export const settled = async <T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<Array<PromiseSettledResult<R>>> => {
  const out = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(AT_ONCE, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        try {
          out[index] = { status: 'fulfilled', value: await work(items[index]) };
        } catch (reason) {
          out[index] = { status: 'rejected', reason };
        }
      }
    }),
  );
  return out;
};

/** What a read settled with, or nothing when it failed. */
export const valueOf = <R>(read: PromiseSettledResult<R>): R | undefined => (read.status === 'fulfilled' ? read.value : undefined);
