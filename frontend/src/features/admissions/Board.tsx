import { useState, type DragEvent } from 'react';
import { Clock, Sparkles } from 'lucide-react';
import { Badge, Button } from '../../ui';
import { LEAD_STAGES, nextStageLabel, nextStatus, type LeadStage, type LeadStatus } from '../../types/lead-stages';
import type { LeadWithParent } from '../../types';
import { academicLine, leadName, sourceLabel, timeAgo } from './helpers';

interface LeadCardProps {
  lead: LeadWithParent;
  moving: boolean;
  onOpen: (lead: LeadWithParent) => void;
  onMessage: (lead: LeadWithParent) => void;
  onMove: (lead: LeadWithParent, to: LeadStatus) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
}

function LeadCard({ lead, moving, onOpen, onMessage, onMove, onDragStart, onDragEnd }: LeadCardProps) {
  const name = leadName(lead);
  const academic = academicLine(lead);
  const note = lead.notes ?? lead.requirements;
  const next = nextStatus(lead.status);
  const nextLabel = nextStageLabel(lead.status);
  return (
    <article
      className="adm-card"
      draggable
      aria-busy={moving || undefined}
      aria-label={`Lead ${name}`}
      onDragStart={(e: DragEvent) => {
        e.dataTransfer.setData('text/plain', lead.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(lead.id);
      }}
      onDragEnd={onDragEnd}
    >
      <div className="adm-card__top">
        <span className="adm-card__name">{name}</span>
        {lead.aiScore !== null && (
          <span className="adm-score" title="AI score">
            <Sparkles size={10} aria-hidden="true" />
            <span aria-label={`AI score ${lead.aiScore}`}>{lead.aiScore}</span>
          </span>
        )}
      </div>
      <div className="adm-card__meta">
        <span className="adm-card__phone">{lead.parent.whatsappNumber}</span>
        {lead.source && <Badge tone="neutral">{sourceLabel(lead.source)}</Badge>}
        {lead.parent.optedOut && <Badge tone="danger">Opted out</Badge>}
      </div>
      {academic && <div className="adm-card__academic">{academic}</div>}
      {note && <div className="adm-card__note">“{note}”</div>}
      <div className="adm-card__foot">
        <span className="adm-card__time">
          <Clock size={11} aria-hidden="true" />
          Updated {timeAgo(lead.updatedAt)}
        </span>
      </div>
      <div className="adm-card__actions">
        <Button variant="secondary" size="sm" aria-label={`View ${name}`} onClick={() => onOpen(lead)}>
          View
        </Button>
        <Button variant="secondary" size="sm" aria-label={`Message ${name}`} onClick={() => onMessage(lead)}>
          Message
        </Button>
        {next && nextLabel && (
          <Button
            variant="warm"
            size="sm"
            className="adm-card__move"
            loading={moving}
            aria-label={`Move ${name} to ${nextLabel}`}
            onClick={() => onMove(lead, next)}
          >
            {nextLabel} ▸
          </Button>
        )}
      </div>
    </article>
  );
}

interface BoardProps {
  leads: LeadWithParent[];
  movingId: string | null;
  onOpen: (lead: LeadWithParent) => void;
  onMessage: (lead: LeadWithParent) => void;
  onMove: (lead: LeadWithParent, to: LeadStatus) => void;
}

export function Board({ leads, movingId, onOpen, onMessage, onMove }: BoardProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStatus, setOverStatus] = useState<LeadStatus | null>(null);

  const drop = (e: DragEvent, stage: LeadStage) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || dragId;
    setOverStatus(null);
    setDragId(null);
    const lead = leads.find((l) => l.id === id);
    if (lead && lead.status !== stage.status) onMove(lead, stage.status);
  };

  return (
    <div className="adm-board" role="group" aria-label="Admissions pipeline">
      {LEAD_STAGES.map((stage) => {
        const items = leads.filter((l) => l.status === stage.status);
        return (
          <section
            key={stage.status}
            className={`adm-col${overStatus === stage.status ? ' adm-col--over' : ''}`}
            aria-label={`${stage.label} column`}
            onDragOver={(e) => {
              e.preventDefault();
              if (overStatus !== stage.status) setOverStatus(stage.status);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverStatus(null);
            }}
            onDrop={(e) => drop(e, stage)}
          >
            <header className="adm-col__head">
              <span className="adm-col__dot" style={{ background: stage.dot }} aria-hidden="true" />
              <h2 className="adm-col__name">{stage.label}</h2>
              <span className="adm-col__count" style={{ background: stage.countBg, color: stage.countColor }} aria-label={`${items.length} leads`}>
                {items.length}
              </span>
            </header>
            {items.map((lead) => (
              <LeadCard
                key={lead.id}
                lead={lead}
                moving={movingId === lead.id}
                onOpen={onOpen}
                onMessage={onMessage}
                onMove={onMove}
                onDragStart={setDragId}
                onDragEnd={() => {
                  setDragId(null);
                  setOverStatus(null);
                }}
              />
            ))}
            {items.length === 0 && <div className="adm-col__empty">No leads here</div>}
          </section>
        );
      })}
    </div>
  );
}
