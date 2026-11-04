#!/usr/bin/env node

/**
 * Check the installed Rolldown loader without changing dependencies during builds.
 * Rolldown selects the correct optional native package, including the Linux libc.
 */

try {
  const { VERSION } = await import('rolldown');
  console.log(`[ensure-rolldown] Rolldown ${VERSION} is ready (${process.platform}-${process.arch})`);
} catch (error) {
  console.error(`[ensure-rolldown] Rolldown could not load: ${error.message}`);
  console.error('[ensure-rolldown] Run "npm ci --include=optional" to restore the locked dependencies.');
  process.exitCode = 1;
}
