import { appAlert } from '@/app/services/appDialogs';
import { t } from '@/app/i18n';
/**
 * Validation function for data_name
 * Follow C variable naming rules: Letters, digits, and underscores only; start with a letter or underscore
 */
export function validateDataName(name: string): { isValid: boolean; errorMessage?: string } {
  if (!name || name.trim() === '') {
    return { isValid: false, errorMessage: t('column.validation.emptyName') };
  }

  // Check length to prevent excessively long names
  if (name.length > 255) {
    return { isValid: false, errorMessage: t('column.validation.longName') };
  }

  // Check the first character
  const firstChar = name.charAt(0);
  if (!/^[a-zA-Z_]$/.test(firstChar)) {
    return { 
      isValid: false, 
      errorMessage: t('column.validation.nameStart')
    };
  }

  // Check the remaining characters
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return { 
      isValid: false, 
      errorMessage: t('column.validation.nameCharacters')
    };
  }

  return { isValid: true };
}

/**
 * Convenience function validating input and showing an alert for errors
 */
export async function validateAndShowError(name: string, context: string = t('column.validation.name')): Promise<boolean> {
  const validation = validateDataName(name);
  if (!validation.isValid) {
    await appAlert(t('column.validation.inputError', { context, error: validation.errorMessage || '' }));
    return false;
  }
  return true;
}
/** Keep unchanged legacy tags; validate only names introduced by this draft. */
export function changedTagNameError(tags: readonly string[], originalTags: readonly string[]): string | undefined {
  for (const tag of tags) {
    if (originalTags.includes(tag)) continue;
    const normalized = tag.trim();
    if (originalTags.includes(normalized)) continue;
    const validation = validateDataName(normalized);
    if (!validation.isValid) return validation.errorMessage;
  }
  return undefined;
}
