/**
 * Side-effect-safe runtime entrypoint.
 *
 * The legacy product root must be migrated before importing the application
 * graph: several providers resolve persistent paths at module evaluation time.
 * Keeping the application import dynamic makes this ordering an executable
 * boundary instead of relying on ESM import declaration order.
 */
// Resolve .env data-root overrides before migration and before privacy/keys
// modules capture persistent paths. server.ts also imports this cached module.
import 'dotenv/config';
import { prepareRuntimeDataRoot } from './data_root_preflight';

prepareRuntimeDataRoot();

// Freeze the saved privacy policy before providers or background workers start.
const { getPrivacyMode } = await import('../config/privacy');
getPrivacyMode();

await import('../../server');
