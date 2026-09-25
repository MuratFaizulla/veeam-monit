import { VeeamRepositoryState } from '../veeam/types';

/**
 * How full a repository is, worked out once.
 *
 * Two modules used to answer this from the same four fields and answer it
 * differently. The 💾 slot drew its bar from `capacity - free`, falling back to
 * `usedSpaceGB`; the low-space alert divided `freeGB ?? 0` by `capacityGB ?? 0`
 * — so a repository that reported a capacity but no free space was drawn
 * correctly and simultaneously reported as critically full, once per cooldown
 * window, forever.
 *
 * The rule is stated here and nowhere else: what is occupied is
 * `capacity - free` whenever Veeam reports free space, because on some
 * VBR/storage combinations `usedSpaceGB` is not physical consumption — it may
 * count logical or deduplicated data and can exceed capacity outright.
 */

/** What is known about one repository's space. */
export interface RepositoryCapacity {
  /** Identity for cooldowns: the id when Veeam gave one, else the name. */
  key: string;
  /** What a human should see. */
  name: string;
  /** The name exactly as Veeam reports it, for routing by subject. */
  subject?: string;
  hostName?: string;
  path?: string;
  capacityGB?: number;
  freeGB?: number;
  /** What is physically occupied, by the rule above. */
  usedGB?: number;
  /**
   * Share of capacity in use, 0..100, for the bar. May rest on `usedSpaceGB`
   * when free space was not reported, so it is an illustration, not a claim.
   * Undefined when nothing can be told — and an undefined percent is never
   * zero.
   */
  usedPercent?: number;
  /**
   * Share of capacity still free, 0..100. Defined **only** when Veeam actually
   * reported free space, because this is the number that raises an alarm and a
   * guess is not grounds for waking somebody up.
   */
  freePercent?: number;
  isOnline?: boolean;
}

export const capacityOf = (repository: VeeamRepositoryState): RepositoryCapacity => {
  const capacity = positive(repository.capacityGB);
  const free = finite(repository.freeGB);
  const used =
    capacity === undefined
      ? undefined
      : free !== undefined
        ? Math.max(0, capacity - free)
        : finite(repository.usedSpaceGB);

  return {
    key: repository.id ?? repository.name ?? '',
    name: repository.name ?? repository.id ?? 'Без имени',
    subject: repository.name,
    hostName: repository.hostName,
    path: repository.path,
    capacityGB: repository.capacityGB,
    freeGB: repository.freeGB,
    usedGB: used,
    usedPercent:
      capacity === undefined || used === undefined ? undefined : share(used, capacity),
    freePercent: capacity === undefined || free === undefined ? undefined : share(free, capacity),
    isOnline: repository.isOnline,
  };
};

/**
 * Every repository, in the order the 💾 slot lists them: by name, with the
 * ones Veeam creates by default last — they are rarely the ones anybody is
 * watching, and they would otherwise sit at the top of every message.
 */
export const capacities = (repositories: VeeamRepositoryState[]): RepositoryCapacity[] =>
  repositories.map(capacityOf).sort(byName);

const byName = (a: RepositoryCapacity, b: RepositoryCapacity): number => {
  const aIsDefault = /^default\b/i.test(a.name);
  const bIsDefault = /^default\b/i.test(b.name);
  if (aIsDefault !== bIsDefault) return aIsDefault ? 1 : -1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
};

const share = (part: number, whole: number): number =>
  Math.max(0, Math.min(100, (part / whole) * 100));

const finite = (value: number | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const positive = (value: number | undefined): number | undefined => {
  const number = finite(value);
  return number !== undefined && number > 0 ? number : undefined;
};
