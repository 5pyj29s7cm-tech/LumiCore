import { describe, it, expect } from 'vitest';
import { createTableSession, prepareTableCommit } from '../server/db/table_session';
const apply = (session: any, root: any) => { const staged = prepareTableCommit(session, root); Object.assign(root, staged.changes); staged.accept(); };
describe('selected table transactions', () => {
  it('does not read untouched selected tables during commits or no-op checkpoints', () => {
    let reads = 0;
    const root = { rows: [{ id: 'a', value: 1 }], get unused() { reads++; throw new Error('unused table was materialized'); } };
    const session = createTableSession(root, ['rows', 'unused']);
    apply(session, root);
    session.rows[0].value = 2; apply(session, root); apply(session, root);
    expect(reads).toBe(0); expect(root.rows[0].value).toBe(2);
  });
  it('keeps untouched row identities while applying edits, appends and explicit order changes', () => {
    const root = { rows: [{ id: 'a', value: 1 }, { id: 'b', value: 1 }] };
    const first = root.rows[0], second = root.rows[1];
    const session = createTableSession(root, ['rows']);
    session.rows[1].value = 2; session.rows.unshift({ id: 'c', value: 3 }); session.rows.reverse();
    apply(session, root);
    expect(root.rows.map(row => row.id)).toEqual(['b', 'a', 'c']);
    expect(root.rows[1]).toBe(first); expect(root.rows[0]).not.toBe(second);
    const unchanged = root.rows[0]; session.rows[2].value = 4; apply(session, root);
    expect(root.rows[0]).toBe(unchanged);
  });
  it('never exposes unselected tables or live nested rows', () => {
    const root = { users: [{ uid: 'a', name: 'A', tags: ['old'] }], secrets: [{ key: 'secret' }] };
    const session = createTableSession(root, ['users']);
    expect(() => (session as any).secrets).toThrow('outside selected scope');
    expect(() => (session as any).secrets = []).toThrow('outside selected scope');
    session.users[0].tags.push('new'); expect(root.users[0].tags).toEqual(['old']);
    apply(session, root); session.users[0].tags.push('after'); expect(root.users[0].tags).toEqual(['old', 'new']);
    expect(root.secrets).toEqual([{ key: 'secret' }]);
  });
  it('retains other writers on other tables, rows and independent fields', () => {
    const root = { users: [{ uid: 'a', name: 'A', role: 'member' }], messages: [] };
    const first = createTableSession(root, ['users']); first.users[0].name = 'New';
    const second = createTableSession(root, ['users', 'messages']); second.users[0].role = 'admin'; second.users.push({ uid: 'b', name: 'B', role: 'member' }); second.messages.push({ id: 'm' });
    apply(second, root); apply(first, root);
    expect(root.users).toEqual([{ uid: 'a', name: 'New', role: 'admin' }, { uid: 'b', name: 'B', role: 'member' }]); expect(root.messages).toEqual([{ id: 'm' }]);
  });
  it('rejects conflicting fields atomically across every selected table', () => {
    const root = { users: [{ uid: 'a', name: 'A' }], messages: [] };
    const first = createTableSession(root, ['messages', 'users']); first.messages.push({ id: 'm' }); first.users[0].name = 'first';
    const second = createTableSession(root, ['users']); second.users[0].name = 'second'; apply(second, root);
    expect(() => apply(first, root)).toThrow('conflicts'); expect(root.messages).toEqual([]); expect(root.users[0].name).toBe('second');
  });
  it('rejects stale deletion and resurrection while preserving concurrent appends', () => {
    const root = { rows: [{ id: 'a', value: 1 }, { id: 'b', value: 1 }] };
    const deleting = createTableSession(root, ['rows']); deleting.rows.splice(0, 1);
    const changing = createTableSession(root, ['rows']); changing.rows[0].value = 2; apply(changing, root);
    expect(() => apply(deleting, root)).toThrow('conflicts');
    const stale = createTableSession(root, ['rows']); stale.rows[0].value = 3;
    const fresh = createTableSession(root, ['rows']); fresh.rows.splice(0, 1); apply(fresh, root);
    expect(() => apply(stale, root)).toThrow('conflicts');
  });
  it('accepts spread replacements and checkpoints without persisting caller aliases', () => {
    const root = { rows: [{ id: 'a', value: 1 }] }; const session = createTableSession(root, ['rows']);
    const row = { id: 'b', value: 2 }; const replacement = { ...session, rows: [...session.rows, row] }; apply(replacement, root); row.value = 99;
    expect(root.rows[1].value).toBe(2);
    expect(() => apply({ ...session, extra: [] }, root)).toThrow('outside selected scope');
    const checkpoints = createTableSession(root, ['rows']); checkpoints.rows[0].value = 3; apply(checkpoints, root); checkpoints.rows[0].value = 4; apply(checkpoints, root); expect(root.rows[0].value).toBe(4);
  });
  it('stages reentrant callback failures without changing accepted rows', () => {
    const root = { rows: [{ id: 'a', value: 1 }] }; const session = createTableSession(root, ['rows']);
    expect(() => { session.rows[0].value = 2; throw new Error('abort'); }).toThrow('abort'); expect(root.rows[0].value).toBe(1);
  });
});

describe('scoped knowledge file row identity', () => {
  it('merges concurrent updates and additions without conflating the same filename across owners', () => {
    const root = { knowledgeFiles: [
      { filename: 'notes.txt', userId: 'alice', domain: 'personal', orgId: '', status: 'ready' },
      { filename: 'notes.txt', userId: 'bob', domain: 'work', orgId: 'company', status: 'ready' },
    ] };
    const first = createTableSession(root, ['knowledgeFiles']); first.knowledgeFiles[0].status = 'indexed';
    const second = createTableSession(root, ['knowledgeFiles']); second.knowledgeFiles[1].status = 'partial';
    second.knowledgeFiles.push({ filename: 'other.txt', userId: 'alice', domain: 'personal', orgId: '', status: 'ready' });
    apply(second, root); apply(first, root);
    expect(root.knowledgeFiles.map(row => [row.filename, row.userId, row.status])).toEqual([
      ['notes.txt', 'alice', 'indexed'], ['notes.txt', 'bob', 'partial'], ['other.txt', 'alice', 'ready'],
    ]);
  });
  it('rejects an old indexing result after its exact owned file row was deleted', () => {
    const root = { knowledgeFiles: [{ filename: 'notes.txt', userId: 'alice', status: 'ready' }] };
    const indexing = createTableSession(root, ['knowledgeFiles']); indexing.knowledgeFiles[0].status = 'indexed';
    const deleting = createTableSession(root, ['knowledgeFiles']); deleting.knowledgeFiles = []; apply(deleting, root);
    expect(() => apply(indexing, root)).toThrow('conflicts'); expect(root.knowledgeFiles).toEqual([]);
  });
  it('does not guess an identity for ambiguous duplicate legacy rows', () => {
    const root = { knowledgeFiles: [{ filename: 'notes.txt', status: 'ready' }, { filename: 'notes.txt', status: 'ready' }] };
    const first = createTableSession(root, ['knowledgeFiles']); first.knowledgeFiles[0].status = 'indexed';
    const second = createTableSession(root, ['knowledgeFiles']); second.knowledgeFiles[1].status = 'partial'; apply(second, root);
    expect(() => apply(first, root)).toThrow('conflicts'); expect(root.knowledgeFiles[0].status).toBe('ready');
  });
});
