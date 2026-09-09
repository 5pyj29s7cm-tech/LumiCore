/** Single Lumi core; meeting is a temporary capture surface, never a permission tier. */
export const LUMI_OPERATION_MODE_IDS = ['assistant'] as const;

// Legacy wire values remain accepted by older clients; they never select permissions.
export type LumiOperationMode = 'chat' | 'assistant' | 'autonomous';

export const LUMI_MEETING_CAPTURE_SURFACE = {
  id: 'meeting',
  kind: 'capture_surface',
  persistent: false,
  answersUtterances: false,
  allowsTools: false,
} as const;

export type LumiMeetingCaptureSurface = typeof LUMI_MEETING_CAPTURE_SURFACE.id;
export type LumiClientMode = LumiOperationMode | LumiMeetingCaptureSurface;

export const LUMI_CLIENT_MODE_IDS = [
  ...LUMI_OPERATION_MODE_IDS,
  LUMI_MEETING_CAPTURE_SURFACE.id,
] as const;

export function isLumiOperationMode(value: unknown): value is LumiOperationMode {
  return value === 'assistant';
}

export function isLumiClientMode(value: unknown): value is LumiClientMode {
  return isLumiOperationMode(value) || value === LUMI_MEETING_CAPTURE_SURFACE.id;
}

export function normalizeLumiClientMode(value: unknown): LumiClientMode {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'meeting' ? 'meeting' : 'assistant';
}
