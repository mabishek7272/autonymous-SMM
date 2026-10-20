import { Suspense, lazy, type ComponentType, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import LoginPage from './auth/LoginPage';
import { RequirePermission } from './auth/RequirePermission';
import { useAuth } from './auth/useAuth';
import { Shell } from './shell/Shell';
import { firstAllowedPath } from './shell/navigation';
import './shell/shell.css';
import type { Permission } from './types';
import { Button, Card, EmptyState, ErrorBoundary, ErrorState, SkeletonList, Spinner } from './ui';

const AdmissionsView = lazy(() => import('./features/admissions/AdmissionsView'));
const StudentHealthView = lazy(() => import('./features/students/StudentHealthView'));
const TeacherPortalView = lazy(() => import('./features/teacher/TeacherPortalView'));
const ClassLinksView = lazy(() => import('./features/classlinks/ClassLinksView'));
const ReportsView = lazy(() => import('./features/reports/ReportsView'));
const OverviewView = lazy(() => import('./features/overview/OverviewView'));
const UsersView = lazy(() => import('./features/admin/UsersView'));
const DevConsoleView = lazy(() => import('./features/admin/DevConsoleView'));

interface RouteDef {
  path: string;
  permission: Permission;
  component: ComponentType;
  title: string;
}

const ROUTES: readonly RouteDef[] = [
  { path: '/admissions', permission: 'leads:manage', component: AdmissionsView, title: 'Admissions' },
  { path: '/students', permission: 'students:read', component: StudentHealthView, title: 'Student Health' },
  { path: '/teachers', permission: 'attendance:mark', component: TeacherPortalView, title: 'Teachers' },
  { path: '/class-links', permission: 'classlinks:manage', component: ClassLinksView, title: 'Class Links' },
  { path: '/reports', permission: 'reports:review', component: ReportsView, title: 'Reports' },
  { path: '/overview', permission: 'dashboard:view', component: OverviewView, title: 'Overview' },
  { path: '/admin', permission: 'users:manage', component: UsersView, title: 'Users' },
  { path: '/dev', permission: 'dev:console', component: DevConsoleView, title: 'Dev Console' },
];

function FullPage({ children }: { children: ReactNode }) {
  return (
    <div className="ek-fullpage">
      <div className="ek-fullpage__card">{children}</div>
    </div>
  );
}

/** Sends the user to the first section their permissions allow. */
function Home() {
  const { hasPermission, logout, user } = useAuth();
  const target = firstAllowedPath(hasPermission);
  if (target) return <Navigate to={target} replace />;
  return (
    <FullPage>
      <Card>
        <EmptyState
          title="No sections available"
          description={`${user?.fullName ?? 'This account'} has no permissions that unlock any dashboard section. Ask an administrator to update your role.`}
          action={
            <Button variant="secondary" icon={<LogOut size={13} aria-hidden="true" />} onClick={logout}>
              Log out
            </Button>
          }
        />
      </Card>
    </FullPage>
  );
}

/** Gate for authenticated routes: waits for /auth/me, surfaces its failure, or redirects to /login. */
function RequireAuth() {
  const { status, error, retry, logout } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <FullPage>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Spinner size={28} label="Checking your session" />
        </div>
      </FullPage>
    );
  }
  if (status === 'error') {
    return (
      <FullPage>
        <ErrorState title="Could not verify your session" message={error ?? undefined} onRetry={retry} />
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <Button variant="ghost" onClick={logout}>
            Sign in again
          </Button>
        </div>
      </FullPage>
    );
  }
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Shell />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route path="/" element={<Home />} />
          {ROUTES.map(({ path, permission, component: View, title }) => (
            <Route
              key={path}
              path={path}
              element={
                <RequirePermission permission={permission} fallback={<Navigate to="/" replace />}>
                  <ErrorBoundary fallbackTitle={`${title} failed to render`}>
                    <Suspense fallback={<SkeletonList rows={5} label={`Loading ${title}`} />}>
                      <View />
                    </Suspense>
                  </ErrorBoundary>
                </RequirePermission>
              }
            />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}
