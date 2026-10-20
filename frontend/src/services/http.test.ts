import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_EXPIRED_EVENT, TOKEN_KEY, getToken, setToken } from '../auth/session';
import { ApiError, buildUrl, getErrorMessage, getFieldErrors, request } from './http';

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request', () => {
  it('sends JSON, query params and the bearer token, and returns the parsed body', async () => {
    setToken('tok-123');
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [1], meta: { total: 1 } }));
    const res = await request<{ data: number[] }>('/leads', { query: { status: 'enquiry', q: undefined, page: 2 } });
    expect(res.data).toEqual([1]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/leads?status=enquiry&page=2');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });

  it('serialises a body for mutations', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'x' }));
    await request('/parents', { method: 'POST', body: { fullName: 'A' } });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"fullName":"A"}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('resolves undefined on 204', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(request('/sessions/1', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('maps the backend { error, details } body to ApiError', async () => {
    const details = { formErrors: [], fieldErrors: { email: ['Invalid email'] } };
    fetchMock.mockResolvedValue(jsonResponse(400, { error: 'Validation failed', details }));
    const err = await request('/users', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const api = err as ApiError;
    expect(api.status).toBe(400);
    expect(api.message).toBe('Validation failed');
    expect(api.details).toEqual(details);
    expect(getFieldErrors(api)).toEqual({ email: 'Invalid email' });
    expect(getErrorMessage(api)).toBe('Validation failed');
  });

  it('uses the {message} body used by dev routes', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { status: 'error', message: 'Redis down' }));
    await expect(request('/dev/clear-redis-cache', { method: 'POST' })).rejects.toMatchObject({ status: 500, message: 'Redis down' });
  });

  it('on 401 with a token clears the session and dispatches session-expired', async () => {
    setToken('stale');
    const listener = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, listener);
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Invalid or expired token' }));
    await expect(request('/auth/me')).rejects.toMatchObject({ status: 401, message: 'Invalid or expired token' });
    window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getToken()).toBeNull();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('does not signal session expiry for a failed login (no token was sent)', async () => {
    const listener = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, listener);
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Invalid credentials' }));
    await expect(request('/auth/login', { method: 'POST', body: { email: 'a@b.co', password: 'x' } })).rejects.toMatchObject({ message: 'Invalid credentials' });
    window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not clear the session on 403', async () => {
    setToken('keep');
    fetchMock.mockResolvedValue(jsonResponse(403, { error: 'Access denied' }));
    await expect(request('/dev/config')).rejects.toMatchObject({ status: 403 });
    expect(getToken()).toBe('keep');
  });

  it('throws a network ApiError (status 0) and never returns fallback data', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await request('/leads').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).isNetworkError).toBe(true);
  });

  it('falls back to the status text for non-JSON error bodies', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
    await expect(request('/leads')).rejects.toMatchObject({ status: 502, message: 'Bad Gateway' });
  });
});

describe('buildUrl', () => {
  it('skips empty query values', () => {
    expect(buildUrl('/x', { a: '', b: null, c: 0, d: false })).toBe('/api/v1/x?c=0&d=false');
  });
});
