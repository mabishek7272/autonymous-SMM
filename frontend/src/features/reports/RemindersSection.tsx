import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BellRing, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { api } from '../../services/api';
import type { ReminderRule, RuleRunResult } from '../../types';
import { REMINDER_TEMPLATE_PLACEHOLDERS } from '../../types';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, SkeletonList, Toggle, useConfirm, useToast } from '../../ui';
import { DAY_NAMES, formatIstDateTime } from './dates';
import { reportKeys, useReminderRules } from './hooks';
import { ReminderRuleModal } from './ReminderRuleModal';
import { ResultPanel, type ActionResult } from './ResultPanel';
import { MONDAY_REMINDER_TEMPLATE, splitTemplate } from './template';

function runToResult(run: RuleRunResult): ActionResult {
  const parts = [`Sent ${run.sent}`, `skipped ${run.skipped.length}`, `failed ${run.failed.length}`];
  if (run.note) parts.push(run.note);
  return {
    title: `Run finished: ${run.ruleName}`,
    summary: `${parts[0]}, ${parts[1]}, ${parts[2]}.${run.note ? ` ${run.note}` : ''}`,
    tone: run.failed.length > 0 ? 'danger' : run.skipped.length > 0 || run.note ? 'warning' : 'success',
    items: [
      ...run.skipped.map((s) => ({ label: s.name, reason: `skipped: ${s.reason}` })),
      ...run.failed.map((f) => ({ label: f.name, reason: `failed: ${f.error}` })),
    ],
  };
}

export function RemindersSection() {
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const rules = useReminderRules(true);
  const [modal, setModal] = useState<{ rule: ReminderRule | null } | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: reportKeys.rules });

  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => api.reminders.update(v.id, { enabled: v.enabled }),
    onSuccess: (r) => {
      toast.success(`"${r.name}" ${r.enabled ? 'enabled' : 'disabled'}`);
      void refresh();
    },
    onError: (err) => toast.fromError(err, 'Could not update the reminder'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.reminders.remove(id),
    onSuccess: () => {
      toast.success('Reminder deleted');
      void refresh();
    },
    onError: (err) => toast.fromError(err, 'Could not delete the reminder'),
  });

  const runNow = useMutation({
    mutationFn: (id: string) => api.reminders.runNow(id),
    onSuccess: (run) => {
      toast.success(`"${run.ruleName}": sent ${run.sent}, skipped ${run.skipped.length}, failed ${run.failed.length}`);
      setResult(runToResult(run));
      void refresh();
    },
    onError: (err) => toast.fromError(err, 'Could not run the reminder'),
  });

  const createDefault = useMutation({
    mutationFn: () =>
      api.reminders.create({
        name: 'Monday attendance reminder',
        audience: 'teacher',
        dayOfWeek: 1,
        timeOfDay: '09:00',
        template: MONDAY_REMINDER_TEMPLATE,
        enabled: true,
      }),
    onSuccess: (r) => {
      toast.success(`Created "${r.name}"`);
      void refresh();
    },
    onError: (err) => toast.fromError(err, 'Could not create the reminder'),
  });

  const onDelete = async (rule: ReminderRule) => {
    const ok = await confirm({
      title: 'Delete this reminder?',
      message: `"${rule.name}" will stop sending and cannot be restored.`,
      confirmLabel: 'Delete reminder',
      tone: 'danger',
    });
    if (ok) remove.mutate(rule.id);
  };

  const onRun = async (rule: ReminderRule) => {
    const ok = await confirm({
      title: 'Run this reminder now?',
      message: `This immediately sends "${rule.name}" on WhatsApp, ignoring its schedule.`,
      confirmLabel: 'Run now',
    });
    if (ok) runNow.mutate(rule.id);
  };

  return (
    <Card aria-labelledby="rp-reminders-title">
      <CardHeader
        title={<span id="rp-reminders-title">Weekly teacher reminders</span>}
        subtitle="WhatsApp nudges that go to teachers on a fixed day and time (IST)."
        actions={
          <Button icon={<Plus size={14} aria-hidden="true" />} onClick={() => setModal({ rule: null })}>
            New reminder
          </Button>
        }
      />
      <div className="rp-phlist" style={{ marginBottom: 14 }}>
        <span>Supported placeholders:</span>
        {REMINDER_TEMPLATE_PLACEHOLDERS.map((p) => (
          <code key={p} className="rp-ph">{`{{${p}}}`}</code>
        ))}
      </div>

      {result && <ResultPanel result={result} onDismiss={() => setResult(null)} />}

      {rules.isLoading ? (
        <SkeletonList rows={2} />
      ) : rules.isError ? (
        <ErrorState error={rules.error} title="Could not load reminders" onRetry={() => void rules.refetch()} retrying={rules.isRefetching} />
      ) : (rules.data ?? []).length === 0 ? (
        <EmptyState
          icon={<BellRing size={22} aria-hidden="true" />}
          title="No reminders yet"
          description="Teachers are not being reminded to mark attendance. Create the standard Monday 9:00 reminder, then adjust it if needed."
          action={{ label: 'Create the default Monday 9:00 reminder', onClick: () => createDefault.mutate(), loading: createDefault.isPending }}
        />
      ) : (
        <ul className="rp-rules" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {(rules.data ?? []).map((rule) => (
            <li key={rule.id} className="rp-rule">
              <div className="rp-rule__top">
                <span className="rp-rule__name">{rule.name}</span>
                <Badge tone={rule.enabled ? 'success' : 'neutral'}>{rule.enabled ? 'Enabled' : 'Disabled'}</Badge>
                <Badge tone="primary">{rule.audience === 'teacher' ? 'Teachers' : 'Parents'}</Badge>
                <span className="rp-rule__when">
                  {DAY_NAMES[rule.dayOfWeek] ?? `Day ${rule.dayOfWeek}`} at {rule.timeOfDay} IST
                  {' · '}
                  {rule.lastRunAt ? `last run ${formatIstDateTime(rule.lastRunAt)}` : 'never run'}
                </span>
                <span className="rp-spacer" />
                <Toggle
                  label={`Enabled: ${rule.name}`}
                  hideLabel
                  checked={rule.enabled}
                  disabled={toggle.isPending && toggle.variables?.id === rule.id}
                  onChange={(enabled) => toggle.mutate({ id: rule.id, enabled })}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Play size={13} aria-hidden="true" />}
                  aria-label={`Run ${rule.name} now`}
                  loading={runNow.isPending && runNow.variables === rule.id}
                  onClick={() => void onRun(rule)}
                >
                  Run now
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Pencil size={13} aria-hidden="true" />}
                  aria-label={`Edit ${rule.name}`}
                  onClick={() => setModal({ rule })}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={13} aria-hidden="true" />}
                  aria-label={`Delete ${rule.name}`}
                  loading={remove.isPending && remove.variables === rule.id}
                  onClick={() => void onDelete(rule)}
                >
                  Delete
                </Button>
              </div>
              <p className="rp-template" aria-label={`Template for ${rule.name}`}>
                {splitTemplate(rule.template).map((part, i) =>
                  part.placeholder ? (
                    <code key={i} className="rp-ph">
                      {part.text}
                    </code>
                  ) : (
                    <span key={i}>{part.text}</span>
                  ),
                )}
              </p>
            </li>
          ))}
        </ul>
      )}

      {modal && (
        <ReminderRuleModal key={modal.rule?.id ?? 'new'} rule={modal.rule} open onClose={() => setModal(null)} onSaved={() => void refresh()} />
      )}
    </Card>
  );
}
