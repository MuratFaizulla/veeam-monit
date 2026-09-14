import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ComponentView, Section } from '../api/types';
import { ErrorBox, Loader, Panel, SectionBody } from '../components/Panels';
import { RepositoryTable } from '../components/RepositoryTable';

export function InfrastructurePage() {
  const query = useQuery({
    queryKey: ['infrastructure'],
    queryFn: api.infrastructure,
    refetchInterval: 120_000,
  });

  if (query.isPending) return <Loader />;
  if (query.isError) return <ErrorBox error={query.error} onRetry={() => query.refetch()} />;

  const data = query.data;

  return (
    <div className="stack">
      <h1 className="page-title">Инфраструктура</h1>

      <Panel title="Репозитории">
        <SectionBody
          section={data.repositories}
          what="Репозитории"
          empty="Репозиториев не найдено"
        >
          {(items) => <RepositoryTable repositories={items} />}
        </SectionBody>
      </Panel>

      {data.scaleOutRepositories.available && data.scaleOutRepositories.items.length > 0 && (
        <Panel title="Scale-out репозитории">
          <RepositoryTable repositories={data.scaleOutRepositories.items} />
        </Panel>
      )}

      <div className="columns">
        <Panel title="Прокси">
          <ComponentTable section={data.proxies} what="Прокси" />
        </Panel>

        <Panel title="Управляемые серверы">
          <ComponentTable section={data.managedServers} what="Управляемые серверы" />
        </Panel>
      </div>

      <Panel title="WAN-акселераторы">
        <ComponentTable section={data.wanAccelerators} what="WAN-акселераторы" />
      </Panel>
    </div>
  );
}

function ComponentTable({ section, what }: { section: Section<ComponentView>; what: string }) {
  return (
    <SectionBody section={section} what={what} empty="Ничего не найдено">
      {(items) => (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Имя</th>
                <th>Тип</th>
                <th>Детали</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id || item.name}>
                  <td>
                    {item.name}
                    {item.description && <div className="table__hint">{item.description}</div>}
                  </td>
                  <td>{item.type ?? '—'}</td>
                  <td>{item.detail ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionBody>
  );
}
