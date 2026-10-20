import { useEffect, useMemo, useState } from 'react';
import { FileUp, GraduationCap, Search, UserPlus } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { Button, EmptyState, ErrorState, Input, KpiBar, PageHeader, SkeletonList, useConfirm, useToast, type KpiItem } from '../../ui';
import { isAdmissible, type LeadStatus } from '../../types/lead-stages';
import type { LeadWithParent } from '../../types';
import { AddLeadModal } from './AddLeadModal';
import { Board } from './Board';
import { BookDemoModal } from './BookDemoModal';
import { EnrollWizard } from './EnrollWizard';
import { ImportLeadsModal } from './ImportLeadsModal';
import { LeadModal } from './LeadModal';
import { leadName } from './helpers';
import { MAX_PAGES, PAGE_SIZE, useKpisQuery, useLeadsQuery, useMoveLead } from './useAdmissions';
import './admissions.css';

function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function AdmissionsView() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const canManage = hasPermission('leads:manage');
  const canEnroll = hasPermission('students:manage');

  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const leadsQuery = useLeadsQuery(q, canManage);
  const kpisQuery = useKpisQuery(canManage && hasPermission('dashboard:view'));
  const move = useMoveLead();

  const [openId, setOpenId] = useState<string | null>(null);
  const [focusComposer, setFocusComposer] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [demoLeadId, setDemoLeadId] = useState<string | null>(null);
  const [enroll, setEnroll] = useState<{ leadId: string | null } | null>(null);

  const leads = useMemo(() => leadsQuery.data?.leads ?? [], [leadsQuery.data]);
  const byId = (id: string | null): LeadWithParent | null => (id ? (leads.find((l) => l.id === id) ?? null) : null);

  const kpis = useMemo<KpiItem[]>(() => {
    const k = kpisQuery.data;
    if (k) {
      return [
        { label: 'Total leads', value: k.totalLeads },
        { label: 'Demos scheduled', value: k.demoScheduled },
        { label: 'Admissions', value: k.convertedLeads, sub: `Conversion ${k.conversionRate}` },
        { label: 'Active students', value: k.activeStudents },
        { label: 'AI actions today', value: k.aiActionsToday },
      ];
    }
    const count = (s: LeadStatus) => leads.filter((l) => l.status === s).length;
    const total = leadsQuery.data?.total;
    return [
      { label: 'Leads', value: total ?? '—', sub: q ? 'Matching search' : undefined },
      { label: 'New', value: count('enquiry') },
      { label: 'Demos booked', value: count('demo_scheduled') },
      { label: 'Admissions', value: count('converted') },
      { label: 'Lost', value: count('lost') },
    ];
  }, [kpisQuery.data, leads, leadsQuery.data, q]);

  const requestMove = async (lead: LeadWithParent, to: LeadStatus) => {
    if (lead.status === to) return;
    if (to === 'converted') {
      if (!canEnroll) return toast.error('You do not have permission to enroll students.');
      if (!isAdmissible(lead.status)) return toast.error(`${leadName(lead)} must be Interested, Demo Booked or Follow-up before admission.`);
      setEnroll({ leadId: lead.id });
      return;
    }
    if (to === 'lost') {
      const ok = await confirm({
        title: `Mark ${leadName(lead)} as lost?`,
        message: 'Without admin rights this sends an approval request and the lead stays where it is until an admin approves.',
        confirmLabel: 'Mark lost',
        tone: 'danger',
      });
      if (!ok) return;
    }
    move.mutate({ lead, to });
  };

  if (!canManage) {
    return <EmptyState title="No access to admissions" description="Your role does not include lead management." />;
  }

  const openLead = byId(openId);
  const demoLead = byId(demoLeadId);
  const truncated = leadsQuery.data && leadsQuery.data.total > leads.length;

  return (
    <>
      <KpiBar items={kpis} loading={leadsQuery.isPending && kpisQuery.isPending} />
      <PageHeader
        title="Admissions Pipeline"
        subtitle="Track every enquiry from first contact to admission."
        actions={
          <>
            <div className="adm-search">
              <Input
                label="Search leads"
                hideLabel
                startIcon={<Search size={14} aria-hidden="true" />}
                type="search"
                placeholder="Search leads, phone…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {canEnroll && (
              <Button variant="warm" icon={<GraduationCap size={14} aria-hidden="true" />} onClick={() => setEnroll({ leadId: null })}>
                Enroll Student
              </Button>
            )}
            <Button variant="secondary" icon={<FileUp size={14} aria-hidden="true" />} onClick={() => setImportOpen(true)}>
              Import leads
            </Button>
            <Button icon={<UserPlus size={14} aria-hidden="true" />} onClick={() => setAddOpen(true)}>
              Add Lead
            </Button>
          </>
        }
      />

      {leadsQuery.isPending ? (
        <SkeletonList rows={5} rowHeight={96} label="Loading leads" />
      ) : leadsQuery.isError ? (
        <ErrorState error={leadsQuery.error} onRetry={() => void leadsQuery.refetch()} retrying={leadsQuery.isFetching} title="Could not load leads" />
      ) : leads.length === 0 ? (
        <EmptyState
          title={q ? 'No leads match your search' : 'No leads yet'}
          description={q ? 'Try a different name or phone number.' : 'Leads from WhatsApp, Meta and your website appear here, or add one yourself.'}
          action={q ? { label: 'Clear search', onClick: () => setSearch('') } : { label: 'Add Lead', onClick: () => setAddOpen(true) }}
        />
      ) : (
        <>
          {truncated && (
            <div className="adm-banner" role="status">
              Showing the first {leads.length} of {leadsQuery.data?.total} leads (limit {PAGE_SIZE * MAX_PAGES}). Use search to narrow the board.
            </div>
          )}
          <Board
            leads={leads}
            movingId={move.isPending ? move.variables.lead.id : null}
            onOpen={(l) => {
              setFocusComposer(false);
              setOpenId(l.id);
            }}
            onMessage={(l) => {
              setFocusComposer(true);
              setOpenId(l.id);
            }}
            onMove={(l, to) => void requestMove(l, to)}
          />
        </>
      )}

      {openLead && (
        <LeadModal
          lead={openLead}
          focusComposer={focusComposer}
          canMove
          moving={move.isPending && move.variables.lead.id === openLead.id}
          onClose={() => setOpenId(null)}
          onMove={(l, to) => void requestMove(l, to)}
          onBookDemo={(l) => setDemoLeadId(l.id)}
        />
      )}
      {addOpen && <AddLeadModal open onClose={() => setAddOpen(false)} />}
      {importOpen && <ImportLeadsModal onClose={() => setImportOpen(false)} />}
      {demoLead && <BookDemoModal lead={demoLead} onClose={() => setDemoLeadId(null)} />}
      {enroll && <EnrollWizard leads={leads} initialLeadId={enroll.leadId} onClose={() => setEnroll(null)} />}
    </>
  );
}

