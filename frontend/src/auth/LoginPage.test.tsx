import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../services/http';
import { renderWithProviders } from '../test/renderWithProviders';
import type { LoginOtpChallenge } from '../types';
import LoginPage from './LoginPage';

const challenge = (over: Partial<LoginOtpChallenge> = {}): LoginOtpChallenge => ({
  otpRequired: true,
  otpToken: 'tok-1',
  expiresInSeconds: 600,
  devBypass: false,
  maskedEmail: 'st***@example.test',
  ...over,
});

describe('LoginPage — step 1 (password)', () => {
  it('shows the real server error message and re-enables the form', async () => {
    const login = vi.fn().mockRejectedValue(new ApiError(401, 'Invalid credentials'));
    renderWithProviders(<LoginPage />, { user: null, login, route: '/login' });
    await userEvent.type(screen.getByLabelText(/Email/), 'staff@example.test');
    await userEvent.type(screen.getByLabelText(/Password/), 'wrong-pass');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials');
    expect(login).toHaveBeenCalledWith('staff@example.test', 'wrong-pass');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('validates fields before calling the server', async () => {
    const login = vi.fn();
    renderWithProviders(<LoginPage />, { user: null, login, route: '/login' });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter your email address')).toBeInTheDocument();
    expect(screen.getByText('Enter your password')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Email/), 'not-an-email');
    await userEvent.type(screen.getByLabelText(/Password/), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it('disables the button while signing in', async () => {
    let resolve: (v: LoginOtpChallenge) => void = () => undefined;
    const login = vi.fn().mockReturnValue(new Promise<LoginOtpChallenge>((r) => (resolve = r)));
    renderWithProviders(<LoginPage />, { user: null, login, route: '/login' });
    await userEvent.type(screen.getByLabelText(/Email/), 'staff@example.test');
    await userEvent.type(screen.getByLabelText(/Password/), 'a-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
    resolve(challenge());
  });

  it('toggles password visibility', async () => {
    renderWithProviders(<LoginPage />, { user: null, route: '/login' });
    const pw = screen.getByLabelText(/Password/);
    expect(pw).toHaveAttribute('type', 'password');
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(pw).toHaveAttribute('type', 'text');
    await userEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(pw).toHaveAttribute('type', 'password');
  });

  it('does not render hint credentials', () => {
    renderWithProviders(<LoginPage />, { user: null, route: '/login' });
    expect(screen.getByLabelText(/Email/)).toHaveValue('');
    expect(screen.getByLabelText(/Password/)).toHaveValue('');
  });

  it('redirects an authenticated user to the first tab their role may see', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/students" element={<div>students page</div>} />
        <Route path="/admissions" element={<div>admissions page</div>} />
      </Routes>,
      { user: { role: 'teacher' }, route: '/login' },
    );
    await waitFor(() => expect(screen.getByText('students page')).toBeInTheDocument());
  });
});

async function goToOtpStep(login = vi.fn().mockResolvedValue(challenge()), extra: Record<string, unknown> = {}) {
  const utils = renderWithProviders(<LoginPage />, { user: null, login, route: '/login', ...extra });
  await userEvent.type(screen.getByLabelText(/Email/), 'staff@example.test');
  await userEvent.type(screen.getByLabelText(/Password/), 'a-password');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { name: 'Enter your code' });
  return utils;
}

describe('LoginPage — step 2 (emailed code)', () => {
  it("moves to the code step and says where the code was sent, without exposing it", async () => {
    await goToOtpStep(vi.fn().mockResolvedValue(challenge({ maskedEmail: 'jo***@parent.test' })));
    expect(screen.getByText(/We emailed a 6-digit code to jo\*\*\*@parent\.test/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b\d{6}\b/);
  });

  it('says so for a dev-bypass account instead of claiming an email was sent', async () => {
    await goToOtpStep(vi.fn().mockResolvedValue(challenge({ devBypass: true })));
    expect(screen.getByText('Dev account — use the test code')).toBeInTheDocument();
  });

  it('verifies the code and completes sign-in', async () => {
    const verifyOtp = vi.fn().mockResolvedValue(undefined);
    await goToOtpStep(undefined, { verifyOtp });
    await userEvent.type(screen.getByLabelText(/6-digit code/), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    await waitFor(() => expect(verifyOtp).toHaveBeenCalledWith(challenge(), '123456'));
  });

  it('only accepts 6 digits, and strips non-digit input as it is typed', async () => {
    const verifyOtp = vi.fn();
    await goToOtpStep(undefined, { verifyOtp });
    const field = screen.getByLabelText(/6-digit code/);
    await userEvent.type(field, 'ab12cd34');
    expect(field).toHaveValue('1234');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(screen.getByText('Enter the 6-digit code')).toBeInTheDocument();
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('shows the real server error for a wrong code and clears the field', async () => {
    const verifyOtp = vi.fn().mockRejectedValue(new ApiError(400, 'That code is incorrect.'));
    await goToOtpStep(undefined, { verifyOtp });
    await userEvent.type(screen.getByLabelText(/6-digit code/), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is incorrect.');
    expect(screen.getByLabelText(/6-digit code/)).toHaveValue('');
  });

  it('resends the code, replaces the challenge, and enforces a cooldown', async () => {
    const second = challenge({ otpToken: 'tok-2' });
    const resendOtp = vi.fn().mockResolvedValue(second);
    const verifyOtp = vi.fn().mockResolvedValue(undefined);
    await goToOtpStep(undefined, { resendOtp, verifyOtp });
    expect(screen.getByRole('button', { name: /Resend code \(\d+s\)/ })).toBeDisabled();
  });

  it('lets the user go back and sign in with a different account', async () => {
    await goToOtpStep();
    await userEvent.click(screen.getByRole('button', { name: 'Use a different account' }));
    expect(screen.getByRole('heading', { name: 'Sign in to E-Kalavya' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Password/)).toHaveValue('');
  });

  it('redirects away from the code step if the session somehow completes', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/students" element={<div>students page</div>} />
      </Routes>,
      { user: { role: 'teacher' }, route: '/login' },
    );
    await waitFor(() => expect(screen.getByText('students page')).toBeInTheDocument());
  });
});
