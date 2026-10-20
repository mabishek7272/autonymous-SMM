import type { BatchDetail } from '../../types';
import { Badge } from '../../ui';
import { batchLabel } from './helpers';
import { countRoster, type BatchAttendanceToday } from './hooks';

interface BatchListProps {
  batches: readonly BatchDetail[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Today's attendance per batch; undefined when the viewer cannot read attendance. */
  today?: readonly BatchAttendanceToday[];
}

export function BatchList({ batches, selectedId, onSelect, today }: BatchListProps) {
  return (
    <nav aria-label="Batches" className="tp__side">
      <div className="tp__side-head">Batches</div>
      {batches.map((b) => {
        const att = today?.find((t) => t.batchId === b.id);
        const counts = countRoster(att?.roster ?? null);
        const students = b.enrollments.length;
        let barLabel: string | null = null;
        let pct = 0;
        if (att) {
          if (att.loading) barLabel = '…';
          else if (att.failed || !att.roster) barLabel = 'n/a';
          else if (counts.marked === 0) barLabel = 'Not marked';
          else {
            barLabel = `${counts.present}/${counts.total}`;
            pct = counts.total ? (counts.present / counts.total) * 100 : 0;
          }
        }
        return (
          <button
            key={b.id}
            type="button"
            className="tp__batch"
            aria-current={b.id === selectedId}
            onClick={() => onSelect(b.id)}
          >
            <div className="tp__batch-row">
              <span className="tp__batch-name">{batchLabel(b)}</span>
              <Badge>{b.course.courseName}</Badge>
            </div>
            <span className="tp__batch-meta">
              {b.teacher?.fullName ?? 'No teacher'} · {students} {students === 1 ? 'student' : 'students'}
            </span>
            {barLabel !== null && (
              <div className="tp__batch-row" style={{ justifyContent: 'flex-start' }}>
                <div
                  className="tp__bar"
                  role="img"
                  aria-label={
                    counts.marked > 0
                      ? `Today: ${counts.present} of ${counts.total} present, ${counts.total - counts.marked} unmarked`
                      : 'Attendance not marked today'
                  }
                >
                  <span style={{ width: `${pct}%` }} />
                </div>
                <span className="tp__bar-label">{barLabel}</span>
              </div>
            )}
          </button>
        );
      })}
    </nav>
  );
}
