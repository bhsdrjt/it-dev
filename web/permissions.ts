import { createContext, useContext } from 'react';

export const PermissionsContext = createContext<readonly string[]>([]);
export const usePermissions = () => {
  const permissions = useContext(PermissionsContext);
  return (code: string) => permissions.includes(code);
};
export const pagePermissions = {
  anomalies: 'monitoring.view', equipment: 'equipment.view', transactions: 'transactions.view',
  'truck-history': 'timeline.view', 'coal-calory': 'coal.view', activity: 'activity.view', access: 'access.manage',
  'biostar-import': 'biostar.import',
} as const;
