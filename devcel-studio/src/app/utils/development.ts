/**
 * Development mode detection and utilities
 */

/**
 * Check if the application is running in development mode
 */
export function isDevelopmentMode(): boolean {
  return import.meta.env.DEV;
}

/**
 * Check if debug features should be enabled
 */
export function isDebugEnabled(): boolean {
  return isDevelopmentMode() || import.meta.env.VITE_DEBUG === 'true';
}