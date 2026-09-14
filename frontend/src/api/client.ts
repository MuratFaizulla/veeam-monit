import type {
  BackupObjectDetails,
  BackupObjectView,
  BackupView,
  DashboardSummary,
  InfrastructureView,
  JobDetails,
  JobReport,
  SessionReport,
  LogReport,
  JobSummary,
  LicenseView,
  ReplicaDetails,
  ReplicaView,
  ReportSummary,
  SecurityView,
  Section,
  SessionUser,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The app session is gone — the UI must send the user back to the login page. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      // Without this the http-only session cookie is never sent.
      credentials: 'include',
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
      ...init,
    });
  } catch {
    throw new ApiError(0, 'Не удалось связаться с бэкендом');
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(response.status, extractMessage(payload, response.status));
  }

  return payload as T;
}

function extractMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const message = (payload as { message?: string | string[] }).message;
    if (Array.isArray(message)) return message.join(', ');
    if (typeof message === 'string') return message;
  }
  return `Ошибка запроса (HTTP ${status})`;
}

export const api = {
  access: () => request<{ license: boolean; security: boolean }>('/access'),
  login: (username: string, password: string) =>
    request<SessionUser>('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),

  logout: () => request<{ success: true }>('/auth/logout', { method: 'POST' }),

  me: () => request<SessionUser>('/auth/me'),

  dashboard: () => request<DashboardSummary>('/dashboard/summary'),

  jobs: () => request<JobSummary[]>('/jobs'),

  job: (id: string) => request<JobDetails>(`/jobs/${encodeURIComponent(id)}`),
  jobReport: (id: string, days: number) => request<JobReport>(`/jobs/${encodeURIComponent(id)}/report?days=${days}`),
  sessionReport: (id: string, sessionId: string) => request<SessionReport>(`/jobs/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}/report`),
  taskLogs: (id: string, sessionId: string, taskId: string) => request<LogReport>(`/jobs/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/logs`),

  infrastructure: () => request<InfrastructureView>('/infrastructure'),

  backups: () => request<Section<BackupView>>('/backups'),

  backupObjects: () => request<Section<BackupObjectView>>('/backups/objects'),

  backupObject: (id: string) =>
    request<BackupObjectDetails>(`/backups/objects/${encodeURIComponent(id)}`),

  replicas: () => request<Section<ReplicaView>>('/replicas'),

  replica: (id: string) => request<ReplicaDetails>(`/replicas/${encodeURIComponent(id)}`),

  license: () => request<LicenseView>('/license'),

  security: () => request<SecurityView>('/security'),

  reportSummary: (days: number) => request<ReportSummary>(`/reports/summary?days=${days}`),
};

/**
 * Download URLs are plain links rather than fetch calls: the browser then
 * handles the file save dialog, and the session cookie rides along because the
 * dev server proxies /api on the same origin.
 */
export const downloads = {
  jobCsv: (id: string, days: number) => `/api/jobs/${encodeURIComponent(id)}/report.csv?days=${days}`,
  jobHtml: (id: string, days: number) => `/api/jobs/${encodeURIComponent(id)}/report.html?days=${days}`,
  sessionHtml: (id: string, sessionId: string) => `/api/jobs/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}/report.html`,
  jobsCsv: () => '/api/reports/jobs.csv',
  sessionsCsv: (days: number) => `/api/reports/sessions.csv?days=${days}`,
  repositoriesCsv: () => '/api/reports/repositories.csv',
  summaryHtml: (days: number) => `/api/reports/summary.html?days=${days}`,
};
