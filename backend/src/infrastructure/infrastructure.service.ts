import { Injectable } from '@nestjs/common';
import { VeeamSessionData } from '../auth/session.store';
import { VeeamClientService } from '../veeam/veeam-client.service';
import {
  VeeamManagedServer,
  VeeamProxy,
  VeeamRepository,
  VeeamRepositoryState,
  VeeamWanAccelerator,
} from '../veeam/veeam.types';

export interface RepositoryView {
  id: string;
  name: string;
  type: string | null;
  hostName: string | null;
  path: string | null;
  capacityGB: number | null;
  freeGB: number | null;
  usedGB: number | null;
  /** Percentage of used space, null when the state endpoint gave no capacity. */
  usedPercent: number | null;
}

export interface ComponentView {
  id: string;
  name: string;
  type: string | null;
  description: string | null;
  detail: string | null;
}

export interface InfrastructureView {
  repositories: { available: boolean; items: RepositoryView[] };
  scaleOutRepositories: { available: boolean; items: RepositoryView[] };
  proxies: { available: boolean; items: ComponentView[] };
  managedServers: { available: boolean; items: ComponentView[] };
  wanAccelerators: { available: boolean; items: ComponentView[] };
}

const REPOSITORIES = '/api/v1/backupInfrastructure/repositories';
const SCALE_OUT = '/api/v1/backupInfrastructure/scaleOutRepositories';
const PROXIES = '/api/v1/backupInfrastructure/proxies';
const MANAGED_SERVERS = '/api/v1/backupInfrastructure/managedServers';
const WAN_ACCELERATORS = '/api/v1/backupInfrastructure/wanAccelerators';

@Injectable()
export class InfrastructureService {
  constructor(private readonly veeam: VeeamClientService) {}

  async overview(session: VeeamSessionData): Promise<InfrastructureView> {
    // Note: scale-out repositories have no `/states` sub-path. Veeam parses the
    // last segment as an {id} and answers 400 ("not valid for Guid"), so that
    // call is not made at all — scale-out rows come without capacity figures.
    const [repositories, repositoryStates, scaleOut, proxies, servers, wan] = await Promise.all([
      this.veeam.collection<VeeamRepository>(session, REPOSITORIES),
      this.veeam.collection<VeeamRepositoryState>(session, `${REPOSITORIES}/states`),
      this.veeam.collection<VeeamRepository>(session, SCALE_OUT),
      this.veeam.collection<VeeamProxy>(session, PROXIES),
      this.veeam.collection<VeeamManagedServer>(session, MANAGED_SERVERS),
      this.veeam.collection<VeeamWanAccelerator>(session, WAN_ACCELERATORS),
    ]);

    return {
      repositories: {
        available: repositories !== null || repositoryStates !== null,
        items: this.mergeRepositories(repositories, repositoryStates),
      },
      scaleOutRepositories: {
        available: scaleOut !== null,
        items: this.mergeRepositories(scaleOut, null),
      },
      proxies: {
        available: proxies !== null,
        items: (proxies ?? []).map((proxy) => ({
          id: proxy.id ?? '',
          name: proxy.name ?? '—',
          type: proxy.type ?? null,
          description: proxy.description ?? null,
          detail: this.proxyDetail(proxy),
        })),
      },
      managedServers: {
        available: servers !== null,
        items: (servers ?? []).map((server) => ({
          id: server.id ?? '',
          name: server.name ?? '—',
          type: server.type ?? null,
          description: server.description ?? null,
          detail: server.status ?? null,
        })),
      },
      wanAccelerators: {
        available: wan !== null,
        items: (wan ?? []).map((accelerator) => ({
          id: accelerator.id ?? '',
          name: accelerator.name ?? '—',
          type: null,
          description: accelerator.description ?? null,
          detail: accelerator.cachePath
            ? `${accelerator.cachePath}${accelerator.cacheSizeGb ? ` · ${accelerator.cacheSizeGb} ГБ` : ''}`
            : null,
        })),
      },
    };
  }

  /**
   * Capacity lives in `/states`, names and paths in the collection itself.
   * Either half may be missing, so both are treated as optional.
   */
  private mergeRepositories(
    repositories: VeeamRepository[] | null,
    states: VeeamRepositoryState[] | null,
  ): RepositoryView[] {
    const byId = new Map<string, RepositoryView>();

    for (const repository of repositories ?? []) {
      if (!repository.id) continue;
      byId.set(repository.id, {
        id: repository.id,
        name: repository.name ?? '—',
        type: repository.type ?? null,
        hostName: repository.hostName ?? null,
        path: repository.path ?? null,
        capacityGB: null,
        freeGB: null,
        usedGB: null,
        usedPercent: null,
      });
    }

    for (const state of states ?? []) {
      if (!state.id) continue;
      const existing = byId.get(state.id);
      const capacity = state.capacityGB ?? null;
      const free = state.freeGB ?? null;
      const used = state.usedSpaceGB ?? (capacity !== null && free !== null ? capacity - free : null);

      byId.set(state.id, {
        id: state.id,
        name: state.name ?? existing?.name ?? '—',
        type: state.type ?? existing?.type ?? null,
        hostName: state.hostName ?? existing?.hostName ?? null,
        path: state.path ?? existing?.path ?? null,
        capacityGB: capacity,
        freeGB: free,
        usedGB: used,
        usedPercent:
          capacity !== null && capacity > 0 && used !== null
            ? Math.round((used / capacity) * 100)
            : null,
      });
    }

    // Fullest repositories first — that is what an operator looks for here.
    return [...byId.values()].sort(
      (a, b) => (b.usedPercent ?? -1) - (a.usedPercent ?? -1) || a.name.localeCompare(b.name),
    );
  }

  private proxyDetail(proxy: VeeamProxy): string | null {
    const mode = proxy.server?.transportMode ?? null;
    const tasks = proxy.server?.maxTaskCount ?? proxy.maxTaskCount ?? null;
    const parts = [mode, tasks !== null ? `задач: ${tasks}` : null].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : null;
  }
}
