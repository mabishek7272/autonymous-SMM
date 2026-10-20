import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertOctagon, RefreshCw } from 'lucide-react';
import { Button } from './Button';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  error: Error | null;
}

/** Catches render errors so one broken view cannot blank the whole app. */
export class ErrorBoundary extends Component<Props, State> {
  public state: State = { error: null };

  public static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  public componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught an unhandled exception:', error, info);
  }

  public render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div className="ek-card" style={{ maxWidth: 520, width: '100%', textAlign: 'center', padding: 32, borderColor: 'var(--danger-border)' }}>
          <div style={{ display: 'inline-flex', width: 52, height: 52, borderRadius: 14, background: 'var(--danger-bg)', color: 'var(--danger)', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
            <AlertOctagon size={26} aria-hidden="true" />
          </div>
          <h1 style={{ fontSize: 20, marginBottom: 8 }}>{this.props.fallbackTitle ?? 'Something went wrong'}</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 16 }}>An unexpected error interrupted this screen. Reloading usually fixes it.</p>
          <pre style={{ textAlign: 'left', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', borderRadius: 10, padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 12, color: '#991B1B', whiteSpace: 'pre-wrap', marginBottom: 20 }}>
            {error.message}
          </pre>
          <Button icon={<RefreshCw size={14} aria-hidden="true" />} onClick={() => window.location.reload()}>
            Reload application
          </Button>
        </div>
      </div>
    );
  }
}
