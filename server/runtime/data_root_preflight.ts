import {
  hasExplicitDataRoot,
  migrateLegacyProductDataRoot,
  preflightProductDataMigrationReceipts,
} from '../config/data_path';
import {
  acquireDataRootLease,
  claimDataRootForMigration,
  releaseDataRootLease,
} from './data_root_lease';

let runtimeDataRootPrepared = false;

/**
 * Establish the sole data-root ownership boundary before the application graph
 * is evaluated. `db_layer` also calls this as a compatibility fallback for
 * direct imports, but this process-local fence makes migration and receipt
 * validation execute only once.
 */
export function prepareRuntimeDataRoot(): void {
  if (runtimeDataRootPrepared) return;

  // Vitest workers intentionally share and reload modules. Cross-process lease
  // fixtures explicitly opt back into the production boundary.
  if (process.env.VITEST === 'true' && process.env.LUMI_ENFORCE_DATA_ROOT_LEASE !== '1') {
    return;
  }

  if (!hasExplicitDataRoot() && process.env.NODE_ENV !== 'test') {
    migrateLegacyProductDataRoot(claimDataRootForMigration);
  }

  acquireDataRootLease();
  try {
    preflightProductDataMigrationReceipts();
  } catch (error) {
    releaseDataRootLease();
    throw error;
  }
  runtimeDataRootPrepared = true;
}
