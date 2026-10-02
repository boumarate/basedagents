/**
 * The package version, with exactly ONE source: package.json.
 *
 * Read at runtime via createRequire rather than a JSON import: a JSON import
 * of a file outside rootDir breaks the tsc build, while runtime resolution
 * works unchanged from BOTH layouts this module lives in — src/ (vitest, tsx)
 * and dist/ (the published build) each sit one directory below the package
 * root, and package.json is always present in a published tarball. (A
 * hand-bumped copy of the version nearly shipped lying once already.)
 */
import { createRequire } from 'node:module';

export const VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;
