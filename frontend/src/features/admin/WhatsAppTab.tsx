import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send, Smartphone } from 'lucide-react';
import { api } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import type { WhatsAppSimulateHistoryItem } from '../../types';
import { Badge, Button, Card, CardHeader, ErrorState, Input, Modal, SkeletonList, Textarea, useToast, type BadgeTone } from '../../ui';

const STATE_TONE: Record<string, BadgeTone> = { connected: 'success', disconnected: 'warning', unreachable: 'danger', not_configured: 'neutral' };
const STATE_LABEL: Record<string, string> = { connected: 'Connected', disconnected: 'Disconnected', unreachable: 'Unreachable', not_configured: 'Not configured' };

export function WhatsAppTab() {
  return (
    <div className="adm-stack">
      <StatusCard />
      <PingCard />
      <SimulateCard />
    </div>
  );
}

function StatusCard() {
  const query = useQuery({ queryKey: ['dev', 'wa-status'], queryFn: ({ signal }) => api.messages.status({ signal }) });
  const [connectOpen, setConnectOpen] = useState(false);
  const isConnected = query.data?.state === 'connected';
  return (
    <Card>
      <CardHeader
        title="Gateway status"
        actions={
          <>
            {query.data && !isConnected && (
              <Button size="sm" icon={<Smartphone size={13} aria-hidden="true" />} onClick={() => setConnectOpen(true)}>
                Connect WhatsApp
              </Button>
            )}
            <Button variant="secondary" size="sm" loading={query.isFetching && !query.isPending} onClick={() => void query.refetch()}>
              Refresh
            </Button>
          </>
        }
      />
      {query.isPending ? (
        <SkeletonList rows={1} label="Loading gateway status" />
      ) : query.isError ? (
        <ErrorState error={query.error} title="Could not load gateway status" onRetry={() => void query.refetch()} retrying={query.isFetching} />
      ) : (
        <div className="adm-stack">
          <div className="adm-row">
            <Badge tone={STATE_TONE[query.data.state] ?? 'neutral'}>{STATE_LABEL[query.data.state] ?? query.data.state}</Badge>
            <span className="adm-muted">Instance {query.data.instance}</span>
            {query.data.name && <span className="adm-muted">Account {query.data.name}</span>}
          </div>
          {query.data.error && <div className="adm-banner adm-banner--warn">{query.data.error}</div>}
        </div>
      )}
      <ConnectWhatsAppModal open={connectOpen} onClose={() => setConnectOpen(false)} />
    </Card>
  );
}

function ConnectWhatsAppModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const reset = () => {
    stopPolling();
    setPhone('');
    setCode(null);
  };

  useEffect(() => () => stopPolling(), []);

  const connect = useMutation({
    mutationFn: () => api.dev.connectWhatsApp(phone.trim()),
    onSuccess: (res) => {
      setCode(res.code);
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const status = await api.messages.status();
          if (status.state === 'connected') {
            stopPolling();
            void qc.invalidateQueries({ queryKey: ['dev', 'wa-status'] });
            try {
              await api.dev.confirmWhatsAppConnected();
            } catch {
              // Pairing succeeded either way; the confirmation message is a nice-to-have.
            }
            toast.success('WhatsApp connected — Sherlin notified the owner number.');
            reset();
            onClose();
          }
        } catch {
          // transient status-check failure; keep polling
        }
      }, 4000);
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    connect.mutate();
  };

  const close = () => {
    reset();
    onClose();
  };

  return (
    <Modal open={open} onClose={close} title="Connect WhatsApp" subtitle="Link this number to the gateway with a phone-linking code — no QR code needed." width={480}>
      {!code ? (
        <form className="adm-form" onSubmit={submit}>
          <Input
            label="WhatsApp number (with country code)"
            inputMode="numeric"
            placeholder="+91 98841 97299"
            hint="Any of these work: +91 98841 97299, 91 98841 97299, 919884197299, or just 9884197299."
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoFocus
          />
          <div>
            <Button type="submit" loading={connect.isPending} disabled={!phone.trim()}>
              Generate code
            </Button>
          </div>
        </form>
      ) : (
        <div className="adm-stack">
          <div className="adm-stat" style={{ textAlign: 'center' }}>
            <div className="adm-stat__label">Your linking code</div>
            <div className="adm-mono" style={{ fontSize: 28, fontWeight: 700, letterSpacing: 2 }}>
              {code}
            </div>
          </div>
          <ol style={{ paddingLeft: 20, margin: 0 }} className="adm-stack">
            <li>Open <strong>WhatsApp</strong> on the phone with this number.</li>
            <li>Go to <strong>Settings → Linked Devices</strong>.</li>
            <li>
              Tap <strong>Link a Device</strong>, then <strong>Link with phone number instead</strong>.
            </li>
            <li>
              Enter the code above exactly as shown.
            </li>
          </ol>
          <div className="adm-row">
            <Badge tone="warning">Waiting for the phone to connect…</Badge>
          </div>
          <p className="adm-muted">This closes automatically once connected. Sherlin will send a confirmation to the founder&apos;s number.</p>
        </div>
      )}
    </Modal>
  );
}

function PingCard() {
  const toast = useToast();
  const [to, setTo] = useState('');
  const [message, setMessage] = useState('');
  const send = useMutation({
    mutationFn: () => api.dev.testWhatsApp(to.trim(), message.trim() || undefined),
    onSuccess: (res) => toast.success(res.status === 'success' ? `Test message sent to ${to.trim()}` : `Gateway replied: ${res.status}`),
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send.mutate();
  };
  return (
    <Card>
      <CardHeader title="Send a test message" subtitle="Dispatches a real WhatsApp message through the gateway." />
      <form className="adm-form" onSubmit={submit}>
        <div className="adm-grid-2">
          <Input
            label="To (number with country code)"
            inputMode="numeric"
            placeholder="+91 98841 97299"
            hint="Any of these work: +91 98841 97299, 91 98841 97299, 919884197299, or just 9884197299."
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <Textarea label="Message (optional)" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} hint="Blank sends the server's default ping text." />
        <div>
          <Button type="submit" icon={<Send size={13} aria-hidden="true" />} loading={send.isPending} disabled={!to.trim()}>
            Send test message
          </Button>
        </div>
      </form>
    </Card>
  );
}

interface ChatLine extends WhatsAppSimulateHistoryItem {
  note?: string;
}

function SimulateCard() {
  const toast = useToast();
  const [text, setText] = useState('');
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [meta, setMeta] = useState<{ model: string; latencyMs: number } | null>(null);

  const simulate = useMutation({
    mutationFn: (msg: string) => api.dev.simulateWhatsApp(msg, lines.map(({ from, text: t }) => ({ from, text: t }))),
    onSuccess: (res, msg) => {
      setLines((l) => [...l, { from: 'p', text: msg }, { from: 'a', text: res.reply, note: res.note }]);
      setMeta({ model: res.model, latencyMs: res.latencyMs });
      setText('');
      if (res.note) toast.info(res.note);
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) simulate.mutate(text.trim());
  };

  return (
    <Card>
      <CardHeader
        title="Simulate an inbound message"
        subtitle="Plays a parent message through the assistant. Nothing is sent over WhatsApp."
        actions={
          lines.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => { setLines([]); setMeta(null); }}>
              Clear conversation
            </Button>
          ) : undefined
        }
      />
      <div className="adm-stack">
        {lines.length > 0 && (
          <div className="adm-chat" aria-label="Simulated conversation" role="log">
            {lines.map((l, i) => (
              <div key={i} className={`adm-bubble adm-bubble--${l.from}`}>
                <span className="ek-sr-only">{l.from === 'p' ? 'Parent: ' : 'Assistant: '}</span>
                {l.text}
                {l.note && <div className="adm-muted">{l.note}</div>}
              </div>
            ))}
          </div>
        )}
        {meta && (
          <span className="adm-muted">
            {meta.model} · {meta.latencyMs} ms
          </span>
        )}
        <form className="adm-form" onSubmit={submit}>
          <Textarea label="Parent message" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
          <div>
            <Button type="submit" icon={<Send size={13} aria-hidden="true" />} loading={simulate.isPending} disabled={!text.trim()}>
              Simulate message
            </Button>
          </div>
        </form>
      </div>
    </Card>
  );
}
