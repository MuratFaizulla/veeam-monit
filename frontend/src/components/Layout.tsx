import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

const navigation = [
  { to: '/', label: 'Обзор', icon: 'grid' },
  { to: '/jobs', label: 'Задания', icon: 'briefcase' },
  { to: '/backups', label: 'Бэкапы', icon: 'database' },
  { to: '/replicas', label: 'Реплики', icon: 'copy' },
  { to: '/infrastructure', label: 'Инфраструктура', icon: 'server' },
  { to: '/reports', label: 'Отчёты', icon: 'chart' },
  { to: '/license', label: 'Лицензии', icon: 'key' },
  { to: '/security', label: 'Безопасность', icon: 'shield' },
];
function NavIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    briefcase: 'M4 7h16v14H4z M8 7V3h8v4 M4 12h16 M10 12v3h4v-3',
    database: 'M4 6c0-4 16-4 16 0s-16 4-16 0v12c0 4 16 4 16 0V6 M4 12c0 4 16 4 16 0',
    copy: 'M8 8h13v13H8z M16 8V3H3v13h5',
    server: 'M3 3h18v7H3z M3 14h18v7H3z M6 6h1 M6 17h1 M10 6h7 M10 17h7',
    chart: 'M4 3v18h17 M8 16v-4 M13 16V8 M18 16V5',
    key: 'M14 4a6 6 0 1 1-4 10L3 21v-4l7-7a6 6 0 0 1 4-6 M17 7h.01',
    shield: 'M12 2l9 4v6c0 5-9 10-9 10S3 17 3 12V6z M8 12l3 3 5-6',
  };
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
export function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const access = useQuery({ queryKey: ['access'], queryFn: api.access });
  const current = navigation.find(item => item.to !== '/' && location.pathname.startsWith(item.to)) ?? navigation[0];
  return <div className="layout">
    <aside className="sidebar">
      <div className="sidebar__brand"><span className="brand-mark" aria-hidden="true">v</span><div>Veeam<span>BACKUP WORKSPACE</span></div></div>
      <div className="sidebar__caption">РАБОЧЕЕ ПРОСТРАНСТВО</div>
      <nav className="sidebar__nav" aria-label="Основная навигация">{navigation.filter(item => !(item.to === '/license' && access.data?.license === false) && !(item.to === '/security' && access.data?.security === false)).map(item => <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => `nav${isActive ? ' nav--active' : ''}`}><NavIcon name={item.icon} /><span>{item.label}</span></NavLink>)}</nav>
      <div className="sidebar__bottom"><div className="sidebar__mode"><span className="status-dot status-dot--success" />Мониторинг и отчёты</div><p>Просмотр данных в рамках<br />вашей роли Veeam</p></div>
    </aside>
    <div className="workspace">
      <header className="workspace-header"><div className="breadcrumbs">Рабочее пространство <span>/</span> <strong>{current.label}</strong></div><div className="workspace-user"><span className="avatar">{(user?.username?.split('\\').pop()?.[0] ?? 'V').toUpperCase()}</span><div><strong>{user?.username}</strong><span>{user?.role ?? 'Учётная запись Veeam'}</span></div><button type="button" className="button button--ghost" onClick={() => void logout()}>Выйти</button></div></header>
      <main className="content"><Outlet /></main>
    </div>
  </div>;
}
