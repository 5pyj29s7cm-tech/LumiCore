import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers';

let cleanup = () => {};
let LegalCases: typeof import('../server/org/legal_cases');

beforeAll(async () => {
  const app = await makeApp();
  cleanup = app.cleanup;
  LegalCases = await import('../server/org/legal_cases');
});

afterAll(() => cleanup());

describe('organization legal case deletion', () => {
  it('deletes only the requested case in the requested organization', () => {
    const orgId = `org-delete-${Date.now()}`;
    const first = LegalCases.createCase(orgId, 'owner-user', { title: 'First case' });
    const second = LegalCases.createCase(orgId, 'owner-user', { title: 'Second case' });
    LegalCases.addMaterial(orgId, 'owner-user', first.id, {
      type: 'evidence',
      title: 'Evidence record',
      content: 'Archived evidence',
      source: 'manual',
    });

    const deleted = LegalCases.deleteCase(orgId, 'owner-user', first.id);

    expect(deleted?.id).toBe(first.id);
    expect(deleted?.materials).toHaveLength(1);
    expect(LegalCases.getCase(orgId, first.id)).toBeNull();
    expect(LegalCases.getCase(orgId, second.id)?.title).toBe('Second case');
    expect(LegalCases.deleteCase('another-org', 'owner-user', second.id)).toBeNull();
  });
});
