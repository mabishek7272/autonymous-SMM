import { CheckCircle2, FileCheck2, MessageCircle, TriangleAlert } from 'lucide-react';
import type { StudentHealthEntry } from '../../types';
import { Badge, Button, RingGauge, Tooltip, healthTone, toneColor } from '../../ui';
import { LEVEL_LABEL, deriveFlags, lastAssessmentText, percentTone } from './health';

interface StudentCardProps {
  student: StudentHealthEntry;
  batchNames: string[];
  onProfile: (s: StudentHealthEntry) => void;
  onMessage: (s: StudentHealthEntry) => void;
  /** null when messaging is allowed; otherwise why it is disabled. */
  messageBlockedReason: string | null;
}

const LEVEL_BADGE = { GREEN: 'success', YELLOW: 'warning', RED: 'danger', UNKNOWN: 'neutral' } as const;

export function StudentCard({ student: s, batchNames, onProfile, onMessage, messageBlockedReason }: StudentCardProps) {
  const tone = healthTone(s.health);
  const flags = deriveFlags(s);
  const att = s.attendancePercentage;
  const msgButton = (
    <Button
      variant="warm"
      size="sm"
      icon={<MessageCircle size={12} aria-hidden="true" />}
      disabled={messageBlockedReason !== null}
      onClick={() => onMessage(s)}
      aria-label={`Message parent of ${s.fullName}`}
    >
      Message Parent
    </Button>
  );

  return (
    <article className="sh-card" style={{ borderTopColor: toneColor(tone) }} aria-label={`${s.fullName}, ${LEVEL_LABEL[s.health]}`}>
      <div className="sh-card__top">
        <RingGauge value={s.healthScore} label={`Health score for ${s.fullName}`} size={64} stroke={5} tone={tone} />
        <div className="sh-card__id">
          <h3 className="sh-card__name">{s.fullName}</h3>
          <div className="sh-badges">
            {batchNames.map((b) => (
              <Badge key={b} tone="primary">
                Batch {b}
              </Badge>
            ))}
            <Badge tone={LEVEL_BADGE[s.health]} uppercase>
              {LEVEL_LABEL[s.health]}
            </Badge>
          </div>
        </div>
        <div className="sh-att">
          <span className="sh-att__label">Attend.</span>
          <span
            className={`sh-att__chip sh-att__chip--${percentTone(att)}`}
            title={att === null ? 'No attendance marked yet' : `Last ${s.attendanceWindowDays} days`}
          >
            {att === null ? '—' : `${Math.round(att)}%`}
          </span>
        </div>
      </div>

      {s.subjectAverages.length > 0 ? (
        <div className="sh-subjects">
          {s.subjectAverages.map((sub) => (
            <div className="sh-subject" key={sub.subject}>
              <span className="sh-subject__name" title={sub.subject}>
                {sub.subject}
              </span>
              <div
                className="sh-subject__track"
                role="progressbar"
                aria-label={`${sub.subject} average`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={sub.averagePercentage}
              >
                <div
                  className="sh-subject__fill"
                  style={{ width: `${Math.min(100, Math.max(0, sub.averagePercentage))}%`, background: toneColor(percentTone(sub.averagePercentage)) }}
                />
              </div>
              <span className="sh-subject__val">{sub.averagePercentage}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="sh-muted">No subject scores recorded yet.</div>
      )}

      <div className="sh-last">
        <FileCheck2 size={12} aria-hidden="true" />
        {lastAssessmentText(s)}
      </div>

      {flags.length > 0 ? (
        <div className="sh-flags">
          {flags.map((f) => (
            <div key={f.id} className={`sh-flag sh-flag--${f.tone}`}>
              <TriangleAlert size={12} aria-hidden="true" />
              {f.text}
            </div>
          ))}
        </div>
      ) : s.health === 'UNKNOWN' ? (
        <div className="sh-muted">Not enough data to assess yet.</div>
      ) : (
        <div className="sh-ok">
          <CheckCircle2 size={12} aria-hidden="true" />
          No flags · on track
        </div>
      )}

      <div className="sh-card__actions">
        <Button variant="secondary" size="sm" onClick={() => onProfile(s)} aria-label={`View profile of ${s.fullName}`}>
          View Profile
        </Button>
        {messageBlockedReason ? <Tooltip content={messageBlockedReason}>{msgButton}</Tooltip> : msgButton}
      </div>
    </article>
  );
}
