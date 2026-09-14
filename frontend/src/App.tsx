import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Loader } from './components/Panels';
import { useAuth } from './auth/AuthContext';
import { BackupObjectPage } from './pages/BackupObjectPage';
import { BackupsPage } from './pages/BackupsPage';
import { DashboardPage } from './pages/DashboardPage';
import { InfrastructurePage } from './pages/InfrastructurePage';
import { JobDetailsPage } from './pages/JobDetailsPage';
import { JobsPage } from './pages/JobsPage';
import { LicensePage } from './pages/LicensePage';
import { LoginPage } from './pages/LoginPage';
import { ReplicaDetailsPage } from './pages/ReplicaDetailsPage';
import { ReplicasPage } from './pages/ReplicasPage';
import { ReportsPage } from './pages/ReportsPage';
import { SecurityPage } from './pages/SecurityPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="jobs" element={<JobsPage />} />
          <Route path="jobs/:id" element={<JobDetailsPage />} />
          <Route path="backups" element={<BackupsPage />} />
          <Route path="backups/objects/:id" element={<BackupObjectPage />} />
          <Route path="replicas" element={<ReplicasPage />} />
          <Route path="replicas/:id" element={<ReplicaDetailsPage />} />
          <Route path="infrastructure" element={<InfrastructurePage />} />
          <Route path="license" element={<LicensePage />} />
          <Route path="security" element={<SecurityPage />} />
          <Route path="reports" element={<ReportsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();

  // Wait for the /auth/me probe, otherwise a reload always bounces to login.
  if (loading) return <Loader label="Проверка сессии…" />;

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}
