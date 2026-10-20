import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { AlertCircle, ArrowLeft, LogIn, Mail, ShieldCheck } from 'lucide-react';
import { getErrorMessage, getFieldErrors } from '../services/http';
import { allowedTabs } from '../shell/navigation';
import '../shell/shell.css';
import { Button, Card, Input } from '../ui';
import { useAuth } from './useAuth';
import type { LoginOtpChallenge } from '../types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_COOLDOWN_SECONDS = 30;

interface FieldErrors {
  email?: string;
  password?: string;
}

function validate(email: string, password: string): FieldErrors {
  const errors: FieldErrors = {};
  if (!email.trim()) errors.email = 'Enter your email address';
  else if (!EMAIL_RE.test(email.trim())) errors.email = 'Enter a valid email address';
  if (!password) errors.password = 'Enter your password';
  return errors;
}

export default function LoginPage() {
  const { status, login, verifyOtp, resendOtp, hasPermission } = useAuth();
  const location = useLocation();

  // Step 1: email + password.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Step 2: the emailed code.
  const [challenge, setChallenge] = useState<LoginOtpChallenge | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  if (status === 'authenticated') {
    const tabs = allowedTabs(hasPermission);
    const from = (location.state as { from?: string } | null)?.from;
    const target = from && tabs.some((t) => from.startsWith(t.path)) ? from : (tabs[0]?.path ?? '/');
    return <Navigate to={target} replace />;
  }

  const onSubmitPassword = async (e: FormEvent) => {
    e.preventDefault();
    const found = validate(email, password);
    setErrors(found);
    setServerError(null);
    if (found.email || found.password) return;
    setSubmitting(true);
    try {
      const result = await login(email.trim(), password);
      setChallenge(result);
      setCode('');
      setCodeError(null);
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      const fieldErrors = getFieldErrors(err);
      if (fieldErrors.email || fieldErrors.password) {
        setErrors({ email: fieldErrors.email, password: fieldErrors.password });
      }
      setServerError(getErrorMessage(err, 'Could not sign in'));
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!challenge) return;
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      setCodeError('Enter the 6-digit code');
      return;
    }
    setVerifying(true);
    setCodeError(null);
    try {
      await verifyOtp(challenge, trimmed);
    } catch (err) {
      setCodeError(getErrorMessage(err, 'Could not verify the code'));
      setCode('');
    } finally {
      setVerifying(false);
    }
  };

  const onResend = async () => {
    if (!challenge || cooldown > 0) return;
    setResending(true);
    setCodeError(null);
    try {
      const fresh = await resendOtp(challenge);
      setChallenge(fresh);
      setCode('');
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setCodeError(getErrorMessage(err, 'Could not resend the code'));
    } finally {
      setResending(false);
    }
  };

  const onBack = () => {
    setChallenge(null);
    setCode('');
    setCodeError(null);
    setPassword('');
  };

  if (challenge) {
    return (
      <div className="ek-login">
        <Card className="ek-login__card">
          <div className="ek-login__brand">
            <div className="ek-brand__mark" aria-hidden="true">
              E
            </div>
            <div>
              <h1 className="ek-login__title">Enter your code</h1>
              <p className="ek-login__sub">
                {challenge.devBypass ? 'Dev account — use the test code' : `We emailed a 6-digit code to ${challenge.maskedEmail}`}
              </p>
            </div>
          </div>

          <form className="ek-login__form" onSubmit={onSubmitCode} noValidate>
            {codeError && (
              <div className="ek-login__alert" role="alert">
                <AlertCircle size={15} aria-hidden="true" style={{ flex: 'none', marginTop: 1 }} />
                <span>{codeError}</span>
              </div>
            )}
            <Input
              label="6-digit code"
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              startIcon={<ShieldCheck size={14} aria-hidden="true" />}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              hint={challenge.devBypass ? undefined : 'Code expires in 10 minutes'}
            />
            <Button type="submit" size="lg" block loading={verifying} icon={<ShieldCheck size={15} aria-hidden="true" />}>
              {verifying ? 'Verifying…' : 'Verify and sign in'}
            </Button>
            <div className="ek-login__otp-row">
              <Button type="button" variant="ghost" size="sm" icon={<ArrowLeft size={13} aria-hidden="true" />} onClick={onBack}>
                Use a different account
              </Button>
              <Button type="button" variant="ghost" size="sm" loading={resending} disabled={cooldown > 0 || resending} onClick={() => void onResend()}>
                {cooldown > 0 ? `Resend code (${cooldown}s)` : 'Resend code'}
              </Button>
            </div>
          </form>
        </Card>
      </div>
    );
  }

  return (
    <div className="ek-login">
      <Card className="ek-login__card">
        <div className="ek-login__brand">
          <div className="ek-brand__mark" aria-hidden="true">
            E
          </div>
          <div>
            <h1 className="ek-login__title">Sign in to E-Kalavya</h1>
            <p className="ek-login__sub">Admissions &amp; academy operations</p>
          </div>
        </div>

        <form className="ek-login__form" onSubmit={onSubmitPassword} noValidate>
          {serverError && (
            <div className="ek-login__alert" role="alert">
              <AlertCircle size={15} aria-hidden="true" style={{ flex: 'none', marginTop: 1 }} />
              <span>{serverError}</span>
            </div>
          )}
          <Input
            label="Email"
            type="email"
            name="email"
            autoComplete="username"
            autoFocus
            required
            startIcon={<Mail size={14} aria-hidden="true" />}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errors.email}
          />
          <Input
            label="Password"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errors.password}
          />
          <Button type="submit" size="lg" block loading={submitting} icon={<LogIn size={15} aria-hidden="true" />}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
          <p className="ek-login__hint">After your password, we&apos;ll email a 6-digit code to finish signing in.</p>
        </form>
      </Card>
    </div>
  );
}
