import type { ReactNode } from 'react';
import { ApiError } from '../api/client';

export function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel__header">
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/**
 * Shown when Veeam answered 404/403 for a section: either this VBR build has
 * no such endpoint, or the signed-in role may not read it.
 */
export function Unavailable({ what }: { what: string }) {
  return (
    <p className="empty">
      {what} недоступен(ы) на этой сборке VBR или для текущей роли.
    </p>
  );
}

/** Renders a section that may be unavailable, empty, or full. */
export function SectionBody<T>({
  section,
  what,
  empty,
  children,
}: {
  section: { available: boolean; items: T[] };
  what: string;
  empty: string;
  children: (items: T[]) => ReactNode;
}) {
  if (!section.available) return <Unavailable what={what} />;
  if (section.items.length === 0) return <EmptyState>{empty}</EmptyState>;
  return <>{children(section.items)}</>;
}

export function Loader({ label = 'Загрузка…' }: { label?: string }) {
  return (
    <div className="loader" role="status">
      <span className="loader__dot" />
      {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (error instanceof ApiError && error.status === 403) {
    return <p className="empty" role="status">Текущая роль Veeam не разрешает просмотр этого раздела.</p>;
  }
  if (error instanceof ApiError && error.status === 404) {
    return <p className="empty" role="status">Объект не найден или больше недоступен. Вернитесь к списку и обновите его.</p>;
  }
  const message = error instanceof Error ? error.message : 'Неизвестная ошибка';
  return (
    <div className="error-box" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="button button--ghost" onClick={onRetry}>
          Повторить
        </button>
      )}
    </div>
  );
}
