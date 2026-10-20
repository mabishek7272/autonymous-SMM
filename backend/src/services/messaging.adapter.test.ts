import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessagingAdapter, PartialSendError } from './messaging.adapter';

const okSend = (id: string) => new Response(JSON.stringify({ message: 'success', data: { Info: { ID: id, Chat: '919876543210@s.whatsapp.net' } } }), { status: 200 });

describe('MessagingAdapter (Evolution GO)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    process.env.EVOLUTION_GO_URL = 'http://gw:8080/';
    process.env.EVOLUTION_GO_API_KEY = 'tok';
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs /send/text with the apikey header, normalised number and returns the provider id', async () => {
    fetchMock.mockResolvedValueOnce(okSend('ABC123'));
    const res = await new MessagingAdapter().sendText('98765 43210', 'hello');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://gw:8080/send/text');
    expect(init.headers.apikey).toBe('tok');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ number: '919876543210', text: 'hello' });
    expect(body.delay).toBeGreaterThan(0);
    expect(res.key.id).toBe('ABC123');
    expect(res.parts).toEqual([{ id: 'ABC123', text: 'hello' }]);
  });

  it('surfaces gateway HTTP errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"no active session"}', { status: 500 }));
    await expect(new MessagingAdapter().sendText('9876543210', 'x')).rejects.toThrow(/500.*no active session/);
  });

  it('surfaces a network failure and a missing message id', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(new MessagingAdapter().sendText('9876543210', 'x')).rejects.toThrow(/unreachable/);
    fetchMock.mockResolvedValueOnce(new Response('{"message":"success"}', { status: 200 }));
    await expect(new MessagingAdapter().sendText('9876543210', 'x')).rejects.toThrow(/no message id/);
  });

  it('rejects invalid numbers and a missing key without calling the gateway', async () => {
    await expect(new MessagingAdapter().sendText('not-a-number', 'x')).rejects.toThrow(/invalid WhatsApp number/);
    process.env.EVOLUTION_GO_API_KEY = '';
    await expect(new MessagingAdapter().sendText('9876543210', 'x')).rejects.toThrow(/EVOLUTION_GO_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports already-sent bubbles when a later bubble fails', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(okSend('B1')).mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const p = new MessagingAdapter().sendHumanBubbles('9876543210', 'first\n\nsecond').catch((e) => e);
    await vi.advanceTimersByTimeAsync(1500);
    const err = await p;
    vi.useRealTimers();
    expect(err).toBeInstanceOf(PartialSendError);
    expect(err.sent).toEqual([{ id: 'B1', text: 'first' }]);
    expect(err.unsent).toEqual(['second']);
  });

  it('getConnectionStatus maps the gateway reply and never throws', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { connected: true, loggedIn: true, name: 'EK', myJid: '91@s.whatsapp.net' } }), { status: 200 }));
    expect(await new MessagingAdapter().getConnectionStatus()).toMatchObject({ state: 'connected', connected: true, name: 'EK' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { connected: true, loggedIn: false } }), { status: 200 }));
    expect((await new MessagingAdapter().getConnectionStatus()).state).toBe('disconnected');
    fetchMock.mockRejectedValueOnce(new Error('down'));
    expect((await new MessagingAdapter().getConnectionStatus()).state).toBe('unreachable');
    process.env.EVOLUTION_GO_API_KEY = '';
    expect((await new MessagingAdapter().getConnectionStatus()).state).toBe('not_configured');
  });
});
