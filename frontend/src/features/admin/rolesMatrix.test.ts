import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS_FIXTURE } from '../../test/renderWithProviders';
import { PERMISSIONS, ROLES } from '../../types/permissions';
import { grantableRoles, PERMISSION_LABELS, ROLE_DESCRIPTIONS, ROLE_MATRIX } from './rolesMatrix';

describe('role matrix', () => {
  it('labels exactly the permission names the app uses', () => {
    expect(Object.keys(PERMISSION_LABELS).sort()).toEqual([...PERMISSIONS].sort());
  });

  it('only references known permissions and describes every role', () => {
    for (const role of ROLES) {
      expect(ROLE_DESCRIPTIONS[role]).toBeTruthy();
      for (const p of ROLE_MATRIX[role]) expect(PERMISSIONS).toContain(p);
    }
  });

  it('matches the backend permission matrix', () => {
    for (const role of ROLES) {
      expect([...ROLE_MATRIX[role]].sort()).toEqual([...ROLE_PERMISSIONS_FIXTURE[role]].sort());
    }
  });

  it('lets only a superadmin grant superadmin', () => {
    expect(grantableRoles('superadmin')).toContain('superadmin');
    expect(grantableRoles('admin')).not.toContain('superadmin');
    expect(grantableRoles(undefined)).not.toContain('superadmin');
  });
});
