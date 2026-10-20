import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { students } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import type { BatchDetail } from '../../types';
import { Button, Modal, Spinner, useToast } from '../../ui';
import { ImportSource } from '../imports/ImportSource';
import { parseStudentSheet } from '../imports/parsePeople';

export function ImportStudentsModal({ onClose, batches }: { onClose: () => void; batches: BatchDetail[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const parsed = useMemo(() => parseStudentSheet(text), [text]);

  const preview = useMutation({ mutationFn: () => students.importRows(parsed.rows, true) });
  const previewMutate = preview.mutate;
  const previewReset = preview.reset;
  useEffect(() => {
    previewReset();
    if (parsed.rows.length === 0) return;
    const t = setTimeout(() => previewMutate(), 400);
    return () => clearTimeout(t);
  }, [parsed, previewMutate, previewReset]);

  const run = useMutation({
    mutationFn: () => students.importRows(parsed.rows, false),
    onSuccess: (r) => {
      toast.success(`${r.created} student${r.created === 1 ? '' : 's'} added${r.existing ? `, ${r.existing} already existed` : ''}, ${r.enrollmentsAdded} batch enrolment${r.enrollmentsAdded === 1 ? '' : 's'}`);
      void qc.invalidateQueries({ queryKey: ['students'] });
      void qc.invalidateQueries({ queryKey: ['teacher', 'batches'] });
      onClose();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const p = preview.data;
  const problems = [...parsed.errors.map((e) => `Line ${e.line}: ${e.message}`), ...(p?.invalid.map((e) => `Row ${e.row}: ${e.message}`) ?? [])];
  const total = p ? p.created + p.existing : 0;
  const names = batches.map((b) => b.batchName).filter(Boolean);

  return (
    <Modal
      open
      onClose={onClose}
      title="Import students"
      subtitle="Register many students with their parents and batches"
      closeOnBackdrop={false}
      width={720}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={run.isPending}>
            Cancel
          </Button>
          <Button onClick={() => run.mutate()} loading={run.isPending} disabled={!p || total === 0 || run.isPending}>
            {total > 0 ? `Import ${total} student${total === 1 ? '' : 's'}` : 'Import'}
          </Button>
        </>
      }
    >
      <div className="sh-import">
        <p className="sh-form__hint">
          Columns: <strong>Student name, Parent name, Parent phone, Parent email, Class, Board, Date of birth, Admission date, Batches</strong>. Batches are existing batch names separated by{' '}
          <code>;</code> (for example <code>XII Chem; XII Math</code>) and are how the student&apos;s class and subjects are registered. Parents are matched by phone number, so
          brothers and sisters share one parent. Importing again never duplicates students; it only adds missing batches.
        </p>
        {names.length > 0 && (
          <details className="sh-import__batches">
            <summary>Available batch names ({names.length})</summary>
            <p>{names.join(' · ')}</p>
          </details>
        )}
        <ImportSource
          label="Students"
          template="students"
          value={text}
          onChange={setText}
          placeholder={'Teja Sree\tSuresh Kumar\t9876543210\t\t12\tCBSE\t09/03/2008\t\tXII Chem; XII Math'}
        />
        {text.trim() && (
          <p className="sh-import__summary" role="status">
            {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'} read
            {problems.length > 0 && <span className="sh-import__bad"> · {problems.length} need attention</span>}
            {parsed.rows.length > 0 && preview.isPending && (
              <>
                {' '}
                <Spinner size={12} /> checking…
              </>
            )}
            {p && ` · ${p.created} new, ${p.existing} existing, ${p.newParents} new parent${p.newParents === 1 ? '' : 's'}, ${p.enrollmentsAdded} batch enrolment${p.enrollmentsAdded === 1 ? '' : 's'}`}
          </p>
        )}
        {preview.isError && <p className="sh-import__bad">{getErrorMessage(preview.error)}</p>}
        {problems.length > 0 && (
          <ul className="sh-import__errors">
            {problems.slice(0, 8).map((m) => (
              <li key={m}>{m}</li>
            ))}
            {problems.length > 8 && <li>…and {problems.length - 8} more</li>}
          </ul>
        )}
      </div>
    </Modal>
  );
}
