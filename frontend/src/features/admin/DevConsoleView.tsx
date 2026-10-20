import { useState } from 'react';
import { RequirePermission } from '../../auth/RequirePermission';
import { EmptyState, PageHeader, Tabs, type TabOption } from '../../ui';
import { ConfigTab } from './ConfigTab';
import { LlmTab } from './LlmTab';
import { SystemTab } from './SystemTab';
import { VoiceTab } from './VoiceTab';
import { WhatsAppTab } from './WhatsAppTab';
import './admin.css';

type TabId = 'config' | 'llm' | 'whatsapp' | 'voice' | 'system';

const TABS: TabOption<TabId>[] = [
  { value: 'config', label: 'Configuration' },
  { value: 'llm', label: 'LLM' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'voice', label: 'Voice' },
  { value: 'system', label: 'System' },
];

export default function DevConsoleView() {
  return (
    <RequirePermission permission="dev:console" fallback={<EmptyState title="No access" description="The developer console is limited to superadmins." />}>
      <Console />
    </RequirePermission>
  );
}

function Console() {
  const [tab, setTab] = useState<TabId>('config');
  return (
    <div className="adm-stack">
      <PageHeader title="Developer console" subtitle="Runtime configuration and diagnostics for the running server." />
      <Tabs options={TABS} value={tab} onChange={setTab} ariaLabel="Developer console sections" />
      <div role="tabpanel">
        {tab === 'config' && <ConfigTab />}
        {tab === 'llm' && <LlmTab />}
        {tab === 'whatsapp' && <WhatsAppTab />}
        {tab === 'voice' && <VoiceTab />}
        {tab === 'system' && <SystemTab />}
      </div>
    </div>
  );
}
