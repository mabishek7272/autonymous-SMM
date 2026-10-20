import { useState } from 'react';
import { CalendarClock, FileUp, Link2 } from 'lucide-react';
import { RequirePermission } from '../../auth/RequirePermission';
import { Button, EmptyState, PageHeader, Tabs, type TabOption } from '../../ui';
import { BatchAssignments } from './BatchAssignments';
import { LinkLibrary } from './LinkLibrary';
import { TimetableImportModal } from './TimetableImportModal';
import './classlinks.css';

type TabId = 'library' | 'batches';

const TABS: TabOption<TabId>[] = [
  { value: 'library', label: 'Link library', icon: <Link2 size={14} aria-hidden="true" /> },
  { value: 'batches', label: 'Batch links & timetable', icon: <CalendarClock size={14} aria-hidden="true" /> },
];

export default function ClassLinksView() {
  return (
    <RequirePermission permission="classlinks:manage" fallback={<EmptyState title="No access" description="You do not have permission to manage class links." />}>
      <ClassLinksContent />
    </RequirePermission>
  );
}

function ClassLinksContent() {
  const [tab, setTab] = useState<TabId>('library');
  const [importing, setImporting] = useState(false);
  return (
    <div className="cl__stack">
      <PageHeader
        title="Class Links"
        subtitle="Keep your standing meeting links and each batch's weekly timetable here. Parents get the right link every class day, automatically."
        actions={
          <Button variant="secondary" icon={<FileUp size={14} />} onClick={() => setImporting(true)}>
            Import timetable
          </Button>
        }
      />
      <Tabs ariaLabel="Class links sections" options={TABS} value={tab} onChange={setTab} />
      {tab === 'library' ? <LinkLibrary /> : <BatchAssignments />}
      {importing && <TimetableImportModal onClose={() => setImporting(false)} />}
    </div>
  );
}
