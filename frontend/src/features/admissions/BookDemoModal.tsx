import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { appointments } from '../../services/api';
import { Button, DateInput, EmptyState, ErrorState, Modal, Spinner, useToast } from '../../ui';
import type { LeadWithParent } from '../../types';
import { formatDateTime, leadName } from './helpers';

interface BookDemoModalProps {
  lead: LeadWithParent | null;
  onClose: () => void;
}

export function BookDemoModal({ lead, onClose }: BookDemoModalProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const [date, setDate] = useState<string>('');
  const [slotIso, setSlotIso] = useState<string | null>(null);

  // With no date the server answers for today (IST) and reports which date that is.
  const calendar = useQuery({
    queryKey: ['admissions', 'calendar', lead?.id ?? null, date],
    queryFn: ({ signal }) => appointments.checkCalendar(date ? { date } : {}, { signal }),
    enabled: !!lead,
  });
  const shownDate = date || calendar.data?.date || '';

  const book = useMutation({
    mutationFn: (scheduledAt: string) => appointments.book({ leadId: (lead as LeadWithParent).id, scheduledAt }),
    onSuccess: (appt) => {
      toast.success(`Demo booked for ${leadName(lead as LeadWithParent)} on ${formatDateTime(appt.scheduledAt)}`);
      void qc.invalidateQueries({ queryKey: ['admissions'] });
      onClose();
    },
    onError: (err) => {
      toast.fromError(err, 'Could not book demo');
      void calendar.refetch();
    },
  });

  if (!lead) return null;
  const slots = calendar.data?.availableSlots ?? [];

  return (
    <Modal
      open
      onClose={onClose}
      title="Book Demo"
      subtitle={`${leadName(lead)} · times in ${calendar.data?.timezone ?? 'IST'}`}
      width={540}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={book.isPending}>
            Cancel
          </Button>
          <Button disabled={!slotIso} loading={book.isPending} onClick={() => slotIso && book.mutate(slotIso)}>
            Confirm booking
          </Button>
        </>
      }
    >
      <DateInput
        label="Demo date"
        value={shownDate}
        onChange={(e) => {
          setDate(e.target.value);
          setSlotIso(null);
        }}
      />
      <div>
        <div className="ek-label" id="adm-slots-label" style={{ marginBottom: 8 }}>
          Available slots
        </div>
        {calendar.isPending ? (
          <Spinner label="Checking calendar" />
        ) : calendar.isError ? (
          <ErrorState error={calendar.error} onRetry={() => void calendar.refetch()} retrying={calendar.isFetching} title="Could not check the calendar" />
        ) : slots.length === 0 ? (
          <EmptyState title="No free slots on this day" description="Pick another date." />
        ) : (
          <div className="adm-slots" role="group" aria-labelledby="adm-slots-label">
            {slots.map((s) => (
              <button key={s.iso} type="button" className="adm-chip" aria-pressed={slotIso === s.iso} onClick={() => setSlotIso(s.iso)}>
                {s.formatted}
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
