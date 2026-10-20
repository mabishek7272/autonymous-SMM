import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { UserRole } from '@prisma/client';
import { signToken } from './utils/jwt';

vi.mock('./utils/database', () => ({
  prisma: {
    parent: {
      findMany: vi.fn().mockRejectedValue(new Error('simulated DB outage with sensitive details')),
    },
  },
}));

describe('global error handler', () => {
  it('never leaks the raw error message to the client, in any NODE_ENV', async () => {
    const { default: app } = await import('./app');
    const token = signToken({ userId: 'u1', email: 'superadmin@ekalavya.in', role: UserRole.superadmin });

    const res = await request(app)
      .get('/api/v1/parents')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(JSON.stringify(res.body)).not.toContain('simulated DB outage');
  });
});
