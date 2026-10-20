import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import type { StudentHealthEntry } from '../../types';
import { Button, ErrorState, Modal, Skeleton, Textarea, useToast } from '../../ui';

interface Props {
  student: StudentHealthEntry | null;
  onClose: () => void;
}

/**
 * The backend only exposes POST /messages/lead/:leadId, so the message goes to the parent
 * through their most recent lead.
 */
export function MessageParentModal({ student, onClose }: Props) {
  const toast = useToast();
  const [text, setText] = useState('');
  const parentId = student?.parent.id;

  const parentQuery = useQuery({
    queryKey: ['students', 'parent', parentId],
    queryFn: ({ signal }) => api.parents.get(parentId as string, { signal }),
    enabled: Boolean(parentId),
  });

  const lead = parentQuery.data
    ? [...parentQuery.data.leads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
    : undefined;
  const optedOut = parentQuery.data?.optedOut === true;

  const send = useMutation({
    mutationFn: () => api.messages.sendToLead((lead as { id: string }).id, text.trim()),
    onSuccess: (res) => {
      toast.success(`Message ${res.status} for ${student?.parent.fullName ?? 'parent'}`);
      setText('');
      onClose();
    },
    onError: (err) => toast.fromError(err, 'Could not send message'),
  });

  const canSend = Boolean(lead) && !optedOut && text.trim().length > 0;

  return (
    <Modal
      open={student !== null}
      onClose={onClose}
      title="Message parent"
      subtitle={student ? `${student.parent.fullName}, parent of ${student.fullName}` : undefined}
      width={460}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={send.isPending} disabled={!canSend} onClick={() => send.mutate()}>
            Send WhatsApp
          </Button>
        </>
      }
    >
      {parentQuery.isPending ? (
        <Skeleton height={90} />
      ) : parentQuery.isError ? (
        <ErrorState error={parentQuery.error} onRetry={() => void parentQuery.refetch()} retrying={parentQuery.isFetching} />
      ) : optedOut ? (
        <p className="sh-muted" role="alert">
          This parent has opted out of WhatsApp messages.
        </p>
      ) : !lead ? (
        <p className="sh-muted" role="alert">
          No enquiry is on file for this parent. The messaging API can only send through a lead, so this message cannot be sent from here.
        </p>
      ) : (
        <div className="sh-form">
          <Textarea label="Message" value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} rows={5} required />
          {send.isError && (
            <p className="sh-muted" role="alert">
              {getErrorMessage(send.error)}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
