import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { calls as callsApi, dashboard, isPendingApproval, leads as leadsApi, messages } from '../../services/api';
import { useToast } from '../../ui';
import { stageLabel, type LeadStatus } from '../../types/lead-stages';
import type { LeadWithParent } from '../../types';
import { leadName } from './helpers';

export const LEADS_ROOT = ['admissions', 'leads'] as const;
export const PAGE_SIZE = 100;
/** Safety cap: 20 pages x 100 leads. The board tells the user when more exist. */
export const MAX_PAGES = 20;

export interface LeadsResult {
  leads: LeadWithParent[];
  total: number;
}

/** Loads every page of GET /leads (server-side search via q). */
export function useLeadsQuery(q: string, enabled = true) {
  return useQuery({
    queryKey: [...LEADS_ROOT, q],
    queryFn: async ({ signal }): Promise<LeadsResult> => {
      const all: LeadWithParent[] = [];
      let total = 0;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const res = await leadsApi.list({ q: q || undefined, page, limit: PAGE_SIZE }, { signal });
        all.push(...res.data);
        total = res.meta.total;
        if (page >= res.meta.totalPages) break;
      }
      return { leads: all, total };
    },
    enabled,
  });
}

export function useKpisQuery(enabled: boolean) {
  return useQuery({
    queryKey: ['admissions', 'kpis'],
    queryFn: ({ signal }) => dashboard.kpis({ signal }),
    enabled,
  });
}

export function useLeadDetail(id: string | null) {
  return useQuery({
    queryKey: ['admissions', 'lead', id],
    queryFn: ({ signal }) => leadsApi.get(id as string, { signal }),
    enabled: !!id,
  });
}

export function useLeadMessages(id: string | null) {
  return useQuery({
    queryKey: ['admissions', 'messages', id],
    queryFn: ({ signal }) => messages.history({ leadId: id as string, pageSize: 100 }, { signal }),
    enabled: !!id,
    refetchInterval: 10_000,
  });
}

export function useInvalidateAdmissions() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['admissions'] });
}

interface MoveVars {
  lead: LeadWithParent;
  to: LeadStatus;
}

type Snapshot = [readonly unknown[], LeadsResult | undefined][];

function patchStatus(qc: ReturnType<typeof useQueryClient>, id: string, status: LeadStatus) {
  qc.setQueriesData<LeadsResult>({ queryKey: LEADS_ROOT }, (old) =>
    old ? { ...old, leads: old.leads.map((l) => (l.id === id ? { ...l, status } : l)) } : old,
  );
}

/**
 * PATCH /leads/:id/status with an optimistic move and rollback on error.
 * Moving to "lost" is not optimistic: the backend answers 202 (approval requested, lead unchanged)
 * for anyone who is not admin/superadmin, so the card only moves once the server confirms.
 */
export function useMoveLead() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<unknown, unknown, MoveVars, { snap: Snapshot }>({
    mutationFn: ({ lead, to }) => leadsApi.updateStatus(lead.id, to),
    onMutate: async ({ lead, to }) => {
      if (to === 'lost') return { snap: [] };
      await qc.cancelQueries({ queryKey: LEADS_ROOT });
      const snap = qc.getQueriesData<LeadsResult>({ queryKey: LEADS_ROOT }) as Snapshot;
      patchStatus(qc, lead.id, to);
      return { snap };
    },
    onError: (err, { lead }, ctx) => {
      ctx?.snap.forEach(([key, data]) => qc.setQueryData(key, data));
      toast.fromError(err, `Could not move ${leadName(lead)}`);
    },
    onSuccess: (res, { lead, to }) => {
      if (isPendingApproval(res)) {
        toast.info(`Sent for approval: ${leadName(lead)} stays in ${stageLabel(lead.status)} until an admin approves.`);
        return;
      }
      if (to === 'lost') patchStatus(qc, lead.id, 'lost');
      toast.success(`${leadName(lead)} moved to ${stageLabel(to)}`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['admissions'] }),
  });
}

export function useLeadCalls(id: string | null) {
  return useQuery({
    queryKey: ['admissions', 'calls', id],
    queryFn: ({ signal }) => callsApi.list({ leadId: id as string, limit: 20 }, { signal }),
    enabled: !!id,
  });
}
