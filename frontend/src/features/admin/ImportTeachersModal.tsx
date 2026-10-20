import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { api, type TeacherImportResult } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import { Button, Modal, Spinner, useToast } from '../../ui';
import { buildCsv, downloadTextFile } from '../imports/csv';
import { ImportSource } from '../imports/ImportSource';
import { parseTeacherSheet } from '../imports/parsePeople';

export function ImportTeachersModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [done, setDone] = useState<TeacherImportResult | null>(null);
  const parsed = useMemo(() => parseTeacherSheet(text), [text]);

  const batches = useQuery({ queryKey: ['teacher', 'batches'], queryFn: ({ signal }) => api.academic.batches({ signal }) });

  const preview = useMutation({ mutationFn: () => api.users.importTeachers(parsed.rows, true) });
  const previewMutate = preview.mutate;
  const previewReset = preview.reset;
  useEffect(() => {
    previewReset();
    if (parsed.rows.length === 0 || done) return;
    const t = setTimeout(() => previewMutate(), 400);
    return () => clearTimeout(t);
  }, [parsed, done, previewMutate, previewReset]);

  const run = useMutation({
    mutationFn: () => api.users.importTeachers(parsed.rows, false),
    onSuccess: (r) => {
      toast.success(`${r.created} teacher account${r.created === 1 ? '' : 's'} created${r.existing ? `, ${r.existing} already existed` : ''}`);
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['teacher', 'batches'] });
      setDone(r);
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const p = preview.data;
  const problems = [...parsed.errors.map((e) => `Line ${e.line}: ${e.message}`), ...(p?.invalid.map((e) => `Row ${e.row}: ${e.message}`) ?? [])];
  const canImport = !!p && p.created + p.existing > 0 && !run.isPending;

  const downloadCredentials = (r: TeacherImportResult) =>
    downloadTextFile('teacher-logins.csv', buildCsv(['Name', 'Email', 'Temporary password'], r.credentials.map((c) => [c.fullName, c.email, c.password])));

  if (done) {
    return (
      <Modal
        open
        onClose={onClose}
        title="Teachers imported"
        subtitle={`${done.created} created · ${done.existing} already existed · ${done.batchesAssigned} batch assignment${done.batchesAssigned === 1 ? '' : 's'}`}
        width={640}
        footer={<Button onClick={onClose}>Done</Button>}
      >
        <div className="adm-import">
          {done.emailed > 0 && (
            <p className="adm-banner adm-banner--ok" role="status">
              {done.emailed} login email{done.emailed === 1 ? '' : 's'} sent from security@e-kalavya.com. The same details are below as a backup.
            </p>
          )}
          {done.credentials.length > 0 ? (
            <>
              <p className="adm-banner adm-banner--warn" role="alert">
                These temporary passwords are shown <strong>only once</strong> and are not stored in readable form. Download them now and share each one privately with its teacher.
              </p>
              <table className="adm-cred">
                <caption className="adm-sr">Temporary logins</caption>
                <thead>
                  <tr>
                    <th scope="col">Teacher</th>
                    <th scope="col">Email</th>
                    <th scope="col">Temporary password</th>
                  </tr>
                </thead>
                <tbody>
                  {done.credentials.map((c) => (
                    <tr key={c.email}>
                      <td>{c.fullName}</td>
                      <td>{c.email}</td>
                      <td className="adm-mono">{c.password}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div>
                <Button variant="secondary" icon={<Download size={14} aria-hidden="true" />} onClick={() => downloadCredentials(done)}>
                  Download logins (CSV)
                </Button>
              </div>
            </>
          ) : (
            <p className="adm-muted">No new passwords were generated (every row either already existed or had its own password).</p>
          )}
          {done.warnings.length > 0 && (
            <ul className="adm-import__warn">
              {done.warnings.map((w) => (
                <li key={`${w.row}-${w.message}`}>
                  Row {w.row}: {w.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Import teachers"
      subtitle="Create many teacher accounts at once"
      closeOnBackdrop={false}
      width={720}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={run.isPending}>
            Cancel
          </Button>
          <Button onClick={() => run.mutate()} loading={run.isPending} disabled={!canImport}>
            {p && p.created + p.existing > 0 ? `Import ${p.created + p.existing} teacher${p.created + p.existing === 1 ? '' : 's'}` : 'Import'}
          </Button>
        </>
      }
    >
      <div className="adm-import">
        <p className="adm-muted">
          Columns: <strong>Full name, Email, Phone, Initials, Batches, Password</strong>. Batches are the names of existing batches separated by <code>;</code> (for example{' '}
          <code>XII Chem; XII Math</code>) and the teacher is assigned to them. Leave Password empty to have a secure one generated for you. Teachers who already exist are not duplicated.
        </p>
        {batches.data && batches.data.length > 0 && (
          <details className="adm-import__batches">
            <summary>Available batch names ({batches.data.length})</summary>
            <p>{batches.data.map((b) => b.batchName).filter(Boolean).join(' · ')}</p>
          </details>
        )}
        <ImportSource label="Teachers" template="teachers" value={text} onChange={setText} placeholder={'Priya Sharma\tpriya@example.com\t9876543210\tPKS\tXII Chem; XII Math'} />
        {text.trim() && (
          <p className="adm-import__summary" role="status">
            {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'} read
            {problems.length > 0 && <span className="adm-import__bad"> · {problems.length} need attention</span>}
            {parsed.rows.length > 0 && preview.isPending && (
              <>
                {' '}
                <Spinner size={12} /> checking…
              </>
            )}
            {p && ` · ${p.created} new, ${p.existing} existing, ${p.batchesAssigned} batch assignment${p.batchesAssigned === 1 ? '' : 's'}`}
          </p>
        )}
        {preview.isError && <p className="adm-import__bad">{getErrorMessage(preview.error)}</p>}
        {problems.length > 0 && (
          <ul className="adm-import__errors">
            {problems.slice(0, 8).map((m) => (
              <li key={m}>{m}</li>
            ))}
            {problems.length > 8 && <li>…and {problems.length - 8} more</li>}
          </ul>
        )}
        {p && p.warnings.length > 0 && (
          <ul className="adm-import__warn">
            {p.warnings.slice(0, 6).map((w) => (
              <li key={`${w.row}-${w.message}`}>
                Row {w.row}: {w.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
