import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { Modal } from './Modal';

function Harness({ onClose = () => undefined }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      <Modal
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        title="Edit lead"
        footer={<Button>Save</Button>}
      >
        <input aria-label="name" />
      </Modal>
    </>
  );
}

describe('Modal', () => {
  it('renders an accessible dialog and moves focus inside', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText('open'));
    const dialog = screen.getByRole('dialog', { name: 'Edit lead' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('traps Tab and Shift+Tab inside the dialog', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByText('open'));
    const close = screen.getByRole('button', { name: 'Close dialog' });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(screen.getByLabelText('name')).toHaveFocus();
    await userEvent.tab();
    expect(save).toHaveFocus();
    await userEvent.tab();
    expect(close).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByLabelText('name')).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(close).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(save).toHaveFocus();
  });

  it('closes on Escape and restores focus to the opener', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByText('open');
    await userEvent.click(opener);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('closes on backdrop click but not on clicks inside', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await userEvent.click(screen.getByText('open'));
    await userEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('only the top-most of two stacked dialogs reacts to Escape', async () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <>
        <Modal open onClose={outer} title="Outer">
          <p>outer</p>
        </Modal>
        <Modal open onClose={inner} title="Inner">
          <p>inner</p>
        </Modal>
      </>,
    );
    await userEvent.keyboard('{Escape}');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});
