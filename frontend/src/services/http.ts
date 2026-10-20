import { clearToken, getToken, notifySessionExpired } from '../auth/session';

/** Base URL of the backend API. Vite proxies /api to :3001 in development. */
export const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL as string | undefined) || '/api/v1';

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  query?: Record<string, QueryValue>;
}

/** Error thrown for every failed request. `message` is the server's `error` text when there is one. */
export class ApiError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }

  /** status 0 = the request never reached the server (offline, DNS, CORS, aborted by network). */
  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** Human-readable message for any thrown value, suitable for toasts and ErrorState. */
export function getErrorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return fallback;
}

/**
 * Field-level validation messages from a 400 response (zod `flatten()` shape:
 * `details.fieldErrors`). Returns {} when the error carries none.
 */
export function getFieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || typeof err.details !== 'object' || err.details === null) return {};
  const fieldErrors = (err.details as { fieldErrors?: unknown }).fieldErrors;
  if (typeof fieldErrors !== 'object' || fieldErrors === null) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fieldErrors)) {
    if (Array.isArray(value) && typeof value[0] === 'string') out[key] = value[0];
  }
  return out;
}

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const base = API_BASE_URL.replace(/\/+$/, '');
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function messageFromBody(body: unknown, status: number, statusText: string): string {
  if (typeof body === 'object' && body !== null) {
    const rec = body as { error?: unknown; message?: unknown };
    if (typeof rec.error === 'string' && rec.error) return rec.error;
    if (typeof rec.message === 'string' && rec.message) return rec.message;
  }
  if (typeof body === 'string' && body.length > 0 && body.length < 300 && !body.trim().startsWith('<')) return body;
  return statusText || `Request failed (${status})`;
}

/** Turns a non-OK response into an ApiError and applies the 401 policy. Exported for the streaming helper. */
export async function toApiError(res: Response, hadToken: boolean): Promise<ApiError> {
  const body = await readBody(res);
  if (res.status === 401 && hadToken) {
    clearToken();
    notifySessionExpired();
  }
  const details = typeof body === 'object' && body !== null ? (body as { details?: unknown }).details ?? body : undefined;
  return new ApiError(res.status, messageFromBody(body, res.status, res.statusText), details);
}

/**
 * Typed JSON request against the backend. Never returns fallback data: any failure throws ApiError.
 * 204 responses resolve to undefined.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, query } = options;
  const hadToken = getToken() !== null;
  const headers = authHeaders(body !== undefined ? { 'Content-Type': 'application/json' } : {});

  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers: { Accept: 'application/json', ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.', err);
  }

  if (!res.ok) throw await toApiError(res, hadToken);
  if (res.status === 204) return undefined as T;
  return (await readBody(res)) as T;
}

/** GET returning raw text (CSV export). */
export async function requestText(path: string, options: Omit<RequestOptions, 'body'> = {}): Promise<string> {
  const hadToken = getToken() !== null;
  let res: Response;
  try {
    res = await fetch(buildUrl(path, options.query), { method: options.method ?? 'GET', headers: authHeaders(), signal: options.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.', err);
  }
  if (!res.ok) throw await toApiError(res, hadToken);
  return res.text();
}
