import { X } from 'lucide-react';
import { Button } from '../../ui';

export interface ResultItem {
  label: string;
  reason: string;
}

export interface ActionResult {
  title: string;
  summary: string;
  tone: 'success' | 'warning' | 'danger';
  items: ResultItem[];
}

interface Props {
  result: ActionResult;
  onDismiss: () => void;
}

/** Shows the real outcome of a bulk action, including per-item skip and failure reasons from the server. */
export function ResultPanel({ result, onDismiss }: Props) {
  return (
    <div className={`rp-result rp-result--${result.tone}`} role="status">
      <div className="rp-result__head">
        <span>{result.title}</span>
        <span className="rp-spacer" />
        <Button variant="ghost" size="sm" iconOnly aria-label={`Dismiss: ${result.title}`} onClick={onDismiss}>
          <X size={14} aria-hidden="true" />
        </Button>
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-body)' }}>{result.summary}</div>
      {result.items.length > 0 && (
        <ul className="rp-result__list">
          {result.items.map((it, i) => (
            <li key={`${it.label}-${i}`}>
              <strong>{it.label}</strong>: {it.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
