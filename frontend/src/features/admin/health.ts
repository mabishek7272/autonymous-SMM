import { API_BASE_URL, ApiError } from '../../services/http';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: string;
  checks: Record<string, 'up' | 'down'>;
  timestamp: string;
  version: string;
}

/** The backend serves GET /health at its root (outside /api/v1), unauthenticated. A 503 still carries the checks. */
export function healthUrl(): string {
  try {
    return new URL('/health', new URL(API_BASE_URL)).toString();
  } catch {
    return '/health';
  }
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  let res: Response;
  try {
    res = await fetch(healthUrl(), { signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Cannot reach the server health endpoint.', err);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(res.status, `Health endpoint returned an unreadable response (HTTP ${res.status}).`);
  }
  const rec = body as Partial<HealthResponse> | null;
  if (!rec || typeof rec !== 'object' || typeof rec.checks !== 'object' || rec.checks === null) {
    throw new ApiError(res.status, `Health endpoint returned an unexpected response (HTTP ${res.status}).`);
  }
  return rec as HealthResponse;
}
