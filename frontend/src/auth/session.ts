/**
 * Token storage + session-expiry signalling. Kept free of React so the http layer can use it.
 * localStorage can throw or be empty (private windows, blocked storage), so every access is guarded;
 * an in-memory copy keeps the current tab working when storage is unavailable.
 */
export const TOKEN_KEY = 'ekalavya_token';
export const SESSION_EXPIRED_EVENT = 'session-expired';

/** Only used while localStorage throws (private window, blocked site data). */
let memoryToken: string | null = null;

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return memoryToken;
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
    memoryToken = null;
  } catch {
    memoryToken = token;
  }
}

export function clearToken(): void {
  memoryToken = null;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to clear */
  }
}

export function notifySessionExpired(): void {
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
}
