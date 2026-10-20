import type { CSSProperties } from 'react';
import { cx } from './cx';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  radius?: string | number;
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ width = '100%', height = 16, radius = 8, className, style }: SkeletonProps) {
  return <div aria-hidden="true" className={cx('ek-skeleton', className)} style={{ width, height, borderRadius: radius, ...style }} />;
}

interface SkeletonListProps {
  rows?: number;
  rowHeight?: number;
  label?: string;
}

/** Generic loading placeholder for lists/tables; announces itself to assistive tech. */
export function SkeletonList({ rows = 4, rowHeight = 44, label = 'Loading' }: SkeletonListProps) {
  return (
    <div role="status" aria-label={label} aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={rowHeight} radius={10} />
      ))}
    </div>
  );
}
