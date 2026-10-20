import { createHash, timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction } from 'express';

/** Constant-time string comparison that does not leak length (both sides are hashed first). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * requireAgentKey — service-to-service auth for the voice call agent (not a user JWT).
 * - EKALAVYA_AGENT_KEY unset  -> 503 (the routes are never open)
 * - header X-Agent-Key missing/wrong -> 401
 * The key is read from the header only, never from the query string.
 */
export function requireAgentKey(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.EKALAVYA_AGENT_KEY;
  if (!expected) {
    res.status(503).json({ error: 'Agent API is not configured (EKALAVYA_AGENT_KEY is unset)' });
    return;
  }
  const provided = req.headers['x-agent-key'];
  if (typeof provided !== 'string' || !provided || !safeEqual(provided, expected)) {
    res.status(401).json({ error: 'Invalid or missing X-Agent-Key' });
    return;
  }
  next();
}
