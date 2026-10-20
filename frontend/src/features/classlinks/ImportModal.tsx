import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import { Button, Modal, useToast } from '../../ui';
import { ImportSource } from '../imports/ImportSource';
import { classLinkKeys } from './hooks';
import { parseLinkImport } from './parseImport';

export function ImportModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const parsed = useMemo(() => parseLinkImport(text), [text]);

  const run = useMutation({
    mutationFn: () => api.classLinks.bulk(parsed.links),
    onSuccess: (r) => {
      toast.success(`Imported ${r.total} link(s): ${r.created} new, ${r.updated} updated`);
      void qc.invalidateQueries({ queryKey: classLinkKeys.list });
      onClose();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Import class links"
      subtitle="Paste rows from Excel or Google Sheets"
      closeOnBackdrop={false}
      width={640}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={run.isPending}>
            Cancel
          </Button>
          <Button onClick={() => run.mutate()} loading={run.isPending} disabled={run.isPending || parsed.links.length === 0}>
            {parsed.links.length ? `Import ${parsed.links.length} link${parsed.links.length === 1 ? '' : 's'}` : 'Import'}
          </Button>
        </>
      }
    >
      <div className="cl__import">
        <p className="cl__hint">
          One link per row, columns in this order: <strong>Name</strong>, <strong>Link</strong>, Class, Board, Subject (the last three are optional).
          Names that already exist are updated with the new link; nothing is deleted.
        </p>
        <ImportSource label="Rows" template="classLinks" value={text} onChange={setText} placeholder={'8th CBSE Science\thttps://teams.microsoft.com/l/meetup-join/...\t8\tCBSE\tScience'} />
        {text.trim() && (
          <p className="cl__summary" role="status">
            {parsed.links.length} valid link{parsed.links.length === 1 ? '' : 's'}
            {parsed.errors.length > 0 && <span className="cl__bad"> · {parsed.errors.length} row{parsed.errors.length === 1 ? '' : 's'} need fixing</span>}
          </p>
        )}
        {parsed.errors.length > 0 && (
          <ul className="cl__errors">
            {parsed.errors.slice(0, 8).map((e) => (
              <li key={e.line}>
                Row {e.line}: {e.message}
              </li>
            ))}
            {parsed.errors.length > 8 && <li>…and {parsed.errors.length - 8} more</li>}
          </ul>
        )}
      </div>
    </Modal>
  );
}
