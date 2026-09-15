import { VeeamApiError } from './veeam-api.error';
import { VeeamHttpService } from './veeam-http.service';
import { VeeamCollection } from './veeam.types';

/**
 * Reading a whole Veeam collection.
 *
 * `VeeamHttpService.request` stops at one request, so everything about how a
 * collection is spread over pages had to live in whichever module wanted one.
 * There are two such modules now — the monitor cycle and the evidence scan —
 * and both were going to carry the same four rules.
 */

/** Pages read at once. Enough to be quick, few enough to be polite. */
const CONCURRENCY = 5;

/** What the caller must already hold to read a collection. */
export interface VeeamReader {
  veeam: VeeamHttpService;
  /** Consulted only when a token expires mid-read. */
  auth: { invalidateAccessToken(): void; getAccessToken(): Promise<string> };
  accessToken: string;
}

/** Reads every page of `path`. */
export const allPages = async <T>(
  reader: VeeamReader,
  path: string,
  params: Record<string, unknown> = {},
  limit = 100,
): Promise<T[]> => {
  const first = await page<T>(reader, path, params, 0, limit);
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
      const pages = await Promise.all(batch.map((skip) => page<T>(reader, path, params, skip, size)));
      for (const read of pages) items.push(...(read.data ?? []));
    }
    return items;
  }

  // No total reported: walk until a page comes back short.
  for (let skip = items.length; ; ) {
    const read = await page<T>(reader, path, params, skip, size);
    const data = read.data ?? [];
    items.push(...data);
    if (!data.length || data.length < size) break;
    skip += data.length;
  }
  return items;
};

/** One page, retried once against a token that expired mid-read. */
const page = async <T>(
  reader: VeeamReader,
  path: string,
  params: Record<string, unknown>,
  skip: number,
  limit: number,
): Promise<VeeamCollection<T>> => {
  try {
    return await reader.veeam.request<VeeamCollection<T>>({
      method: 'GET', path, accessToken: reader.accessToken, params: { ...params, skip, limit },
    });
  } catch (error) {
    if (!(error instanceof VeeamApiError) || !error.isUnauthorized) throw error;
    reader.auth.invalidateAccessToken();
    const accessToken = await reader.auth.getAccessToken();
    return reader.veeam.request<VeeamCollection<T>>({
      method: 'GET', path, accessToken, params: { ...params, skip, limit },
    });
  }
};
