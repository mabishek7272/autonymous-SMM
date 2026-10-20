import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { leads as leadsApi } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import { Button, Modal, Spinner, useToast } from '../../ui';
import { ImportSource } from '../imports/ImportSource';
import { stageLabel } from '../../types/lead-stages';
import type { LeadStatus } from '../../types';
import { parseLeadSheet } from './parseLeadSheet';

export function ImportLeadsModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const parsed = useMemo(() => parseLeadSheet(text), [text]);

  const preview = useMutation({ mutationFn: () => leadsApi.importRows(parsed.rows, true) });
  const previewMutate = preview.mutate;
  const previewReset = preview.reset;
  useEffect(() => {
    previewReset();
    if (parsed.rows.length === 0) return;
    const t = setTimeout(() => previewMutate(), 400);
    return () => clearTimeout(t);
  }, [parsed, previewMutate, previewReset]);

  const run = useMutation({
    mutationFn: () => leadsApi.importRows(parsed.rows, false),
    onSuccess: (r) => {
      toast.success(`Imported ${r.created} lead${r.created === 1 ? '' : 's'}${r.skippedDuplicates ? ` (${r.skippedDuplicates} duplicate${r.skippedDuplicates === 1 ? '' : 's'} skipped)` : ''}`);
      void qc.invalidateQueries({ queryKey: ['admissions'] });
      void qc.invalidateQueries({ queryKey: ['leads'] });
      onClose();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const p = preview.data;
  const importable = p ? p.created : 0;

  return (
    <Modal
      open
      onClose={onClose}
      title="Import enquiry sheet"
      subtitle="Paste your leads from Excel or Google Sheets"
      closeOnBackdrop={false}
      width={720}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={run.isPending}>
            Cancel
          </Button>
          <Button onClick={() => run.mutate()} loading={run.isPending} disabled={run.isPending || !p || importable === 0}>
            {p && importable > 0 ? `Import ${importable} lead${importable === 1 ? '' : 's'}` : 'Import'}
          </Button>
        </>
      }
    >
      <div className="adm-import">
        <p className="adm-import__hint">
          Columns in order: <strong>Lead name, Class, Board, Contact no., Timeline, Notes / subject needed, Location / remarks</strong>. A header row is skipped. The pipeline stage is worked
          out from the notes (for example &ldquo;Demo at 6:30 PM&rdquo; goes to <em>Demo Booked</em>, &ldquo;Not interested&rdquo; to <em>Lost</em>, &ldquo;Enrolled&rdquo; to <em>Admission</em>);
          anything unclear stays in <em>New</em>. Numbers already in the system are not duplicated.
        </p>
        <ImportSource label="Rows" template="leads" value={text} onChange={setText} placeholder={'Chithraa\t10\tCBSE\t7299989912\tWithin 1 Week\tCall again on Wednesday'} />
        {text.trim() && (
          <p className="adm-import__summary" role="status">
            {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'} read
            {parsed.errors.length > 0 && <span className="adm-import__bad"> · {parsed.errors.length} need fixing</span>}
            {parsed.rows.length > 0 && preview.isPending && (
              <>
                {' '}
                <Spinner size={12} /> checking…
              </>
            )}
            {p && ` · ${p.created} new lead${p.created === 1 ? '' : 's'} (${p.newParents} new contact${p.newParents === 1 ? '' : 's'}), ${p.skippedDuplicates} duplicate${p.skippedDuplicates === 1 ? '' : 's'} skipped`}
          </p>
        )}
        {p && p.created > 0 && (
          <p className="adm-import__stages">
            {Object.entries(p.byStatus)
              .map(([status, n]) => `${n} → ${stageLabel(status as LeadStatus)}`)
              .join(' · ')}
          </p>
        )}
        {preview.isError && <p className="adm-import__bad">{getErrorMessage(preview.error)}</p>}
        {(parsed.errors.length > 0 || (p && p.invalid.length > 0)) && (
          <ul className="adm-import__errors">
            {parsed.errors.slice(0, 6).map((e) => (
              <li key={`l${e.line}`}>
                Line {e.line}: {e.message}
              </li>
            ))}
            {p?.invalid.slice(0, 6).map((e) => (
              <li key={`r${e.row}`}>
                Row {e.row}: {e.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
