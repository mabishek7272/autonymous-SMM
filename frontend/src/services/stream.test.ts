import { afterEach, describe, expect, it, vi } from 'vitest';
import { setToken } from '../auth/session';
import { ApiError } from './http';
import { parseSseFrames, streamOllama } from './stream';

function sseResponse(chunks: string[], status = 200): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((c) => controller.enqueue(enc.encode(c)));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('parseSseFrames', () => {
  it('returns complete frames and keeps the partial remainder', () => {
    const { events, rest } = parseSseFrames('data: {"token":"a","done":false}\n\ndata: {"tok');
    expect(events).toEqual([{ token: 'a', done: false }]);
    expect(rest).toBe('data: {"tok');
  });
});

describe('streamOllama', () => {
  it('streams tokens across arbitrary chunk boundaries and resolves with the done event', async () => {
    setToken('t');
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"token":"Hel","done":false}\n\ndata: {"tok',
        'en":"lo","done":false}\n\n',
        'data: {"token":"","done":true,"totalTokens":2,"latencyMs":50,"fullReply":"Hello"}\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const tokens: string[] = [];
    const done = await streamOllama({ prompt: 'hi' }, { onToken: (t) => tokens.push(t) });
    expect(tokens).toEqual(['Hel', 'lo']);
    expect(done).toMatchObject({ done: true, fullReply: 'Hello', totalTokens: 2 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/dev/ollama/stream');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t');
  });

  it('rejects with the server message when the stream carries an error frame', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(['data: {"error":"Ollama HTTP 404: model not found","done":true}\n\n'])));
    await expect(streamOllama({})).rejects.toMatchObject({ message: 'Ollama HTTP 404: model not found' });
  });

  it('rejects with ApiError on HTTP failure (403)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Access denied' }), { status: 403 })));
    const err = await streamOllama({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });
});
