import { getToken } from '../auth/session';
import type { OllamaPrompt, OllamaStreamEvent } from '../types';
import { ApiError, authHeaders, buildUrl, toApiError } from './http';

export interface StreamHandlers {
  onToken?: (token: string) => void;
  signal?: AbortSignal;
}

/** Parses complete SSE frames out of a buffer; returns the parsed events and the unconsumed remainder. */
export function parseSseFrames(buffer: string): { events: OllamaStreamEvent[]; rest: string } {
  const frames = buffer.split('\n\n');
  const rest = frames.pop() ?? '';
  const events: OllamaStreamEvent[] = [];
  for (const frame of frames) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      events.push(JSON.parse(data) as OllamaStreamEvent);
    } catch {
      /* ignore malformed frame */
    }
  }
  return { events, rest };
}

/**
 * POST /dev/ollama/stream. Resolves with the final `done` event; rejects with ApiError on HTTP failure
 * or when the server reports `{error}` in the stream.
 */
export async function streamOllama(body: OllamaPrompt, handlers: StreamHandlers = {}): Promise<OllamaStreamEvent> {
  const hadToken = getToken() !== null;
  let res: Response;
  try {
    res = await fetch(buildUrl('/dev/ollama/stream'), {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      signal: handlers.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.', err);
  }
  if (!res.ok) throw await toApiError(res, hadToken);
  if (!res.body) throw new ApiError(res.status, 'The server returned an empty stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const state: { last: OllamaStreamEvent | null } = { last: null };

  const handle = (event: OllamaStreamEvent) => {
    if (event.error) throw new ApiError(502, event.error, event);
    if (event.token) handlers.onToken?.(event.token);
    state.last = event;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseFrames(buffer);
    buffer = parsed.rest;
    parsed.events.forEach(handle);
  }
  buffer += decoder.decode();
  parseSseFrames(`${buffer}\n\n`).events.forEach(handle);

  if (!state.last) throw new ApiError(502, 'The stream ended without any data');
  return state.last;
}
