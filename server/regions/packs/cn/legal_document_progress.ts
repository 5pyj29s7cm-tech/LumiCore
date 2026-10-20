import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDataDirectory } from '../../../config/data_path';
import { legalWrite } from '../../../legal/execution';

type ReviewSummary = { proposedCorrections: number; appliedCorrections: number; hashScope: 'review-documents-v1'; beforeSha256: string; afterSha256: string };
type Draft = { markdown: string; reviewed: boolean; reviewSummary?: ReviewSummary };
/** A source-scoped checkpoint for the existing packet tool, not another task. */
export function legalDocumentProgress(scope: string | null, reset = false) {
  const fingerprint = scope ? crypto.createHash('sha256').update('legal-document-review-v2\n' + scope).digest('hex') : '';
  const file = fingerprint ? path.join(getDataDirectory('legal_document_progress'), fingerprint + '.json') : '';
  const documents = new Map<string, Draft>();
  if (file && !reset) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.fingerprint === fingerprint && Number.isFinite(saved.updatedAt)
        && saved.updatedAt <= Date.now() && Date.now() - saved.updatedAt < 24 * 60 * 60 * 1000
        && saved.documents && typeof saved.documents === 'object' && !Array.isArray(saved.documents)) {
        for (const [name, raw] of Object.entries(saved.documents)) {
          const draft = raw as Draft;
          if (draft && typeof draft.markdown === 'string' && draft.markdown.trim().length >= 40 && typeof draft.reviewed === 'boolean') documents.set(name, draft);
        }
      }
    } catch { /* Missing or interrupted checkpoints are regenerated safely. */ }
  }
  const persist = () => {
    if (!file) return;
    legalWrite(() => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = file + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify({ fingerprint, updatedAt: Date.now(), documents: Object.fromEntries(documents) }), 'utf8');
      fs.renameSync(temporary, file);
    });
  };
  return {
    get: (name: string) => documents.get(name),
    remove(name: string) { if (documents.delete(name)) persist(); },
    save(name: string, markdown: string, reviewed: boolean, review?: { proposedCorrections: number; appliedCorrections: number; before: string; after: string }) {
      documents.set(name, { markdown, reviewed, ...(review ? { reviewSummary: {
        proposedCorrections: review.proposedCorrections, appliedCorrections: review.appliedCorrections, hashScope: 'review-documents-v1' as const,
        beforeSha256: crypto.createHash('sha256').update(review.before).digest('hex'),
        afterSha256: crypto.createHash('sha256').update(review.after).digest('hex'),
      } } : {}) });
      persist();
    },
  };
}
