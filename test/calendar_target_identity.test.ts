import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ run: (_script: string, _payload: string): any => ({ ok: false }) }));
vi.mock('child_process', () => ({ execFile: (_command: string, args: string[], _options: any, callback: any) => {
  try { callback(null, JSON.stringify(state.run(args[3], args[5])), ''); } catch (error) { callback(error); }
} }));
vi.mock('util', () => ({ promisify: () => async (_command: string, args: string[]) => ({ stdout: JSON.stringify(state.run(args[3], args[5])) }) }));
import { macosProductivityAdapter } from '../server/adapters/macos_productivity';
function fixture() {
  const deleted: string[] = [];
  const event = (id: string) => ({ uid: () => id, summary: () => 'Weekly sync', recurrence: () => '' });
  const events = [event('old'), event('intended')];
  const app = { calendars: () => [{ uid: () => 'calendar-a', events: () => events }], delete: (item: any) => deleted.push(item.uid()) };
  state.run = (script, payload) => JSON.parse(vm.runInNewContext(`${script}\nrun(${JSON.stringify([payload])})`, { Application: () => app }));
  return { deleted, events };
}
describe('calendar mutation identity', () => {
  it('deletes the observed id even when an earlier event has the same subject', async () => {
    const { deleted } = fixture();
    const receipt = await macosProductivityAdapter.deleteEvent({ subject: 'Weekly sync', eventId: 'intended', calendarId: 'calendar-a' });
    expect(deleted).toEqual(['intended']); expect(receipt).toMatchObject({ status: 'deleted', eventId: 'intended', calendarId: 'calendar-a' });
  });
  it.each([
    { subject: 'Weekly sync' },
    { subject: 'Weekly sync', eventId: 'intended', calendarId: 'wrong-calendar' },
    { subject: 'Renamed event', eventId: 'intended', calendarId: 'calendar-a' },
  ])('refuses a missing, stale, or mismatched identity (%j)', async input => {
    const { deleted } = fixture();
    const receipt = await macosProductivityAdapter.deleteEvent(input);
    expect(receipt.ok).toBe(false); expect(deleted).toEqual([]);
  });
  it('refuses recurring event changes rather than changing an entire series by accident', async () => {
    const { events, deleted } = fixture(); events[1].recurrence = () => 'FREQ=WEEKLY';
    const receipt = await macosProductivityAdapter.deleteEvent({ subject: 'Weekly sync', eventId: 'intended', calendarId: 'calendar-a' });
    expect(receipt.status).toBe('unsupported'); expect(deleted).toEqual([]);
  });
});
