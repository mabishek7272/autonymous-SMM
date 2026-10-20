import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { dashboard } from '../../services/api';
import { stageLabel } from '../../types';
import { Card, EmptyState, ErrorState, Skeleton, cx } from '../../ui';
import { formatNumber } from './format';
import { useMounted } from './hooks';

export function FunnelCard() {
  const q = useQuery({ queryKey: ['dashboard', 'funnel-analytics'], queryFn: ({ signal }) => dashboard.funnelAnalytics({ signal }) });
  const mounted = useMounted();
  const data = q.data;
  const stages = data?.stages ?? [];
  const base = stages[0]?.reached ?? 0;

  let leak: { from: string; to: string; pct: number } | null = null;
  stages.forEach((s, i) => {
    if (i > 0 && s.dropOffFromPrevious !== null && (leak === null || s.dropOffFromPrevious > leak.pct)) {
      leak = { from: stageLabel(stages[i - 1].stage), to: stageLabel(s.stage), pct: s.dropOffFromPrevious };
    }
  });
  const biggest = leak as { from: string; to: string; pct: number } | null;

  return (
    <Card>
      <div className="ov-card-head">
        <h2 className="ov-card-title">Conversion Funnel</h2>
        <span className="ov-meta">all leads, all time</span>
      </div>
      {q.isLoading ? (
        <Skeleton height={200} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} title="Could not load the funnel" />
      ) : !data || data.totalLeads === 0 ? (
        <EmptyState title="No leads yet" description="The funnel fills in as leads are created." />
      ) : (
        <>
          <ol className="ov-funnel" aria-label="Leads that reached each stage">
            {stages.map((s, i) => {
              const width = base > 0 ? (s.reached / base) * 100 : 0;
              const drop = s.dropOffFromPrevious;
              return (
                <li key={s.stage} className="ov-funnel__row">
                  <span className="ov-funnel__label">{stageLabel(s.stage)}</span>
                  <div className="ov-funnel__track">
                    <div className="ov-funnel__bar" style={{ width: mounted ? `${Math.max(width, 0)}%` : '0%' }}>
                      <span>{formatNumber(s.reached)}</span>
                    </div>
                  </div>
                  <span className={cx('ov-funnel__drop', drop !== null && drop >= 40 && 'ov-funnel__drop--bad')} title={i === 0 ? 'First stage' : 'Drop-off from previous stage'}>
                    {i === 0 || drop === null ? '—' : `−${drop}%`}
                  </span>
                </li>
              );
            })}
          </ol>
          <div className="ov-note">
            <Sparkles size={13} color="var(--primary)" aria-hidden="true" />
            <span>
              {biggest ? `Biggest leak: ${biggest.from} → ${biggest.to} (−${biggest.pct}%).` : 'No drop-off to report yet.'}
              {data.lost.count > 0 && ` ${formatNumber(data.lost.count)} lost lead${data.lost.count === 1 ? '' : 's'}.`}
              {data.overallConversionRate !== null && ` Overall conversion ${data.overallConversionRate}%.`}
            </span>
          </div>
        </>
      )}
    </Card>
  );
}
