import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../services/http';
import { BarList, DonutChart } from './Charts';
import { ConfirmProvider } from './ConfirmDialog';
import { useConfirm } from './confirm-context';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { Input } from './Field';
import { KpiBar } from './KpiBar';
import { RingGauge, ProgressBar } from './Progress';
import { Tabs } from './Tabs';
import { ToastProvider } from './ToastProvider';
import { useToast } from './toast-context';
import { Toggle } from './Toggle';
import { initialsOf } from './initials';

describe('RingGauge', () => {
  it('exposes the value and draws a proportional arc', () => {
    render(<RingGauge value={75} label="Attendance" size={100} stroke={10} />);
    expect(screen.getByRole('img', { name: 'Attendance: 75%' })).toBeInTheDocument();
    const arc = screen.getByTestId('ring-arc');
    const circumference = 2 * Math.PI * 45;
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference * 0.25, 3);
  });

  it('clamps out-of-range values', () => {
    render(<RingGauge value={140} label="Over" />);
    expect(screen.getByRole('img', { name: 'Over: 100%' })).toBeInTheDocument();
  });

  it('renders "no data" for null without an arc', () => {
    render(<RingGauge value={null} label="Marks" />);
    expect(screen.getByRole('img', { name: 'Marks: no data' })).toBeInTheDocument();
    expect(screen.queryByTestId('ring-arc')).not.toBeInTheDocument();
  });
});

describe('ProgressBar / charts', () => {
  it('ProgressBar reports aria values', () => {
    render(<ProgressBar value={40} label="Fill" />);
    expect(screen.getByRole('progressbar', { name: 'Fill' })).toHaveAttribute('aria-valuenow', '40');
    expect(screen.getByText('40%')).toBeInTheDocument();
  });

  it('DonutChart prints every value in the legend and handles an empty total', () => {
    const { rerender } = render(<DonutChart label="Health" segments={[{ label: 'Green', value: 3 }, { label: 'Red', value: 1 }]} />);
    expect(screen.getByRole('img', { name: 'Health: Green 3, Red 1' })).toBeInTheDocument();
    rerender(<DonutChart label="Health" segments={[{ label: 'Green', value: 0 }]} />);
    expect(screen.getByRole('img', { name: 'Health: no data' })).toBeInTheDocument();
  });

  it('BarList shows value text next to each bar', () => {
    render(<BarList ariaLabel="Sources" items={[{ label: 'Meta', value: 8, display: '8 leads' }, { label: 'Web', value: 2 }]} />);
    expect(screen.getByText('8 leads')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Sources' })).toBeInTheDocument();
  });
});

describe('Button', () => {
  it('is disabled and busy while loading', () => {
    render(<Button loading>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
  });

  it('defaults to type=button so it never submits a form by accident', () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });
});

describe('states', () => {
  it('EmptyState renders title, description and a working action', async () => {
    const onClick = vi.fn();
    render(<EmptyState title="No leads" description="Nothing yet" action={{ label: 'Reload', onClick }} />);
    expect(screen.getByText('No leads')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onClick).toHaveBeenCalled();
  });

  it('ErrorState shows the server message and a Retry button', async () => {
    const onRetry = vi.fn();
    render(<ErrorState error={new ApiError(500, 'Failed to fetch leads')} onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch leads');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('Input', () => {
  it('links label, error and aria-invalid', () => {
    render(<Input label="Phone" error="Too short" />);
    const input = screen.getByLabelText('Phone');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Too short');
  });
});

describe('Toggle / Tabs', () => {
  it('Toggle is a switch that reports checked state', async () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Enabled" />);
    const sw = screen.getByRole('switch', { name: 'Enabled' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('Tabs change with arrow keys', async () => {
    const onChange = vi.fn();
    render(<Tabs ariaLabel="View" value="a" onChange={onChange} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />);
    screen.getByRole('tab', { name: 'A' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('KpiBar', () => {
  it('renders only the numbers it is given, with delta text and arrow', () => {
    render(<KpiBar items={[{ label: 'Leads', value: 12, delta: { text: '+2', direction: 'up' }, sub: 'this week' }, { label: 'Revenue', value: '—' }]} />);
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows a loading skeleton when loading with no items', () => {
    render(<KpiBar items={[]} loading />);
    expect(screen.getByRole('status', { name: 'Loading metrics' })).toBeInTheDocument();
  });
});

describe('toast + confirm helpers', () => {
  function Demo() {
    const toast = useToast();
    const confirm = useConfirm();
    return (
      <>
        <button onClick={() => toast.success('Saved lead')}>ok</button>
        <button onClick={() => toast.fromError(new ApiError(409, 'Already announced'), 'Announce failed')}>fail</button>
        <button
          onClick={() =>
            void confirm({ title: 'Delete rule?', message: 'This cannot be undone.', tone: 'danger', confirmLabel: 'Delete' }).then((r) => toast.info(r ? 'confirmed' : 'cancelled'))
          }
        >
          ask
        </button>
      </>
    );
  }
  const setup = () =>
    render(
      <ToastProvider>
        <ConfirmProvider>
          <Demo />
        </ConfirmProvider>
      </ToastProvider>,
    );

  it('shows success and error toasts with the real message', async () => {
    setup();
    await userEvent.click(screen.getByText('ok'));
    expect(screen.getByRole('status')).toHaveTextContent('Saved lead');
    await userEvent.click(screen.getByText('fail'));
    expect(screen.getByRole('alert')).toHaveTextContent('Announce failed: Already announced');
  });

  it('confirm resolves true on confirm and false on cancel / Escape', async () => {
    setup();
    await userEvent.click(screen.getByText('ask'));
    expect(screen.getByRole('dialog', { name: 'Delete rule?' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByText('confirmed')).toBeInTheDocument());
    await userEvent.click(screen.getByText('ask'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByText('cancelled')).toBeInTheDocument());
  });
});

describe('initialsOf', () => {
  it('takes first and last initial', () => {
    expect(initialsOf('Asha Devi Rao')).toBe('AR');
    expect(initialsOf('  single ')).toBe('S');
    expect(initialsOf('')).toBe('');
  });
});
