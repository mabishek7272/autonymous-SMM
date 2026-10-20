import { Suspense, lazy, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';
import { Header } from './Header';

const ActivityDrawer = lazy(() => import('../features/overview/ActivityDrawer'));

/** Authenticated layout: sticky header, routed content, and the activity drawer (agents:view). */
export function Shell() {
  const { hasPermission } = useAuth();
  const [logsOpen, setLogsOpen] = useState(false);
  return (
    <div className="ek-app">
      <Header logsOpen={logsOpen} onToggleLogs={() => setLogsOpen((v) => !v)} />
      <main className="ek-main" id="main">
        <Outlet />
      </main>
      {hasPermission('agents:view') && (
        <Suspense fallback={null}>
          <ActivityDrawer open={logsOpen} onClose={() => setLogsOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
