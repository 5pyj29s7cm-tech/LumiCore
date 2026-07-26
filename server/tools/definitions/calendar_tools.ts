import { getProductivityAdapter } from '../../adapters/productivity';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import { ToolRegistry } from '../registry';
import type { ToolCapabilityMetadata } from '../types';

function withProductivityAdapter(
  operation: string,
  capability: ToolCapabilityMetadata,
): ToolCapabilityMetadata {
  return {
    ...capability,
    adapter: {
      id: 'productivity.calendar-mail',
      operations: [operation],
      implementations: {
        windows: 'windows.outlook_com',
        macos: 'macos.calendar_mail_jxa',
      },
    },
  };
}

export function registerCalendarTools(registry: ToolRegistry): void {
  registry.register({
    name: 'calendar_today',
    description: 'Get today\'s events from the platform calendar provider. Windows uses Outlook COM and macOS uses Calendar automation under the same capability contract.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => JSON.stringify(await getProductivityAdapter().calendarToday(), null, 2),
    permission: 'user',
    securityLevel: 'safe',
    capability: withProductivityAdapter('calendar.read_today', {
      id: 'calendar.events.today',
      family: 'calendar',
      lane: 'office',
      operation: 'observe',
      risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'default calendar events for today', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'provider', 'items'],
        requiredValues: { ok: true, status: 'observed' },
        successStatuses: ['observed'],
        successSignals: ['the platform calendar provider returned an event collection'],
        limitations: ['The default calendar may not include every external account.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'calendar.events.today', operation: 'observe' }),
  });

  registry.register({
    name: 'upcoming_events',
    description: 'Get upcoming events from the platform calendar provider for up to 30 days.',
    parameters: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Number of days to look ahead, default 7 and maximum 30.' } },
      required: [],
    },
    handler: async args => {
      const days = Math.min(Math.max(Number(args.days) || 7, 1), 30);
      return JSON.stringify(await getProductivityAdapter().upcomingEvents(days), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: withProductivityAdapter('calendar.read_upcoming', {
      id: 'calendar.events.upcoming',
      family: 'calendar',
      lane: 'office',
      operation: 'observe',
      risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'default calendar upcoming events', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'provider', 'items'],
        requiredValues: { ok: true, status: 'observed' },
        successStatuses: ['observed'],
        successSignals: ['the platform calendar provider returned an event collection'],
        limitations: ['Results are bounded to the requested interval and adapter limit.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'calendar.events.upcoming', operation: 'observe', subjectArgument: 'days' }),
  });

  registry.register({
    name: 'send_email',
    description: 'Send a plain-text email through the platform mail provider. Windows uses Outlook and macOS uses Mail.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string', description: 'Email subject line.' },
        body: { type: 'string', description: 'Plain-text email body.' },
      },
      required: ['to', 'subject', 'body'],
    },
    handler: async args => JSON.stringify(await getProductivityAdapter().sendEmail({
      to: String(args.to || ''),
      subject: String(args.subject || ''),
      body: String(args.body || ''),
    }), null, 2),
    permission: 'user',
    securityLevel: 'confirm',
    capability: withProductivityAdapter('mail.send', capabilityContract({
      id: 'mail.message.send',
      family: 'mail',
      lane: 'messaging',
      operation: 'communicate',
      risk: 'high',
      sideEffects: [{ type: 'external_communication', scope: 'explicit email recipient and message', reversible: false }],
      verification: {
        strategy: 'provider_ack',
        required: true,
        requiredFields: ['ok', 'status', 'sent', 'provider', 'recipient'],
        requiredValues: { ok: true, status: 'sent', sent: true },
        successStatuses: ['sent'],
        successSignals: ['the platform mail provider acknowledged sending to the exact recipient'],
        limitations: ['Provider acceptance does not prove human reading or downstream delivery.'],
      },
    })),
    evidence: capabilityEvidence({
      id: 'mail.message.send',
      operation: 'communicate',
      subjectArgument: 'to',
      limitations: ['The receipt proves provider acceptance, not recipient engagement.'],
    }),
  });

  registry.register({
    name: 'recent_emails',
    description: 'List recent messages from the platform inbox without changing read state.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Number of emails to retrieve, default 5 and maximum 20.' } },
      required: [],
    },
    handler: async args => {
      const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
      return JSON.stringify(await getProductivityAdapter().recentEmails(limit), null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: withProductivityAdapter('mail.read_recent', {
      id: 'mail.messages.recent',
      family: 'mail',
      lane: 'messaging',
      operation: 'observe',
      risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'recent default inbox message metadata', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'provider', 'items'],
        requiredValues: { ok: true, status: 'observed' },
        successStatuses: ['observed'],
        successSignals: ['the platform inbox returned a bounded message collection'],
        limitations: ['Only sender, subject, time, and unread state are returned.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'mail.messages.recent', operation: 'observe', subjectArgument: 'limit' }),
  });

  registry.register({
    name: 'calendar_create',
    description: 'Create a real event in the platform default calendar using one cross-platform schema.',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Event title.' },
        start: { type: 'string', description: 'ISO 8601 start time.' },
        end: { type: 'string', description: 'ISO 8601 end time.' },
        location: { type: 'string', description: 'Optional location.' },
        body: { type: 'string', description: 'Optional notes.' },
        reminderMinutes: { type: 'number', description: 'Reminder lead time, default 15 minutes.' },
        allDay: { type: 'boolean', description: 'Whether this is an all-day event.' },
      },
      required: ['subject', 'start', 'end'],
    },
    handler: async args => JSON.stringify(await getProductivityAdapter().createEvent({
      subject: String(args.subject || ''),
      start: String(args.start || ''),
      end: String(args.end || ''),
      location: args.location === undefined ? undefined : String(args.location),
      body: args.body === undefined ? undefined : String(args.body),
      reminderMinutes: Number(args.reminderMinutes ?? 15),
      allDay: args.allDay === true,
    }), null, 2),
    permission: 'user',
    securityLevel: 'confirm',
    capability: withProductivityAdapter('calendar.create', capabilityContract({
      id: 'calendar.event.create',
      family: 'calendar',
      lane: 'office',
      operation: 'create',
      risk: 'high',
      sideEffects: [{ type: 'external_state_change', scope: 'platform default calendar event', reversible: true }],
      verification: {
        strategy: 'provider_ack',
        required: true,
        requiredFields: ['ok', 'status', 'created', 'provider', 'eventId', 'subject'],
        requiredValues: { ok: true, status: 'created', created: true },
        successStatuses: ['created'],
        successSignals: ['the calendar provider returned a stable event id'],
        limitations: ['The adapter writes to the platform default calendar.'],
      },
    })),
    evidence: capabilityEvidence({ id: 'calendar.event.create', operation: 'create', subjectArgument: 'subject' }),
  });

  registry.register({
    name: 'calendar_modify',
    description: 'Modify a real event in the platform default calendar, matched by its current subject.',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Current event subject.' },
        newSubject: { type: 'string', description: 'Optional replacement subject.' },
        newStart: { type: 'string', description: 'Optional ISO 8601 start time.' },
        newEnd: { type: 'string', description: 'Optional ISO 8601 end time.' },
        newLocation: { type: 'string', description: 'Optional replacement location.' },
        newBody: { type: 'string', description: 'Optional replacement notes.' },
      },
      required: ['subject'],
    },
    handler: async args => JSON.stringify(await getProductivityAdapter().modifyEvent({
      subject: String(args.subject || ''),
      newSubject: args.newSubject === undefined ? undefined : String(args.newSubject),
      newStart: args.newStart === undefined ? undefined : String(args.newStart),
      newEnd: args.newEnd === undefined ? undefined : String(args.newEnd),
      newLocation: args.newLocation === undefined ? undefined : String(args.newLocation),
      newBody: args.newBody === undefined ? undefined : String(args.newBody),
    }), null, 2),
    permission: 'user',
    securityLevel: 'confirm',
    capability: withProductivityAdapter('calendar.modify', capabilityContract({
      id: 'calendar.event.modify',
      family: 'calendar',
      lane: 'office',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [{ type: 'external_state_change', scope: 'matched platform calendar event', reversible: true }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['ok', 'status', 'updated', 'provider', 'eventId', 'subject'],
        requiredValues: { ok: true, status: 'updated', updated: true },
        successStatuses: ['updated'],
        successSignals: ['the calendar provider acknowledged the event update and returned its id'],
        limitations: ['Subject matching can be ambiguous when duplicate event subjects exist.'],
      },
    })),
    evidence: capabilityEvidence({ id: 'calendar.event.modify', operation: 'mutate', subjectArgument: 'subject' }),
  });

  registry.register({
    name: 'calendar_delete',
    description: 'Delete a real event from the platform default calendar by subject after explicit confirmation.',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Event subject to match.' },
        confirmDelete: { type: 'boolean', description: 'Must be true after the user confirms deletion.' },
      },
      required: ['subject', 'confirmDelete'],
    },
    handler: async args => {
      if (args.confirmDelete !== true) throw new Error('Calendar deletion requires confirmDelete=true.');
      return JSON.stringify(await getProductivityAdapter().deleteEvent({ subject: String(args.subject || '') }), null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
    capability: withProductivityAdapter('calendar.delete', capabilityContract({
      id: 'calendar.event.delete',
      family: 'calendar',
      lane: 'office',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [{ type: 'external_state_change', scope: 'matched platform calendar event', reversible: false }],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['ok', 'status', 'deleted', 'provider', 'eventId', 'subject'],
        requiredValues: { ok: true, status: 'deleted', deleted: true },
        successStatuses: ['deleted'],
        successSignals: ['the calendar provider acknowledged deletion of the matched event id'],
        limitations: ['Deletion is not automatically recoverable by Lumi.'],
      },
    })),
    evidence: capabilityEvidence({ id: 'calendar.event.delete', operation: 'mutate', subjectArgument: 'subject' }),
  });
}
