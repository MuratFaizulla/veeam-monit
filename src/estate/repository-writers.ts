import { VeeamEstateReader } from '../veeam/estate-reader.service';
import { VeeamJob, VeeamSchedule } from '../veeam/types';
import { settled, valueOf } from './settled';

/**
 * Who writes to which repository: the jobs the Repository report puts on a
 * repository's chart, and the ones the Job report puts beside a job's newest
 * run.
 *
 * A backup job names its repository in the job list. A replica names none
 * there: the one repository it writes to is where it keeps its metadata, and
 * only the job read by itself says which. The Repository report read it so;
 * the Job report took its neighbours from the list alone, and a replica that
 * wrote to the same repository through the night was nobody.
 */

/** One job as both reports need it: what it is, when it runs, and where it writes. */
export interface ReportJob {
  id: string;
  name: string;
  type?: string;
  disabled: boolean;
  schedule?: VeeamSchedule;
  /** Where a backup job writes. */
  backupRepositoryId?: string;
  /** Where a replica job keeps its metadata — the only repository it names. */
  metadataRepositoryId?: string;
}

/**
 * Every job of a server and where it writes. A replica the list names no
 * repository of is read by itself, a few at a time; one that cannot be read
 * is kept as the list has it, writing nowhere anybody can tell.
 */
export const jobsWriting = async (reader: Pick<VeeamEstateReader, 'jobConfigurations' | 'jobConfiguration'>): Promise<ReportJob[]> => {
  const listed = (await reader.jobConfigurations()).filter((job): job is VeeamJob & { id: string } => Boolean(job.id));
  const whole = await settled(listed, (job) =>
    !job.storage?.backupRepositoryId && /replica/i.test(job.type ?? '') ? reader.jobConfiguration(job.id) : Promise.resolve(job),
  );
  return listed.map((job, index): ReportJob => {
    const known = valueOf(whole[index]) ?? job;
    return {
      id: job.id,
      name: job.name ?? job.id,
      type: job.type,
      disabled: Boolean(job.isDisabled),
      schedule: job.schedule,
      backupRepositoryId: known.storage?.backupRepositoryId,
      metadataRepositoryId: known.jobSettings?.metadataRepositoryId,
    };
  });
};

/** How `job` writes to repository `repositoryId`: its backups, only a replica's metadata, or not at all. */
export const writesTo = (job: ReportJob, repositoryId: string | undefined): 'backup' | 'metadata' | undefined => {
  if (!repositoryId) return undefined;
  if (job.backupRepositoryId === repositoryId) return 'backup';
  return job.metadataRepositoryId === repositoryId ? 'metadata' : undefined;
};
