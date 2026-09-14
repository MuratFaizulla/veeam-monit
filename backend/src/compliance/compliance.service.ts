import { Injectable } from '@nestjs/common';
import { VeeamSessionData } from '../auth/session.store';
import { VeeamClientService } from '../veeam/veeam-client.service';
import {
  VeeamBestPractice,
  VeeamLicense,
  VeeamLicenseWorkload,
  VeeamMalwareEvent,
} from '../veeam/veeam.types';

export interface LicenseWorkloadView {
  id: string;
  name: string;
  hostName: string | null;
  type: string | null;
  /** Instances, sockets or GB depending on which collection it came from. */
  amount: number | null;
  unit: 'instances' | 'sockets' | 'GB';
}

export interface LicenseView {
  available: boolean;
  status: string | null;
  edition: string | null;
  type: string | null;
  licensedTo: string | null;
  expirationDate: string | null;
  supportExpirationDate: string | null;
  autoUpdateEnabled: boolean | null;
  instances: { licensed: number | null; used: number | null } | null;
  sockets: { licensed: number | null; used: number | null } | null;
  capacityTb: { licensed: number | null; used: number | null } | null;
  topWorkloads: LicenseWorkloadView[];
}

export interface BestPracticeView {
  id: string;
  name: string | null;
  status: string | null;
  description: string | null;
  suppressComment: string | null;
}

export interface SecurityView {
  analyzer: {
    available: boolean;
    lastRun: { state: string | null; result: string | null; endTime: string | null } | null;
    counts: Record<string, number>;
    items: BestPracticeView[];
  };
  malware: {
    available: boolean;
    items: Array<{
      id: string;
      detectedAt: string | null;
      severity: string | null;
      state: string | null;
      machineName: string | null;
      source: string | null;
      details: string | null;
    }>;
  };
}

const LICENSE = '/api/v1/license';
const BEST_PRACTICES = '/api/v1/securityAnalyzer/bestPractices';
const ANALYZER_LAST_RUN = '/api/v1/securityAnalyzer/lastRun';
const MALWARE_EVENTS = '/api/v1/malwareDetection/events';

@Injectable()
export class ComplianceService {
  constructor(private readonly veeam: VeeamClientService) {}

  async license(session: VeeamSessionData): Promise<LicenseView> {
    const [license, instances, sockets, capacityResult] = await Promise.all([
      this.veeam.getOptional<VeeamLicense>(session, LICENSE),
      this.veeam.collection<VeeamLicenseWorkload>(session, `${LICENSE}/instances`),
      this.veeam.collection<VeeamLicenseWorkload>(session, `${LICENSE}/sockets`),
      this.veeam.getOptional<{ workloads: VeeamLicenseWorkload[] }>(session, `${LICENSE}/capacity`),
    ]);
    const capacity = capacityResult?.workloads ?? null;

    const workloads: LicenseWorkloadView[] = [
      ...this.toWorkloads(instances, 'instances', (item) => item.usedInstancesNumber),
      ...this.toWorkloads(sockets, 'sockets', (item) => item.socketsNumber),
      ...this.toWorkloads(capacity, 'GB', (item) => item.usedCapacityGb),
    ]
      .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
      .slice(0, 20);

    return {
      available: license !== null,
      status: license?.status ?? null,
      edition: license?.edition ?? null,
      type: license?.type ?? null,
      licensedTo: license?.licensedTo ?? null,
      expirationDate: license?.expirationDate ?? null,
      supportExpirationDate: license?.supportExpirationDate ?? null,
      autoUpdateEnabled: license?.autoUpdateEnabled ?? null,
      instances: license?.instanceLicenseSummary
        ? {
            licensed: license.instanceLicenseSummary.licensedInstancesNumber ?? null,
            used: license.instanceLicenseSummary.usedInstancesNumber ?? null,
          }
        : null,
      sockets: license?.socketLicenseSummary
        ? {
            licensed: license.socketLicenseSummary.licensedSocketsNumber ?? null,
            used: license.socketLicenseSummary.usedSocketsNumber ?? null,
          }
        : null,
      capacityTb: license?.capacityLicenseSummary
        ? {
            licensed: license.capacityLicenseSummary.licensedCapacityTb ?? null,
            used: license.capacityLicenseSummary.usedCapacityTb ?? null,
          }
        : null,
      topWorkloads: workloads,
    };
  }

  async security(session: VeeamSessionData): Promise<SecurityView> {
    const [compliance, lastRun, malware] = await Promise.all([
      this.veeam.getOptional<{ items: VeeamBestPractice[] }>(session, BEST_PRACTICES),
      this.veeam.getOptional<{ state?: string; result?: { result?: string }; endTime?: string }>(
        session,
        ANALYZER_LAST_RUN,
      ),
      this.veeam.collection<VeeamMalwareEvent>(session, MALWARE_EVENTS),
    ]);
    const bestPractices = compliance?.items ?? null;

    const counts: Record<string, number> = {};
    for (const practice of bestPractices ?? []) {
      const key = practice.status ?? 'Unknown';
      counts[key] = (counts[key] ?? 0) + 1;
    }

    return {
      analyzer: {
        available: bestPractices !== null,
        lastRun: lastRun
          ? {
              state: lastRun.state ?? null,
              result: lastRun.result?.result ?? null,
              endTime: lastRun.endTime ?? null,
            }
          : null,
        counts,
        items: (bestPractices ?? [])
          .map((practice) => ({
            id: practice.id ?? '',
            name: practice.bestPractice ?? practice.name ?? practice.type ?? null,
            status: practice.status ?? null,
            description: practice.description ?? null,
            suppressComment: practice.note ?? practice.suppressComment ?? null,
          }))
          // Non-compliant entries first: that is the actionable part of the list.
          .sort((a, b) => this.practiceRank(a.status) - this.practiceRank(b.status)),
      },
      malware: {
        available: malware !== null,
        items: (malware ?? [])
          .map((event) => ({
            id: event.id ?? '',
            detectedAt: event.detectionTimeUtc ?? null,
            severity: event.severity ?? null,
            state: event.state ?? null,
            machineName: event.machineName ?? null,
            source: event.source ?? event.engine ?? null,
            details: event.details ?? null,
          }))
          .sort((a, b) => this.time(b.detectedAt) - this.time(a.detectedAt))
          .slice(0, 50),
      },
    };
  }

  private toWorkloads(
    items: VeeamLicenseWorkload[] | null,
    unit: LicenseWorkloadView['unit'],
    amount: (item: VeeamLicenseWorkload) => number | undefined,
  ): LicenseWorkloadView[] {
    return (items ?? []).map((item) => ({
      id: item.instanceId ?? item.hostId ?? `${unit}-${item.name ?? 'workload'}`,
      name: item.name ?? '—',
      hostName: item.hostName ?? null,
      type: item.type ?? null,
      amount: amount(item) ?? null,
      unit,
    }));
  }

  private practiceRank(status: string | null): number {
    switch (status?.toLowerCase()) {
      case 'notcompliant':
      case 'noncompliant':
        return 0;
      case 'unabletocheck':
      case 'unknown':
        return 1;
      case 'suppressed':
        return 2;
      default:
        return 3;
    }
  }

  private time(value: string | null): number {
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
