import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import { Button, Modal, Spinner, useToast } from '../../ui';
import { ImportSource } from '../imports/ImportSource';
import { classLinkKeys } from './hooks';
import { parseTimetablePaste } from './parseTimetable';

export function TimetableImportModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const parsed = useMemo(() => parseTimetablePaste(text), [text]);

  const preview = useMutation({ mutationFn: () => api.classLinks.timetableImport(parsed.rows, true) });
  const previewMutate = preview.mutate;
  const previewReset = preview.reset;
  useEffect(() => {
    previewReset();
    if (parsed.rows.length === 0 || parsed.errors.length > 0) return;
    const t = setTimeout(() => previewMutate(), 400);
    return () => clearTimeout(t);
  }, [parsed, previewMutate, previewReset]);

  const run = useMutation({
    mutationFn: () => api.classLinks.timetableImport(parsed.rows, false),
    onSuccess: (r) => {
      toast.success(`Timetable imported: ${r.batches} batch(es), ${r.slots} weekly slot(s), ${r.linksToCreate} new link(s)`);
      void qc.invalidateQueries({ queryKey: classLinkKeys.list });
      void qc.invalidateQueries({ queryKey: classLinkKeys.batches });
      onClose();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const ready = parsed.rows.length > 0 && parsed.errors.length === 0;
  const p = preview.data;

  return (
    <Modal
      open
      onClose={onClose}
      title="Import weekly timetable"
      subtitle="Paste your timetable: day, time slot, class & subject, faculty, meeting link"
      closeOnBackdrop={false}
      width={720}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={run.isPending}>
            Cancel
          </Button>
          <Button onClick={() => run.mutate()} loading={run.isPending} disabled={!ready || run.isPending || preview.isError}>
            {ready ? `Import ${parsed.rows.length} slot${parsed.rows.length === 1 ? '' : 's'}` : 'Import'}
          </Button>
        </>
      }
    >
      <div className="cl__import">
        <p className="cl__hint">
          Each class &amp; subject (for example <strong>XII Chem</strong>) becomes a batch with its weekly slots; every meeting link is added to the library once and can be shared by many
          batches. If a class uses a different room on some day, that slot keeps its own link. Importing again <strong>replaces the timetable of the batches in the paste</strong> and
          leaves other batches alone. Times are in IST.
        </p>
        <ImportSource
          label="Timetable"
          template="timetable"
          value={text}
          onChange={setText}
          placeholder={'Monday\t6:30 – 7:30 PM\tXII Chem\tHML, Teja Sree\thttps://teams.microsoft.com/meet/…\n\t7:30 – 8:30 PM\tXII Math\tSRI, Layana\thttps://teams.microsoft.com/meet/…'}
        />
        {text.trim() && (
          <p className="cl__summary" role="status">
            {parsed.rows.length} slot{parsed.rows.length === 1 ? '' : 's'} read
            {parsed.errors.length > 0 && <span className="cl__bad"> · {parsed.errors.length} line{parsed.errors.length === 1 ? '' : 's'} need fixing</span>}
            {ready && preview.isPending && (
              <>
                {' '}
                <Spinner size={12} /> checking…
              </>
            )}
            {ready && p && ` · ${p.batches} batch${p.batches === 1 ? '' : 'es'} (${p.batchesToCreate} new), ${p.links} link${p.links === 1 ? '' : 's'} (${p.linksToCreate} new)`}
          </p>
        )}
        {preview.isError && <p className="cl__bad">{getErrorMessage(preview.error)}</p>}
        {parsed.errors.length > 0 && (
          <ul className="cl__errors">
            {parsed.errors.slice(0, 8).map((e) => (
              <li key={e.line}>
                Line {e.line}: {e.message}
              </li>
            ))}
            {parsed.errors.length > 8 && <li>…and {parsed.errors.length - 8} more</li>}
          </ul>
        )}
      </div>
    </Modal>
  );
}
