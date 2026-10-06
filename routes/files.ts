import { Router } from "express";
import type { KnowledgeExtractionDeps } from '../server/files/knowledge/extraction';
import { updateKnowledgeExtractionDependencies } from '../server/files/knowledge/extraction';
import { scheduleLegacyKnowledgeRevalidation } from '../server/files/knowledge/legacy_revalidation';
import { registerKnowledgeArchiveRoutes } from '../server/files/knowledge/archive_routes';
import { registerObsidianRoutes } from '../server/files/knowledge/obsidian_routes';
import { registerKnowledgeImportRoutes } from '../server/files/knowledge/import_routes';
import { registerKnowledgeAccessRoutes } from '../server/files/knowledge/access_routes';
import { registerKnowledgeIngestionRoutes } from '../server/files/knowledge/ingestion_routes';

export type { KnowledgeExtractionResult } from '../server/files/knowledge/contracts';
export type { KnowledgeEntry } from '../server/files/knowledge/contracts';
export { extractKnowledgeFileContent } from '../server/files/knowledge/extraction';
export { revalidateOneLegacyKnowledgeFile } from '../server/files/knowledge/legacy_revalidation';
export { scheduleLegacyKnowledgeRevalidation } from '../server/files/knowledge/legacy_revalidation';
export { classifyKnowledgeExtractionFailure } from '../server/files/knowledge/extraction';

const router = Router();

export function configureKnowledgeFileRoutes(deps: KnowledgeExtractionDeps): void {
  updateKnowledgeExtractionDependencies(deps);
  scheduleLegacyKnowledgeRevalidation();
}

registerKnowledgeArchiveRoutes(router);

registerObsidianRoutes(router);

registerKnowledgeImportRoutes(router);

registerKnowledgeAccessRoutes(router);

registerKnowledgeIngestionRoutes(router);

export default router;
