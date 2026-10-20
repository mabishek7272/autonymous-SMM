import { Check, Minus } from 'lucide-react';
import { PERMISSIONS, ROLES, ROLE_LABELS } from '../../types/permissions';
import { Card, CardHeader } from '../../ui';
import { PERMISSION_LABELS, ROLE_DESCRIPTIONS, ROLE_MATRIX } from './rolesMatrix';

export function RolesLegend() {
  return (
    <Card>
      <CardHeader title="What each role can access" subtitle="Access is decided by permissions, shown here for reference." />
      <div className="adm-roles">
        {ROLES.map((r) => (
          <div key={r}>
            <strong>{ROLE_LABELS[r]}</strong>
            <p>{ROLE_DESCRIPTIONS[r]}</p>
          </div>
        ))}
      </div>
      <table className="adm-matrix">
        <caption className="ek-sr-only">Permissions by role</caption>
        <thead>
          <tr>
            <th scope="col">Permission</th>
            {ROLES.map((r) => (
              <th key={r} scope="col">
                {ROLE_LABELS[r]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PERMISSIONS.map((p) => (
            <tr key={p}>
              <th scope="row" style={{ fontWeight: 500 }}>
                {PERMISSION_LABELS[p]}
              </th>
              {ROLES.map((r) =>
                ROLE_MATRIX[r].includes(p) ? (
                  <td key={r}>
                    <span className="adm-yes">
                      <Check size={15} aria-hidden="true" />
                      <span className="ek-sr-only">Allowed</span>
                    </span>
                  </td>
                ) : (
                  <td key={r}>
                    <span className="adm-no">
                      <Minus size={15} aria-hidden="true" />
                      <span className="ek-sr-only">Not allowed</span>
                    </span>
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
