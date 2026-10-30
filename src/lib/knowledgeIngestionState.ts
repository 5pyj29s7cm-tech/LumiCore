/** HTTP success means processing ran, not that its source coverage was verified. */
export function knowledgeIngestionVerified(value: { ingestionStatus?: string; extractionStatus?: string; coverage?: any; ingestionCoverage?: any }): boolean {
  const coverage = value.coverage ?? value.ingestionCoverage;
  return value.ingestionStatus === 'verified'
    // The file API's extraction enum uses "indexed"; "verified" belongs to
    // the separate ingestion manifest stage, not this outer receipt field.
    && value.extractionStatus === 'indexed'
    && coverage?.verified === true && coverage.sourceRevisionCurrent === true
    && ['extractionCoverage', 'chunkStorageCoverage', 'embeddingCoverage'].every(key => coverage[key] === 1)
    && Array.isArray(coverage.blockers) && coverage.blockers.length === 0;
}
