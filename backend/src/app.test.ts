import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.mock('./utils/database', () => ({
  prisma: { parent: { findMany: vi.fn().mockRejectedValue(new Error('secret db host db.internal:5432 refused')) } },
}));

import app from './app';
import { signToken } from './utils/jwt';

describe('app hardening', () => {
  it('error handler returns a generic message with a request id and no internals', async () => {
    const token = signToken({ userId: 'u1', email: 'a@x.in', role: 'superadmin' as any });
    const res = await request(app).get('/api/v1/parents').set('Authorization', `Bearer ${token}`).set('X-Request-Id', 'req-12345678');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error', requestId: 'req-12345678' });
    expect(JSON.stringify(res.body)).not.toContain('db.internal');
    expect(res.headers['x-request-id']).toBe('req-12345678');
  });

  it('only grants CORS (and credentials) to listed origins', async () => {
    const ok = await request(app).get('/health').set('Origin', 'http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await request(app).get('/health').set('Origin', 'https://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    expect(bad.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('rejects bodies over 1mb with 413 and malformed JSON with 400', async () => {
    const big = await request(app).post('/api/v1/auth/login').send({ pad: 'x'.repeat(1.2 * 1024 * 1024) });
    expect(big.status).toBe(413);
    const bad = await request(app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{oops');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Malformed request body');
  });
});
