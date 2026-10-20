import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cx } from './cx';

export interface TableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Makes the header a sort button. Return a number or string; null/undefined sort last. */
  sortValue?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right' | 'center';
  width?: string | number;
}

type Dir = 'asc' | 'desc';

interface TableProps<T> {
  columns: readonly TableColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  caption: string;
  initialSort?: { key: string; dir: Dir };
  onRowClick?: (row: T) => void;
  /** Rendered instead of the table when there are no rows. */
  empty?: ReactNode;
}

function compare(a: string | number | null | undefined, b: string | number | null | undefined, dir: Dir): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  const res = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  return dir === 'asc' ? res : -res;
}

export function Table<T>({ columns, rows, rowKey, caption, initialSort, onRowClick, empty }: TableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: Dir } | null>(initialSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const sv = col.sortValue;
    return [...rows].sort((x, y) => compare(sv(x), sv(y), sort.dir));
  }, [rows, columns, sort]);

  if (rows.length === 0 && empty) return <>{empty}</>;

  const toggle = (key: string) => setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  return (
    <div className="ek-table-wrap">
      <table className="ek-table">
        <caption className="ek-sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={cx(c.align === 'right' && 'is-right', c.align === 'center' && 'is-center')}
                  style={c.width ? { width: c.width } : undefined}
                  aria-sort={c.sortValue ? (active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
                >
                  {c.sortValue ? (
                    <button type="button" className="ek-th-btn" onClick={() => toggle(c.key)}>
                      {c.header}
                      {active ? sort.dir === 'asc' ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" /> : <ChevronsUpDown size={12} aria-hidden="true" />}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={rowKey(row)}
              className={cx(onRowClick && 'ek-table__row--click')}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
            >
              {columns.map((c) => (
                <td key={c.key} className={cx(c.align === 'right' && 'is-right', c.align === 'center' && 'is-center')}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
