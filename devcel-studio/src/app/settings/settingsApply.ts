import { isSettingsEditor } from '@/app/applicationMode';
import { getSettingsSnapshot, refreshAppSettings } from './index';
import { createSettingsApplyTracker } from './settingsApplyTracker';
export const settingsApply = createSettingsApplyTracker(refreshAppSettings);
export function beginSettingsSave() {
  return isSettingsEditor() ? settingsApply.begin(getSettingsSnapshot().generation) : undefined;
}
