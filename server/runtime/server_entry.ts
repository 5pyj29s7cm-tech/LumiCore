/**
 * Side-effect-safe runtime entrypoint.
 *
 * The legacy product root must be migrated before importing the application
 * graph: several providers resolve persistent paths at module evaluation time.
 * Keeping the application import dynamic makes this ordering an executable
 * boundary instead of relying on ESM import declaration order.
 */
import { prepareRuntimeDataRoot } from './data_root_preflight';

prepareRuntimeDataRoot();

await import('../../server');
