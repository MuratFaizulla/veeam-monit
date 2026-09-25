import { VeeamCollection } from './types';

/**
 * Reading a whole Veeam collection.
 *
 * `VeeamHttpService.request` stops at one request, so everything about how a
 * collection is spread over pages has to live somewhere above it. That is
 * here, and only the reader calls it: how a page is asked for — the path, the
 * token, what to do when the token is refused — is the reader's business, and
 * this knows none of it.
 */

/** Pages read at once. Enough to be quick, few enough to be polite. */
const CONCURRENCY = 5;

/** One page of a collection, however it is fetched. */
export type PageOf<T> = (skip: number, limit: number) => Promise<VeeamCollection<T>>;

/** Reads every page `page` can reach, `limit` rows at a time. */
export const allPages = async <T>(page: PageOf<T>, limit = 100): Promise<T[]> => {
  const first = await page(0, limit);
  const items: T[] = [...(first.data ?? [])];
  const total = first.pagination?.total;
  // Veeam may cap the requested limit, and the cap is what the next skip has
  // to step by.
  const size = first.pagination?.limit ?? limit;

  // A first page that came back short is the whole collection. Asking for the
  // next one would fetch the same rows again on a server that ignores `skip`,
  // and count everything twice.
  if (items.length < size) return items;

  // The total turns paging from "walk until a short page" into a known list of
  // offsets, and a known list can be fetched at once. Read one at a time, nine
  // thousand sessions took 84 seconds — long enough to stall the cycle that
  // alerting runs in.
  if (typeof total === 'number' && size > 0) {
    const skips: number[] = [];
    for (let skip = items.length; skip < total; skip += size) skips.push(skip);
    for (let i = 0; i < skips.length; i += CONCURRENCY) {
      const batch = skips.slice(i, i + CONCURRENCY);
      const pages = await Promise.all(batch.map((skip) => page(skip, size)));
      for (const read of pages) items.push(...(read.data ?? []));
    }
    return items;
  }

  // No total reported: walk until a page comes back short.
  for (let skip = items.length; ; ) {
    const read = await page(skip, size);
    const data = read.data ?? [];
    items.push(...data);
    if (!data.length || data.length < size) break;
    skip += data.length;
  }
  return items;
};
