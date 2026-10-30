import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ rows: [] as any[], get: vi.fn(), search: vi.fn() }));
vi.mock('../server/middleware/auth', () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock('../server/contacts/store', () => ({ getContacts: f.get, searchContacts: f.search, addContact: vi.fn(), updateContact: vi.fn(), deleteContact: vi.fn(), recordInteraction: vi.fn() }));
import { mountContactsRoutes } from '../server/routes/contacts_routes';
beforeEach(() => {
  f.rows = Array.from({ length: 53 }, (_, n) => ({ id: String(n), name: 'Contact ' + n }));
  f.get.mockReset().mockReturnValue(f.rows); f.search.mockReset().mockReturnValue([f.rows[30]]);
});
function request(query: any) {
  const routes = new Map(); const router = { get: (path: string, ...handlers: any[]) => routes.set(path, handlers.at(-1)), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
  mountContactsRoutes(router as any, 'unused');
  const res = { json: vi.fn(), status: vi.fn() }; res.status.mockReturnValue(res);
  routes.get('/contacts')({ user: { uid: 'owner' }, query }, res); return res;
}
it('personal-completeness contacts preserves the legacy list and returns bounded owner-scoped pages', () => {
  expect(request({}).json).toHaveBeenCalledWith(expect.objectContaining({ contacts: f.rows }));
  expect(request({ limit: '25', offset: '25' }).json).toHaveBeenCalledWith(expect.objectContaining({ contacts: f.rows.slice(25, 50), total: 53, limit: 25, offset: 25 }));
  expect(f.get).toHaveBeenCalledWith('owner');
  expect(request({ limit: '25', offset: '0', search: 'Needle' }).json).toHaveBeenCalledWith(expect.objectContaining({ contacts: [f.rows[30]], total: 1 }));
  expect(f.search).toHaveBeenCalledWith('owner', 'Needle');
});
it.each([{ limit: '101' }, { limit: '-1' }, { limit: '1.5' }, { limit: ['25'] }, { offset: '-1' }, { offset: 'Infinity' }, { search: ['x'] }])('personal-completeness contacts rejects malformed pagination %j', query => {
  expect(request(query).status).toHaveBeenCalledWith(400);
});
