import type { TableData, TableEditPermissions } from '@/app/types/tableTypes';

export interface EditSettingsDraft {
  display_name: string;
  initial_transposed: boolean;
  description: string;
  edit_permissions: TableEditPermissions;
}
export function tableSettingsDraft(table: TableData): EditSettingsDraft {
  return { display_name: table.display_name, description: table.description,
    initial_transposed: table.metadata.initial_transposed,
    edit_permissions: { ...table.metadata.edit_permissions } };
}
export function settingsDraftEqual(a: EditSettingsDraft, b: EditSettingsDraft): boolean {
  return a.display_name === b.display_name && a.description === b.description
    && a.initial_transposed === b.initial_transposed
    && (Object.keys(a.edit_permissions) as Array<keyof TableEditPermissions>).every(key => a.edit_permissions[key] === b.edit_permissions[key]);
}
/** Refresh untouched fields without losing local text or replaying stale interface permissions. */
export function rebaseSettingsDraft(draft: EditSettingsDraft, before: EditSettingsDraft, next: EditSettingsDraft): EditSettingsDraft {
  const permissions = { ...draft.edit_permissions };
  for (const key of Object.keys(permissions) as Array<keyof TableEditPermissions>) {
    if (permissions[key] === before.edit_permissions[key]) permissions[key] = next.edit_permissions[key];
  }
  return { display_name: draft.display_name === before.display_name ? next.display_name : draft.display_name,
    description: draft.description === before.description ? next.description : draft.description,
    initial_transposed: draft.initial_transposed === before.initial_transposed ? next.initial_transposed : draft.initial_transposed,
    edit_permissions: permissions };
}
