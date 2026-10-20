import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, CheckCircle2, ChevronDown, ChevronRight, FileText, Pencil, Send, Sparkles } from 'lucide-react';
import { api } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import type { ReportStatus, SendOutcome, WeeklyReportListItem } from '../../types';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Select, SkeletonList, Tabs, Textarea, useConfirm, useToast, type BadgeTone } from '../../ui';
import { formatWeekRange, formatIstDateTime, type WeekOption } from './dates';
import { reportKeys, useApprovedReports, useBatchOptions, useReportList } from './hooks';
import { ResultPanel, type ActionResult } from './ResultPanel';

type StatusFilter = 'all' | ReportStatus;

const STATUS_TONE: Record<ReportStatus, BadgeTone> = { draft: 'neutral', approved: 'info', sent: 'success', failed: 'danger' };
const STATUS_LABEL: Record<ReportStatus, string> = { draft: 'Draft', approved: 'Approved', sent: 'Sent', failed: 'Failed' };
const COLUMN_COUNT = 7;

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value)}%`;
}

interface Props {
  weekStart: string;
  batchId: string;
  weeks: WeekOption[];
  onWeekChange: (week: string) => void;
  onBatchChange: (batchId: string) => void;
}

export function WeeklyReportsSection({ weekStart, batchId, weeks, onWeekChange, onBatchChange }: Props) {
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const list = useReportList(weekStart, batchId, true);
  const approvedAll = useApprovedReports(true);
  const batches = useBatchOptions(true);

  const [status, setStatus] = useState<StatusFilter>('all');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);

  const rows = useMemo(() => list.data ?? [], [list.data]);
  const counts = useMemo(() => {
    const c: Record<ReportStatus, number> = { draft: 0, approved: 0, sent: 0, failed: 0 };
    for (const r of rows) c[r.status] += 1;
    return c;
  }, [rows]);
  const visible = useMemo(() => (status === 'all' ? rows : rows.filter((r) => r.status === status)), [rows, status]);
  const visibleDrafts = useMemo(() => visible.filter((r) => r.status === 'draft'), [visible]);
  const selectedDrafts = useMemo(() => rows.filter((r) => r.status === 'draft' && selected.has(r.id)), [rows, selected]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of [...rows, ...(approvedAll.data ?? [])]) m.set(r.id, r.student.fullName);
    return m;
  }, [rows, approvedAll.data]);
  const nameFor = (id: string) => nameById.get(id) ?? `Report ${id.slice(0, 8)}`;

  const refresh = () => qc.invalidateQueries({ queryKey: reportKeys.all });

  const generate = useMutation({
    mutationFn: () => api.reports.generate({ weekStart, batchId: batchId || undefined }),
    onSuccess: (res) => {
      const summary = `Created ${res.created}, regenerated ${res.regenerated}, kept ${res.keptExisting} existing, ${res.failed.length} failed.`;
      toast.success(`Drafts generated for ${formatWeekRange(res.weekStart)}: ${summary}`);
      setResult({
        title: 'Draft generation finished',
        summary,
        tone: res.failed.length > 0 ? 'warning' : 'success',
        items: res.failed.map((f) => ({ label: `Student ${f.studentId.slice(0, 8)}`, reason: f.error })),
      });
      void refresh();
    },
    onError: (err) => toast.fromError(err, 'Could not generate drafts'),
  });

  const saveSummary = useMutation({
    mutationFn: (v: { id: string; summary: string }) => api.reports.updateSummary(v.id, v.summary),
    onSuccess: () => {
      toast.success('Summary saved');
      setEditing(null);
      void refresh();
    },
    onError: (err) => toast.fromError(err, 'Could not save summary'),
  });

  const approve = useMutation({
    mutationFn: (id: string) => api.reports.approve(id),
    onSuccess: (_r, id) => {
      toast.success(`Approved report for ${nameFor(id)}`);
      setSelected((s) => new Set([...s].filter((x) => x !== id)));
      void refresh();
    },
    onError: (err) => toast.fromError(err, 'Could not approve'),
  });

  const bulkApprove = useMutation({
    mutationFn: (ids: string[]) => api.reports.bulkApprove(ids),
    onSuccess: (res) => {
      const summary = `Approved ${res.approved.length}, skipped ${res.skipped.length}.`;
      toast.success(summary);
      setResult({
        title: 'Bulk approve finished',
        summary,
        tone: res.skipped.length > 0 ? 'warning' : 'success',
        items: res.skipped.map((s) => ({ label: nameFor(s.id), reason: s.reason })),
      });
      setSelected(new Set());
      void refresh();
    },
    onError: (err) => toast.fromError(err, 'Could not approve selected reports'),
  });

  const sendOne = useMutation({
    mutationFn: (id: string) => api.reports.send(id),
    onSuccess: (_res, id) => {
      toast.success(`Report for ${nameFor(id)} sent to the parent`);
      void refresh();
    },
    onError: (err) => {
      toast.fromError(err, 'Could not send');
      void refresh();
    },
  });

  const sendAll = useMutation({
    mutationFn: () => api.reports.sendApproved(),
    onSuccess: (res) => {
      const summary = `Sent ${res.sent}, skipped ${res.skipped.length}, failed ${res.failed.length}.`;
      toast.success(summary);
      const reasonOf = (o: SendOutcome) => ({ label: nameFor(o.reportId), reason: 'reason' in o ? o.reason : o.outcome });
      setResult({
        title: 'Send run finished',
        summary,
        tone: res.failed.length > 0 ? 'danger' : res.skipped.length > 0 ? 'warning' : 'success',
        items: [...res.skipped.map(reasonOf), ...res.failed.map(reasonOf)],
      });
      void refresh();
    },
    onError: (err) => toast.fromError(err, 'Could not send approved reports'),
  });

  const approvedTotal = approvedAll.data?.length ?? 0;

  const onSendOne = async (r: WeeklyReportListItem) => {
    const ok = await confirm({
      title: 'Send report to parent?',
      message: `This sends ${r.student.fullName}'s weekly report to ${r.student.parent.fullName} on WhatsApp.`,
      confirmLabel: 'Send report',
    });
    if (ok) sendOne.mutate(r.id);
  };

  const onSendAll = async () => {
    const ok = await confirm({
      title: 'Send all approved reports?',
      message: `This sends ${approvedTotal} approved report${approvedTotal === 1 ? '' : 's'} to parents on WhatsApp, across all weeks and batches you can access. Sent messages cannot be recalled.`,
      confirmLabel: 'Send all approved',
    });
    if (ok) sendAll.mutate();
  };

  const toggleSelect = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allDraftsSelected = visibleDrafts.length > 0 && visibleDrafts.every((r) => selected.has(r.id));
  const toggleAllDrafts = () =>
    setSelected((s) => {
      const next = new Set(s);
      if (allDraftsSelected) visibleDrafts.forEach((r) => next.delete(r.id));
      else visibleDrafts.forEach((r) => next.add(r.id));
      return next;
    });

  const changeWeek = (w: string) => {
    setSelected(new Set());
    setExpanded(null);
    setEditing(null);
    onWeekChange(w);
  };
  const changeBatch = (b: string) => {
    setSelected(new Set());
    onBatchChange(b);
  };

  const batchName = batches.data?.find((b) => b.id === batchId)?.batchName ?? null;

  return (
    <Card aria-labelledby="rp-reports-title">
      <CardHeader
        title={<span id="rp-reports-title">Weekly student reports</span>}
        subtitle="Draft, review and send each student's weekly progress summary to their parent."
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Sparkles size={14} aria-hidden="true" />}
              loading={generate.isPending}
              onClick={() => generate.mutate()}
            >
              {batchId ? 'Generate drafts for this batch' : 'Generate drafts'}
            </Button>
            <Button
              variant="warm"
              icon={<Send size={14} aria-hidden="true" />}
              loading={sendAll.isPending}
              disabled={approvedTotal === 0}
              onClick={() => void onSendAll()}
            >
              {`Send all approved (${approvedTotal})`}
            </Button>
          </>
        }
      />

      <div className="rp-filters">
        <Select label="Week (Mon to Sat)" value={weekStart} onChange={(e) => changeWeek(e.target.value)} options={weeks} />
        <Select
          label="Batch"
          value={batchId}
          onChange={(e) => changeBatch(e.target.value)}
          placeholder="All batches"
          disabled={batches.isLoading}
          hint={batches.isError ? 'Batches could not be loaded' : undefined}
          options={(batches.data ?? []).map((b) => ({ value: b.id, label: b.batchName ?? 'Unnamed batch' }))}
        />
      </div>

      <div className="rp-toolbar">
        <Tabs<StatusFilter>
          ariaLabel="Filter reports by status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: 'All', count: rows.length },
            { value: 'draft', label: 'Draft', count: counts.draft },
            { value: 'approved', label: 'Approved', count: counts.approved },
            { value: 'sent', label: 'Sent', count: counts.sent },
            { value: 'failed', label: 'Failed', count: counts.failed },
          ]}
        />
        <span className="rp-spacer" />
        <Button
          variant="secondary"
          icon={<CheckCheck size={14} aria-hidden="true" />}
          loading={bulkApprove.isPending}
          disabled={selectedDrafts.length === 0}
          onClick={() => bulkApprove.mutate(selectedDrafts.map((r) => r.id))}
        >
          {`Approve selected (${selectedDrafts.length})`}
        </Button>
      </div>

      {result && <ResultPanel result={result} onDismiss={() => setResult(null)} />}

      {list.isLoading ? (
        <SkeletonList rows={5} />
      ) : list.isError ? (
        <ErrorState error={list.error} title="Could not load reports" onRetry={() => void list.refetch()} retrying={list.isRefetching} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<FileText size={22} aria-hidden="true" />}
          title="No reports for this week"
          description={`There are no reports for ${formatWeekRange(weekStart)}${batchName ? ` in ${batchName}` : ''} yet. Generate drafts to create them from attendance and assessment data.`}
          action={{ label: 'Generate drafts', onClick: () => generate.mutate(), loading: generate.isPending }}
        />
      ) : visible.length === 0 ? (
        <EmptyState icon={<FileText size={22} aria-hidden="true" />} title={`No ${status} reports`} description="Try a different status filter." />
      ) : (
        <div className="ek-table-wrap">
          <table className="ek-table rp-table">
            <caption className="ek-sr-only">Weekly student reports for {formatWeekRange(weekStart)}</caption>
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all draft reports"
                    checked={allDraftsSelected}
                    disabled={visibleDrafts.length === 0}
                    onChange={toggleAllDrafts}
                  />
                </th>
                <th>Student</th>
                <th className="is-right">Attendance</th>
                <th className="is-right">Avg score</th>
                <th>Summary</th>
                <th>Status</th>
                <th className="is-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const open = expanded === r.id;
                const isEditing = editing?.id === r.id;
                const optedOut = r.student.parent.optedOut;
                const sendable = r.status === 'approved' || r.status === 'failed';
                return (
                  <Fragment key={r.id}>
                    <tr>
                      <td>
                        {r.status === 'draft' && (
                          <input
                            type="checkbox"
                            aria-label={`Select report for ${r.student.fullName}`}
                            checked={selected.has(r.id)}
                            onChange={() => toggleSelect(r.id)}
                          />
                        )}
                      </td>
                      <td className="rp-student">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-expanded={open}
                          aria-label={`${open ? 'Collapse' : 'Expand'} report for ${r.student.fullName}`}
                          icon={open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                          onClick={() => setExpanded(open ? null : r.id)}
                        >
                          {r.student.fullName}
                        </Button>
                        <span className="rp-sub">
                          Parent: {r.student.parent.fullName}
                          {optedOut && ' (opted out)'}
                        </span>
                      </td>
                      <td className="is-right">{pct(r.metrics?.attendance.percentage)}</td>
                      <td className="is-right">{pct(r.metrics?.marks.percentage)}</td>
                      <td>
                        <div className="rp-preview" title={r.summary}>
                          {r.summary}
                        </div>
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                        {optedOut && (
                          <Badge tone="warning" style={{ marginLeft: 6 }}>
                            Parent opted out
                          </Badge>
                        )}
                      </td>
                      <td>
                        <div className="rp-actions">
                          {r.status === 'draft' && (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                icon={<Pencil size={13} aria-hidden="true" />}
                                aria-label={`Edit summary for ${r.student.fullName}`}
                                onClick={() => {
                                  setExpanded(r.id);
                                  setEditing({ id: r.id, text: r.summary });
                                }}
                              >
                                Edit
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                icon={<CheckCircle2 size={13} aria-hidden="true" />}
                                aria-label={`Approve report for ${r.student.fullName}`}
                                loading={approve.isPending && approve.variables === r.id}
                                onClick={() => approve.mutate(r.id)}
                              >
                                Approve
                              </Button>
                            </>
                          )}
                          {sendable && (
                            <Button
                              size="sm"
                              variant="warm"
                              icon={<Send size={13} aria-hidden="true" />}
                              aria-label={`Send report for ${r.student.fullName}`}
                              title={optedOut ? 'The parent has opted out of messages' : undefined}
                              disabled={optedOut}
                              loading={sendOne.isPending && sendOne.variables === r.id}
                              onClick={() => void onSendOne(r)}
                            >
                              {r.status === 'failed' ? 'Retry send' : 'Send'}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr className="rp-expand">
                        <td colSpan={COLUMN_COUNT}>
                          {isEditing && editing ? (
                            <form
                              className="rp-edit"
                              onSubmit={(e) => {
                                e.preventDefault();
                                const text = editing.text.trim();
                                if (text) saveSummary.mutate({ id: r.id, summary: text });
                              }}
                            >
                              <Textarea
                                label={`Summary for ${r.student.fullName}`}
                                rows={6}
                                maxLength={4000}
                                value={editing.text}
                                error={editing.text.trim() ? undefined : 'Summary cannot be empty'}
                                hint={`${editing.text.length}/4000 characters`}
                                onChange={(e) => setEditing({ id: r.id, text: e.target.value })}
                              />
                              <div className="rp-edit__actions">
                                <Button type="submit" size="sm" loading={saveSummary.isPending} disabled={!editing.text.trim()}>
                                  Save summary
                                </Button>
                                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                                  Cancel
                                </Button>
                              </div>
                            </form>
                          ) : (
                            <p className="rp-summary">{r.summary}</p>
                          )}
                          <div className="rp-meta">
                            {r.metrics?.weakSubjects && r.metrics.weakSubjects.length > 0 && <span>Weak subjects: {r.metrics.weakSubjects.join(', ')}</span>}
                            {r.metrics && <span>Summary written by: {r.metrics.summarySource === 'llm' ? 'AI' : 'template'}</span>}
                            {r.approvedAt && <span>Approved {formatIstDateTime(r.approvedAt)}</span>}
                            {r.sentAt && <span>Sent {formatIstDateTime(r.sentAt)}</span>}
                            {r.status === 'failed' && <span>The last send attempt failed. Use Retry send to try again.</span>}
                            {r.status !== 'draft' && <span>Only drafts can be edited.</span>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {approvedAll.isError && (
        <p className="ek-hint" role="alert">
          Could not count approved reports: {getErrorMessage(approvedAll.error)}
        </p>
      )}
    </Card>
  );
}
