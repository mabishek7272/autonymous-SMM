import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { UserRole } from '@prisma/client';
import app from '../app';
import { signToken } from '../utils/jwt';

describe('dev console guard', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('rejects requests with no credentials, even outside production', async () => {
    process.env.NODE_ENV = 'development';
    const res = await request(app).get('/api/v1/dev/config');
    expect(res.status).toBe(401);
  });

  it('rejects a valid token for a non-admin role', async () => {
    const token = signToken({ userId: 'u1', email: 'teacher@ekalavya.in', role: UserRole.teacher });
    const res = await request(app)
      .get('/api/v1/dev/config')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('allows a valid founder token', async () => {
    const token = signToken({ userId: 'u1', email: 'superadmin@ekalavya.in', role: UserRole.superadmin });
    const res = await request(app)
      .get('/api/v1/dev/config')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
