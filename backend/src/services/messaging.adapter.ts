import { logger } from '../utils/logger';
import { normalizePhone } from '../utils/phone';

export interface SendMessageOptions {
  to: string;       // WhatsApp number; normalised to international digits (e.g. '919876543210')
  text: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'document' | 'audio' | 'video';
  caption?: string;
}

export interface SentPart {
  id: string;       // provider message id (WhatsApp message id)
  text: string;
}

export interface EvolutionGoResponse {
  key: { id: string; remoteJid: string; fromMe: boolean };
  status: string;
  /** Every bubble actually delivered to the gateway, in order (sendHumanBubbles may send several). */
  parts: SentPart[];
}

export type GatewayState = 'connected' | 'disconnected' | 'unreachable' | 'not_configured';

export interface ConnectionStatus {
  state: GatewayState;
  connected: boolean;
  loggedIn: boolean;
  name?: string;
  jid?: string;
  instance: string;
  error?: string;
}

/** Thrown when a multi-bubble send fails part-way; `sent` holds the bubbles that already went out. */
export class PartialSendError extends Error {
  constructor(message: string, public readonly sent: SentPart[], public readonly unsent: string[]) {
    super(message);
    this.name = 'PartialSendError';
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * MessagingAdapter — decouples Hermes and internal services from the specific
 * WhatsApp implementation (Evolution Go). Per TRD §3.2 Adapter Pattern.
 *
 * Evolution GO (https://github.com/evolution-foundation/evolution-go) API facts used here:
 *  - the instance token is sent in the `apikey` header; the instance is implied by the token
 *    (there is NO instance name in the URL, unlike Evolution API v1/v2)
 *  - POST /send/text   { number, text, delay }          -> { message, data: { Info: { ID, Chat, ... } } }
 *  - POST /send/media  { number, url, type, caption }   -> same shape
 *  - POST /message/presence { number, state, delay }    -> typing indicator
 *  - GET  /instance/status                              -> { data: { connected, loggedIn, name, myJid } }
 *
 * To switch to Meta Cloud API in the future, only this file needs changing.
 */
export class MessagingAdapter {
  // Read lazily so env changes (tests, late dotenv) are honoured.
  private get baseUrl(): string {
    return (process.env.EVOLUTION_GO_URL ?? 'http://localhost:8081').replace(/\/+$/, '');
  }
  private get apiKey(): string {
    return process.env.EVOLUTION_GO_API_KEY ?? '';
  }
  private get instance(): string {
    return process.env.EVOLUTION_GO_INSTANCE ?? 'ekalavya-main';
  }

  private get headers() {
    return {
      'Content-Type': 'application/json',
      apikey: this.apiKey,
    };
  }

  private requireKey(): void {
    if (!this.apiKey) {
      throw new Error('MessagingAdapter: EVOLUTION_GO_API_KEY (instance token) is not configured');
    }
  }

  private requirePhone(raw: string): string {
    const phone = normalizePhone(raw);
    if (!phone) throw new Error(`MessagingAdapter: invalid WhatsApp number "${raw}"`);
    return phone;
  }

  /**
   * Calculates realistic human typing delay based on message length (TRD & Human Imperfections)
   */
  calculateHumanTypingDelay(text: string): number {
    // 35ms per character + base reading hesitation (between 1s and 4.5s)
    const baseDelay = Math.round(text.length * 35);
    return Math.min(4500, Math.max(1200, baseDelay));
  }

  /**
   * sendPresence — "composing" (typing...) or "recording_audio" indicator.
   * Cosmetic: failures are logged, never thrown. `delayMs` keeps the indicator alive
   * (the gateway call blocks for that long) and then sends "paused".
   */
  async sendPresence(to: string, presence: 'composing' | 'recording_audio' | 'paused' = 'composing', delayMs = 0): Promise<void> {
    try {
      this.requireKey();
      const number = this.requirePhone(to);
      await this.request('POST', '/message/presence', {
        number,
        state: presence === 'paused' ? 'paused' : 'composing',
        isAudio: presence === 'recording_audio',
        delay: delayMs,
      });
    } catch (err: any) {
      logger.warn('Failed to send presence indicator', { to, presence, error: err.message });
    }
  }

  /**
   * sendText — sends one text bubble; the gateway shows "composing" for the human typing delay first.
   */
  async sendText(to: string, text: string): Promise<EvolutionGoResponse> {
    this.requireKey();
    const number = this.requirePhone(to);
    const delay = this.calculateHumanTypingDelay(text);

    logger.debug('MessagingAdapter.sendText (Human Pacing)', { to: number, delayMs: delay, preview: text.slice(0, 80) });
    const data = await this.request('POST', '/send/text', { number, text, delay });
    return this.toResponse(data, number, text);
  }

  /**
   * sendHumanBubbles — splits conversational responses into short messages
   * sent in a natural typing burst separated by a pause, just like a real person texting.
   * If a later bubble fails, a PartialSendError reports what already went out (so callers never
   * re-send or mis-record those bubbles).
   */
  async sendHumanBubbles(to: string, fullText: string): Promise<EvolutionGoResponse> {
    // If text contains paragraphs and isn't a structured report card, split into short bubbles
    const isReportCard = fullText.includes('PROGRESS REPORT') || fullText.includes('BRIEFING');
    const chunks = (!isReportCard && fullText.includes('\n\n')
      ? fullText.split(/\n\n+/)
      : [fullText]
    ).map((c) => c.trim()).filter((c) => c.length > 0);

    if (chunks.length === 0) throw new Error('MessagingAdapter: cannot send an empty message');

    const parts: SentPart[] = [];
    let last: EvolutionGoResponse | null = null;

    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        // Natural human pause between consecutive chat bubbles
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      try {
        last = await this.sendText(to, chunks[i]);
        parts.push(...last.parts);
      } catch (err: any) {
        if (parts.length === 0) throw err;
        throw new PartialSendError(err.message, parts, chunks.slice(i));
      }
    }

    return { ...last!, parts };
  }

  /**
   * sendMedia — sends an image, document, video or audio voice note by URL.
   */
  async sendMedia(opts: Omit<SendMessageOptions, 'text'>): Promise<EvolutionGoResponse> {
    this.requireKey();
    if (!opts.mediaUrl) throw new Error('MessagingAdapter: mediaUrl is required for sendMedia');
    const number = this.requirePhone(opts.to);
    const data = await this.request('POST', '/send/media', {
      number,
      url: opts.mediaUrl,
      type: opts.mediaType ?? 'image',
      caption: opts.caption ?? '',
    });
    return this.toResponse(data, number, opts.caption ?? '');
  }

  /**
   * send — generic method for Hermes tool use. Uses human chunking for chat text.
   */
  async send(opts: SendMessageOptions): Promise<EvolutionGoResponse> {
    if (opts.mediaUrl) {
      return this.sendMedia({ ...opts, caption: opts.caption ?? opts.text });
    }
    return this.sendHumanBubbles(opts.to, opts.text);
  }

  /**
   * getConnectionStatus — asks the gateway whether the WhatsApp session is linked and online.
   * Never throws: an unreachable gateway is a valid, reportable state.
   */
  async getConnectionStatus(): Promise<ConnectionStatus> {
    const base = { connected: false, loggedIn: false, instance: this.instance };
    if (!this.apiKey) {
      return { ...base, state: 'not_configured', error: 'EVOLUTION_GO_API_KEY is not configured' };
    }
    try {
      const res = await this.request('GET', '/instance/status');
      const d = res?.data ?? {};
      const connected = (d.connected ?? d.Connected) === true;
      const loggedIn = (d.loggedIn ?? d.LoggedIn) === true;
      return {
        state: connected && loggedIn ? 'connected' : 'disconnected',
        connected,
        loggedIn,
        name: d.name ?? d.Name ?? undefined,
        jid: d.myJid ?? d.MyJid ?? d.jid ?? d.Jid ?? undefined,
        instance: this.instance,
      };
    } catch (err: any) {
      return { ...base, state: 'unreachable', error: err.message };
    }
  }

  /**
   * pairPhone — requests a WhatsApp "link with phone number" pairing code (whatsmeow PairPhone)
   * as an alternative to QR scanning. The parent then opens WhatsApp > Linked Devices > Link a
   * Device > Link with phone number instead, and types the returned code in.
   */
  async pairPhone(rawPhone: string): Promise<{ code: string }> {
    this.requireKey();
    const phone = this.requirePhone(rawPhone);
    // Deliberately no prior /instance/connect call: the gateway starts the client itself on
    // first /instance/pair ("No active connection, starting instance for phone pairing"). Calling
    // connect first instead starts the client in its default QR-code loop, which then runs in
    // parallel with — and can tear down — the in-progress pairing-code attempt.
    const data = await this.request('POST', '/instance/pair', { instanceName: this.instance, phone });
    const code =
      data?.data?.PairingCode ?? data?.PairingCode ?? data?.code ?? data?.data?.code ?? data?.pairingCode ?? data?.pairing_code ?? data?.data?.pairingCode;
    if (!code || typeof code !== 'string') {
      throw new Error(`MessagingAdapter: pairing succeeded but no code in response (${JSON.stringify(data).slice(0, 200)})`);
    }
    return { code };
  }

  /** Maps the gateway's { data: { Info: { ID, Chat } } } reply to the legacy response shape. */
  private toResponse(res: any, number: string, text: string): EvolutionGoResponse {
    const id = res?.data?.Info?.ID ?? res?.data?.Info?.Id;
    if (!id || typeof id !== 'string') {
      throw new Error('MessagingAdapter: gateway accepted the request but returned no message id');
    }
    return {
      key: { id, remoteJid: res.data.Info.Chat ?? `${number}@s.whatsapp.net`, fromMe: true },
      status: 'SENT',
      parts: [{ id, text }],
    };
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err: any) {
      logger.error('MessagingAdapter network error', { path, error: err.message });
      throw new Error(`MessagingAdapter: gateway unreachable (${err.message})`);
    }

    const raw = await response.text();
    if (!response.ok) {
      logger.error('MessagingAdapter HTTP error', { path, status: response.status, body: raw.slice(0, 500) });
      throw new Error(`MessagingAdapter error ${response.status}: ${raw.slice(0, 500)}`);
    }

    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`MessagingAdapter: gateway returned non-JSON response (${raw.slice(0, 120)})`);
    }
  }
}

export const messagingAdapter = new MessagingAdapter();
