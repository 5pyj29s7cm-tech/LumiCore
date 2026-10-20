import { expect } from 'vitest';
import fixture from './fixtures/legal_bid_hypothetical_current_money_review.json';

export type MoneyReviewVariant = 'unit2' | 'unit3' | 'unit4' | 'proposal';
type MoneyReviewOverride = { response: string; addSourceIds: string[]; publicAnchor: string; requiredPublicFragments: string[] };
const variants = fixture.variants as Record<MoneyReviewVariant, Record<string, MoneyReviewOverride>>;

/** Explicit hypothetical second-SDK review replies for the current prompt. Never rewrites a captured draft or production result. */
export function hypotheticalCurrentMoneyReview<T extends { sectionId: string; sourceIds: string[]; response: string }>(entries: T[], variant: MoneyReviewVariant): T[] {
  return entries.map(entry => {
    const replacement = variants[variant][entry.sectionId];
    return replacement ? { ...entry, response: replacement.response, sourceIds: [...new Set([...entry.sourceIds, ...replacement.addSourceIds])] } : entry;
  });
}

export function hypotheticalCurrentMoneyResponse(variant: MoneyReviewVariant, sectionId: string): string {
  const replacement = variants[variant][sectionId];
  if (!replacement) throw new Error('No explicit hypothetical monetary review fixture for this section');
  return replacement.response;
}

/** Inspect only compiled proposed-response bodies, excluding original-source quotations and appendices. */
export function assertHypotheticalMoneyPublicProof(content: string, variant: MoneyReviewVariant): void {
  const bodies = content.split('#### 拟议响应（模型工作稿，未作事实认定或核准）').slice(1)
    .map(section => section.split('#### 待补与核验')[0]);
  for (const replacement of Object.values(variants[variant])) {
    const body = bodies.find(value => value.includes(replacement.publicAnchor));
    expect(body).toBeDefined();
    for (const fragment of replacement.requiredPublicFragments) expect(body).toContain(fragment);
    expect(body).not.toMatch(/【F\d+\|/u);
  }
}
