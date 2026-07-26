import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  CalendarCreateInput,
  CalendarModifyInput,
  ProductivityAdapter,
} from './productivity_contract';

const execFileAsync = promisify(execFile);

async function runJxa(
  body: string,
  payload: object = {},
): Promise<Record<string, unknown>> {
  const script = `
function run(argv) {
  const payload = JSON.parse(argv[0] || '{}');
  ${body}
}
`;
  try {
    const { stdout } = await execFileAsync('osascript', [
      '-l',
      'JavaScript',
      '-e',
      script,
      '--',
      JSON.stringify(payload),
    ], {
      timeout: 25_000,
      maxBuffer: 1024 * 1024,
    });
    const text = String(stdout || '').trim();
    if (!text) throw new Error('The macOS productivity adapter returned no receipt.');
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error: any) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(`macOS Calendar/Mail adapter failed: ${detail.slice(0, 500)}`);
  }
}

const CALENDAR_LOOKUP = `
  const app = Application('Calendar');
  app.includeStandardAdditions = true;
  const calendars = app.calendars();
  if (!calendars.length) throw new Error('No writable macOS Calendar is available.');
  const calendar = calendars[0];
`;

const EVENT_JSON = `event => ({
  id: String(event.uid()),
  subject: String(event.summary()),
  start: new Date(event.startDate()).toISOString(),
  end: new Date(event.endDate()).toISOString(),
  location: String(event.location() || '')
})`;

export const macosProductivityAdapter: ProductivityAdapter = {
  id: 'macos.calendar_mail_jxa',
  platform: 'macos',

  calendarToday: async () => runJxa(`
${CALENDAR_LOOKUP}
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const finish = new Date(start.getTime() + 86400000);
  const items = calendar.events().filter(event => {
    const date = new Date(event.startDate());
    return date >= start && date < finish;
  }).map(${EVENT_JSON});
  return JSON.stringify({ ok: true, status: 'observed', provider: 'macos_calendar', items });
`),

  upcomingEvents: async days => runJxa(`
${CALENDAR_LOOKUP}
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const finish = new Date(start.getTime() + Number(payload.days) * 86400000);
  const items = calendar.events().filter(event => {
    const date = new Date(event.startDate());
    return date >= start && date < finish;
  }).slice(0, 30).map(${EVENT_JSON});
  return JSON.stringify({ ok: true, status: 'observed', provider: 'macos_calendar', items });
`, { days }),

  sendEmail: async input => runJxa(`
  const app = Application('Mail');
  const message = app.OutgoingMessage({
    subject: String(payload.subject),
    content: String(payload.body),
    visible: false
  });
  message.toRecipients.push(app.ToRecipient({ address: String(payload.to) }));
  app.outgoingMessages.push(message);
  message.send();
  let messageId = '';
  try { messageId = String(message.id()); } catch (_) {}
  return JSON.stringify({ ok: true, status: 'sent', sent: true, provider: 'macos_mail', recipient: String(payload.to), messageId });
`, input),

  recentEmails: async limit => runJxa(`
  const app = Application('Mail');
  const messages = app.inbox.messages().slice(0, Number(payload.limit));
  const items = messages.map(message => ({
    id: String(message.messageId() || message.id()),
    from: String(message.sender() || ''),
    subject: String(message.subject() || ''),
    received: new Date(message.dateReceived()).toISOString(),
    unread: !Boolean(message.readStatus())
  }));
  return JSON.stringify({ ok: true, status: 'observed', provider: 'macos_mail', items });
`, { limit }),

  createEvent: async input => runJxa(`
${CALENDAR_LOOKUP}
  const event = app.Event({
    summary: String(payload.subject),
    startDate: new Date(String(payload.start)),
    endDate: new Date(String(payload.end)),
    location: String(payload.location || ''),
    description: String(payload.body || ''),
    alldayEvent: Boolean(payload.allDay)
  });
  calendar.events.push(event);
  return JSON.stringify({ ok: true, status: 'created', created: true, provider: 'macos_calendar', eventId: String(event.uid()), subject: String(payload.subject) });
`, input),

  modifyEvent: async input => runJxa(`
${CALENDAR_LOOKUP}
  const event = calendar.events().find(item => String(item.summary()) === String(payload.subject));
  if (!event) return JSON.stringify({ ok: false, status: 'not_found', updated: false, provider: 'macos_calendar', subject: String(payload.subject) });
  if (payload.newSubject) event.summary = String(payload.newSubject);
  if (payload.newStart) event.startDate = new Date(String(payload.newStart));
  if (payload.newEnd) event.endDate = new Date(String(payload.newEnd));
  if (payload.newLocation !== undefined) event.location = String(payload.newLocation);
  if (payload.newBody !== undefined) event.description = String(payload.newBody);
  return JSON.stringify({ ok: true, status: 'updated', updated: true, provider: 'macos_calendar', eventId: String(event.uid()), subject: String(event.summary()) });
`, input),

  deleteEvent: async input => runJxa(`
${CALENDAR_LOOKUP}
  const event = calendar.events().find(item => String(item.summary()) === String(payload.subject));
  if (!event) return JSON.stringify({ ok: false, status: 'not_found', deleted: false, provider: 'macos_calendar', subject: String(payload.subject) });
  const eventId = String(event.uid());
  app.delete(event);
  return JSON.stringify({ ok: true, status: 'deleted', deleted: true, provider: 'macos_calendar', eventId, subject: String(payload.subject) });
`, input),
};
