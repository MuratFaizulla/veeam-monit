import { VeeamApiError } from './api.error';
import { RawRequest, VeeamHttpService } from './http.service';
import { VeeamCollection } from './types';

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

/** What the caller must already hold to read from Veeam. */
export interface VeeamReader {
  veeam: VeeamHttpService;
  /** Consulted only when Veeam refuses the token being used. */
  auth: { rejectToken(): boolean; getAccessToken(): Promise<string> };
  accessToken: string;
}

/**
 * One authenticated request, tried again with a fresh token if Veeam refuses
 * the one it was given.
 *
 * Every read from Veeam goes through here, not just the paged ones. A cycle
 * makes about a dozen calls and only the paged ones used to recover from a
 * refused token; the rest simply failed, and went on failing every minute for
 * as long as the service believed its token was still good — an hour, or until
 * somebody restarted the process.
 *
 * Exactly one retry. If the fresh token is refused too, the answer is "Veeam is
 * not letting us in", and that belongs in the health message rather than in a
 * loop.
 */
export const authorized = async <T>(
  reader: VeeamReader,
  request: Omit<RawRequest, 'accessToken'>,
): Promise<T> => {
  try {
    return await reader.veeam.request<T>({ ...request, accessToken: reader.accessToken });
  } catch (error) {
    if (!(error instanceof VeeamApiError) || !error.isTokenRejected) throw error;
    // Says no when the same refusal was already acted on moments ago: one
    // cycle's worth of calls carries one token and needs one new one.
    if (!reader.auth.rejectToken()) throw error;
    return reader.veeam.request<T>({
      ...request,
      accessToken: await reader.auth.getAccessToken(),
    });
  }
};

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

/** One page. Recovering from a refused token is `authorized`'s business. */
const page = <T>(
  reader: VeeamReader,
  path: string,
  params: Record<string, unknown>,
  skip: number,
  limit: number,
): Promise<VeeamCollection<T>> =>
  authorized<VeeamCollection<T>>(reader, {
    method: 'GET',
    path,
    params: { ...params, skip, limit },
  });
