import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { asyncHandler } from './async-handler';

describe('asyncHandler', () => {
  it('forwards a rejected promise to next() instead of letting it go unhandled', async () => {
    const error = new Error('boom');
    const handler = asyncHandler(async () => {
      throw error;
    });
    const next = vi.fn();

    await handler({} as Request, {} as Response, next);

    expect(next).toHaveBeenCalledWith(error);
  });

  it('does not call next() when the handler resolves normally', async () => {
    const handler = asyncHandler(async (_req, res) => {
      res.json({ ok: true });
    });
    const json = vi.fn();
    const res = { json } as unknown as Response;
    const next = vi.fn();

    await handler({} as Request, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ ok: true });
  });
});
