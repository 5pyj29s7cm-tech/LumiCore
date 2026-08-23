import { closeDatabase, ensureDatabaseInitialized } from '../../db_layer';
import { releaseDataRootLease } from '../../server/runtime/data_root_lease';

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await closeDatabase();
  } finally {
    releaseDataRootLease();
  }
  process.exit(0);
}

process.on('message', message => {
  if ((message as { type?: string } | null)?.type === 'shutdown') void shutdown();
});
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await ensureDatabaseInitialized();
if (typeof process.send === 'function') {
  process.send({
    type: 'ready',
    pid: process.pid,
    dataRoot: process.env.LUMI_DATA_DIR,
  });
}

// Keep the real SQLite handle and process-scoped lease alive until the parent
// asks for an orderly shutdown or forcibly terminates this fixture.
setInterval(() => undefined, 1_000);
