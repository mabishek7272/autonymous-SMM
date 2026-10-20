import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { UserRole } from '@prisma/client';
import { signToken } from '../utils/jwt';

vi.mock('../utils/database', () => ({
  prisma: {
    parent: {
      findMany: vi.fn().mockRejectedValue(new Error('simulated DB outage')),
    },
  },
}));

describe('parent routes error handling', () => {
  it('returns a clean 5xx instead of crashing when Prisma rejects', async () => {
    const { default: app } = await import('../app');
    const token = signToken({ userId: 'u1', email: 'superadmin@ekalavya.in', role: UserRole.superadmin });

    const res = await request(app)
      .get('/api/v1/parents')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.status).toBeLessThan(600);
  });
});
