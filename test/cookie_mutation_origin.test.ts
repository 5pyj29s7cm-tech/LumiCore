import './helpers';
import jwt from 'jsonwebtoken';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { initDatabase } from '../db_layer';
import { JWT_SECRET } from './helpers';
import { createApp } from '../server/runtime/core';
import { autonomyRoutes } from '../server/routes/autonomy_routes';
import { enqueue } from '../server/autonomy/task_queue';
import { getRuntimeWorkSnapshot } from '../server/runtime/work_control';
let ctx: any, base = '';
beforeAll(async () => { await initDatabase(); ctx = createApp(); ctx.apiRouter.use('/autonomy', autonomyRoutes()); await new Promise<void>((resolve, reject) => { ctx.server.once('error', reject); ctx.server.listen(0, '127.0.0.1', resolve); }); base = 'http://127.0.0.1:' + ctx.server.address().port; });
afterAll(async () => { ctx.io.close(); await new Promise<void>(r => ctx.server.close(() => r())); });
describe('audit cross origin boundary observations', () => {
    it('disallowed Origin cannot execute a cookie-authenticated task pause POST', async () => { const uid = 'audit-cors'; enqueue({ id: 'audit-cors-task', userId: uid, title: 'Audit pause only', description: 'No tool execution', status: 'pending', source: 'user_request', priority: 1, mode: 'analysis', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any); const item = getRuntimeWorkSnapshot(uid, undefined, { domain: 'personal' }).items.find(x => x.title === 'Audit pause only')!; expect(item).toBeDefined(); const token = jwt.sign({ uid, username: uid, role: 'user' }, JWT_SECRET); const r = await fetch(base + '/api/autonomy/work/' + encodeURIComponent(item.id) + '/pause', { method: 'POST', headers: { Origin: 'https://audit-attacker.invalid', Cookie: 'token=' + token, 'Content-Type': 'text/plain' }, body: '' }); expect(r.status).toBe(403); expect(r.headers.get('access-control-allow-origin')).toBeNull(); const d = await r.json(); expect(d.code).toBe('UNTRUSTED_ORIGIN'); });
});
