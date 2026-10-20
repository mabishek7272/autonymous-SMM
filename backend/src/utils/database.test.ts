import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('database truth layer', () => {
  it('does not import the in-memory resilient-store fallback', () => {
    const source = fs.readFileSync(path.resolve(__dirname, './database.ts'), 'utf-8');
    expect(source).not.toMatch(/resilient-store/);
    expect(source).not.toMatch(/new Proxy/);
  });

  it('deletes the resilient-store.ts mock data file', () => {
    const storePath = path.resolve(__dirname, '../services/resilient-store.ts');
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it('exports a usable PrismaClient instance', async () => {
    const { prisma } = await import('./database');
    expect(typeof prisma.$connect).toBe('function');
    expect(typeof (prisma as any).lead.findMany).toBe('function');
  });
});
