import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { can, rolesWith, ROLE_PERMISSIONS, ownStudentIds } from './permissions';
import { prisma } from './database';

describe('portal permission', () => {
  it('only parent and student roles hold portal:view', () => {
    expect(rolesWith('portal:view').sort()).toEqual(['parent', 'student']);
  });

  it('parent and student hold no staff permissions', () => {
    for (const role of ['parent', 'student'] as const) {
      expect(ROLE_PERMISSIONS[role]).toEqual(['portal:view']);
      expect(can(role, 'leads:manage')).toBe(false);
      expect(can(role, 'dev:console')).toBe(false);
    }
  });
});

describe('ownStudentIds', () => {
  let parentId: string;
  let studentId: string;

  beforeEach(async () => {
    const parent = await prisma.parent.create({ data: { fullName: 'Scope Parent', whatsappNumber: '919990000099' } });
    parentId = parent.id;
    const student = await prisma.student.create({ data: { parentId, fullName: 'Scope Kid', status: 'active' } });
    studentId = student.id;
  });

  afterEach(async () => {
    await prisma.student.deleteMany({ where: { parentId } });
    await prisma.parent.delete({ where: { id: parentId } });
  });

  it('a parent sees all of their own children and nobody else\'s', async () => {
    const ids = await ownStudentIds({ role: 'parent', parentId });
    expect(ids).toEqual([studentId]);
  });

  it('a student sees only themself', async () => {
    const ids = await ownStudentIds({ role: 'student', studentId });
    expect(ids).toEqual([studentId]);
  });

  it('a staff role (not parent/student) resolves to no self-scope', async () => {
    expect(await ownStudentIds({ role: 'teacher' })).toEqual([]);
  });
});
