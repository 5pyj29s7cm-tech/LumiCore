export interface CalendarCreateInput {
  subject: string;
  start: string;
  end: string;
  location?: string;
  body?: string;
  reminderMinutes?: number;
  allDay?: boolean;
}

export interface CalendarModifyInput {
  subject: string;
  newSubject?: string;
  newStart?: string;
  newEnd?: string;
  newLocation?: string;
  newBody?: string;
}

export interface ProductivityAdapter {
  readonly id: string;
  readonly platform: 'windows' | 'macos';
  calendarToday(): Promise<Record<string, unknown>>;
  upcomingEvents(days: number): Promise<Record<string, unknown>>;
  sendEmail(input: { to: string; subject: string; body: string }): Promise<Record<string, unknown>>;
  recentEmails(limit: number): Promise<Record<string, unknown>>;
  createEvent(input: CalendarCreateInput): Promise<Record<string, unknown>>;
  modifyEvent(input: CalendarModifyInput): Promise<Record<string, unknown>>;
  deleteEvent(input: { subject: string }): Promise<Record<string, unknown>>;
}
