import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/renderWithProviders';
import { ImportSource } from './ImportSource';

const dl = vi.hoisted(() => ({ downloadTextFile: vi.fn() }));
vi.mock('./csv', async (orig) => ({ ...(await orig<typeof import('./csv')>()), downloadTextFile: dl.downloadTextFile }));

function Harness() {
  const [v, setV] = useState('');
  return <ImportSource label="Teachers" template="teachers" value={v} onChange={setV} />;
}

afterEach(() => vi.clearAllMocks());

describe('ImportSource', () => {
  it('turns an uploaded CSV into the pasted text', async () => {
    renderWithProviders(<Harness />);
    const file = new File(['Full name,Email,Phone\n"Kumar, S",k@example.com,9876543210\n'], 'teachers.csv', { type: 'text/csv' });
    await userEvent.upload(screen.getByLabelText('Teachers: choose a CSV file'), file);
    await waitFor(() => expect(screen.getByLabelText('Teachers')).toHaveValue('Full name\tEmail\tPhone\nKumar, S\tk@example.com\t9876543210'));
    expect(screen.getByText('Loaded teachers.csv')).toBeInTheDocument();
  });

  it('refuses Excel workbooks with clear instructions', async () => {
    renderWithProviders(<Harness />);
    await userEvent.upload(screen.getByLabelText('Teachers: choose a CSV file'), new File(['x'], 'teachers.xlsx'), { applyAccept: false });
    expect(await screen.findByText(/Save As → CSV/)).toBeInTheDocument();
    expect(screen.getByLabelText('Teachers')).toHaveValue('');
  });

  it('downloads the template for this import', async () => {
    renderWithProviders(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Download template' }));
    expect(dl.downloadTextFile).toHaveBeenCalledTimes(1);
    const [name, content] = dl.downloadTextFile.mock.calls[0];
    expect(name).toBe('teachers-template.csv');
    expect(content).toContain('Full name,Email,Phone,Initials');
    expect(content).toContain('EXAMPLE – Priya Sharma');
  });
});
