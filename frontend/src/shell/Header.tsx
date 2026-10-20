import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Activity, KeyRound, LogOut, Mail, MessageCircle } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/useAuth';
import { agents, messages } from '../services/api';
import { Badge, Button, cx } from '../ui';
import { ROLE_LABELS } from '../types';
import { ChangePasswordModal } from './ChangePasswordModal';
import { allowedTabs } from './navigation';
import { useActivitySummary } from './useActivitySummary';
import './shell.css';

interface HeaderProps {
  logsOpen: boolean;
  onToggleLogs: () => void;
}

type PillTone = 'primary' | 'success' | 'warning' | 'danger' | 'neutral';

/** Outgoing email (Resend) state, from the same status call as the WhatsApp pill. */
function EmailPill() {
  const { data } = useQuery({
    queryKey: ['messages', 'status'],
    queryFn: ({ signal }) => messages.status({ signal }),
    refetchInterval: 60_000,
  });
  if (!data?.email) return null;
  const on = data.email.enabled;
  return (
    <div
      className={cx('ek-pill', `ek-pill--${on ? 'success' : 'warning'}`)}
      title={on ? `Sending from ${data.email.senders.join(', ')}` : 'Set RESEND_API_KEY on the server to send email'}
      data-testid="email-pill"
    >
      <Mail size={13} aria-hidden="true" />
      {on ? `Email on · ${data.email.domain}` : 'Email off'}
    </div>
  );
}

function WhatsAppPill() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['messages', 'status'],
    queryFn: ({ signal }) => messages.status({ signal }),
    refetchInterval: 60_000,
  });

  let tone: PillTone = 'neutral';
  let text = 'WhatsApp status unknown';
  if (isLoading) text = 'WhatsApp checking…';
  else if (!isError && data) {
    if (data.state === 'connected') {
      tone = 'success';
      text = 'WhatsApp connected';
    } else if (data.state === 'disconnected') {
      tone = 'warning';
      text = 'WhatsApp disconnected';
    } else if (data.state === 'unreachable') {
      tone = 'danger';
      text = 'WhatsApp unreachable';
    } else {
      tone = 'neutral';
      text = 'WhatsApp not configured';
    }
  }
  return (
    <div className={cx('ek-pill', `ek-pill--${tone}`)} title={data?.error ?? undefined} data-testid="whatsapp-pill">
      <MessageCircle size={13} aria-hidden="true" />
      {text}
    </div>
  );
}

/** "AI active today n/m": agents with at least one logged action today, from GET /agents/status. */
function AgentsPill() {
  const { data } = useQuery({
    queryKey: ['agents', 'status'],
    queryFn: ({ signal }) => agents.status({ signal }),
    refetchInterval: 60_000,
  });
  if (!data || data.length === 0) return null;
  const active = data.filter((a) => a.actionsToday > 0).length;
  return (
    <div className="ek-pill ek-pill--primary" title="Agents with at least one action logged today">
      <span className="ek-pulse" aria-hidden="true" />
      AI active today
      <span className="ek-pill__mono">
        {active}/{data.length}
      </span>
    </div>
  );
}

function LogsButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const summary = useActivitySummary(true);
  const { markSeen } = summary;
  useEffect(() => {
    if (open) markSeen();
  }, [open, markSeen, summary.total]);

  const showUnread = !open && summary.unread > 0;
  const count = showUnread ? summary.unread : summary.total;
  const countText = summary.isLoading || summary.isError ? null : `${count}${!showUnread && summary.capped ? '+' : ''}`;
  const label = summary.isError
    ? 'Activity logs (could not load)'
    : `Activity logs, ${summary.unread} unread of ${summary.total}${summary.capped ? '+' : ''}`;

  return (
    <Button variant="secondary" size="md" className="ek-logs-btn" onClick={onToggle} aria-expanded={open} aria-label={label} icon={<Activity size={14} aria-hidden="true" />}>
      Logs
      {countText !== null && <span className={cx('ek-count', showUnread ? 'ek-count--unread' : 'ek-count--total')}>{countText}</span>}
    </Button>
  );
}

export function Header({ logsOpen, onToggleLogs }: HeaderProps) {
  const { user, hasPermission, logout } = useAuth();
  const tabs = allowedTabs(hasPermission);
  const [changingPassword, setChangingPassword] = useState(false);

  return (
    <>
    <header className="ek-header">
      <div className="ek-brand">
        <div className="ek-brand__mark" aria-hidden="true">
          E
        </div>
        <div className="ek-brand__text">
          <span className="ek-brand__name">E-Kalavya</span>
          <span className="ek-brand__tag">MULTI-AGENT ADMISSIONS</span>
        </div>
      </div>

      {tabs.length > 0 && (
        <nav className="ek-nav" aria-label="Main sections">
          {tabs.map((t) => (
            <NavLink key={t.path} to={t.path} className={({ isActive }) => cx('ek-nav__link', isActive && 'is-active')}>
              <t.icon size={14} aria-hidden="true" />
              {t.label}
            </NavLink>
          ))}
        </nav>
      )}

      <div className="ek-header__spacer" />

      <div className="ek-header__right">
        {hasPermission('agents:view') && <AgentsPill />}
        {hasPermission('dashboard:view') && <WhatsAppPill />}
        {hasPermission('dashboard:view') && <EmailPill />}
        {hasPermission('agents:view') && <LogsButton open={logsOpen} onToggle={onToggleLogs} />}
        {user && (
          <div className="ek-user">
            <span className="ek-user__name">{user.fullName}</span>
            <Badge tone="primary" uppercase>
              {ROLE_LABELS[user.role]}
            </Badge>
            <Button variant="ghost" size="md" iconOnly aria-label="Change password" title="Change password" icon={<KeyRound size={14} aria-hidden="true" />} onClick={() => setChangingPassword(true)} />
            <Button variant="secondary" size="md" icon={<LogOut size={13} aria-hidden="true" />} onClick={logout}>
              Log out
            </Button>
          </div>
        )}
      </div>
    </header>
    {changingPassword && <ChangePasswordModal onClose={() => setChangingPassword(false)} />}
    </>
  );
}
