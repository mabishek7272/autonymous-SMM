import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Table, type TableColumn } from './Table';

interface Row {
  id: string;
  name: string;
  score: number | null;
}

const ROWS: Row[] = [
  { id: '1', name: 'Bravo', score: 20 },
  { id: '2', name: 'Alpha', score: null },
  { id: '3', name: 'Charlie', score: 5 },
];

const COLUMNS: TableColumn<Row>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name, sortValue: (r) => r.name },
  { key: 'score', header: 'Score', render: (r) => r.score ?? '—', sortValue: (r) => r.score, align: 'right' },
  { key: 'plain', header: 'Plain', render: () => 'x' },
];

function names(): string[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[0].textContent ?? '');
}

describe('Table', () => {
  it('sorts by a column and toggles direction, with aria-sort', async () => {
    render(<Table caption="People" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    expect(names()).toEqual(['Bravo', 'Alpha', 'Charlie']);
    await userEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(names()).toEqual(['Charlie', 'Bravo', 'Alpha']);
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute('aria-sort', 'descending');
  });

  it('sorts numbers numerically and keeps null values last in both directions', async () => {
    render(<Table caption="People" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    await userEvent.click(screen.getByRole('button', { name: /Score/ }));
    expect(names()).toEqual(['Charlie', 'Bravo', 'Alpha']);
    await userEvent.click(screen.getByRole('button', { name: /Score/ }));
    expect(names()).toEqual(['Bravo', 'Charlie', 'Alpha']);
  });

  it('does not render a sort button for non-sortable columns', () => {
    render(<Table caption="People" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    expect(screen.queryByRole('button', { name: /Plain/ })).not.toBeInTheDocument();
  });

  it('renders the empty node instead of a table when there are no rows', () => {
    render(<Table caption="People" columns={COLUMNS} rows={[]} rowKey={(r) => r.id} empty={<p>Nobody here</p>} />);
    expect(screen.getByText('Nobody here')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('supports clickable rows with keyboard activation', async () => {
    const onRowClick = vi.fn();
    render(<Table caption="People" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} onRowClick={onRowClick} />);
    const row = screen.getAllByRole('row')[1];
    await userEvent.click(row);
    expect(onRowClick).toHaveBeenLastCalledWith(ROWS[0]);
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenCalledTimes(2);
  });
});
