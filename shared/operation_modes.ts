/**
 * Canonical LumiCore operation-mode taxonomy shared by the desktop and server.
 *
 * Only the three entries in `LUMI_OPERATION_MODE_IDS` are persistent,
 * user-selectable permission postures. Meeting is a temporary capture surface;
 * it may appear in client state while capture is active, but it is not a
 * fourth permission tier.
 */
export const LUMI_OPERATION_MODE_IDS = ['chat', 'assistant', 'autonomous'] as const;

export type LumiOperationMode = (typeof LUMI_OPERATION_MODE_IDS)[number];

export interface LumiOperationModeDefinition {
  id: LumiOperationMode;
  permissionTier: 1 | 2 | 3;
  executionPosture: 'conversation_first' | 'foreground_execution' | 'continuous_execution';
  persistent: true;
  continuous: boolean;
}

export const LUMI_OPERATION_MODE_DEFINITIONS: readonly LumiOperationModeDefinition[] = [
  {
    id: 'chat',
    permissionTier: 1,
    executionPosture: 'conversation_first',
    persistent: true,
    continuous: false,
  },
  {
    id: 'assistant',
    permissionTier: 2,
    executionPosture: 'foreground_execution',
    persistent: true,
    continuous: false,
  },
  {
    id: 'autonomous',
    permissionTier: 3,
    executionPosture: 'continuous_execution',
    persistent: true,
    continuous: true,
  },
] as const;

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
  return LUMI_OPERATION_MODE_IDS.includes(value as LumiOperationMode);
}

export function isLumiClientMode(value: unknown): value is LumiClientMode {
  return isLumiOperationMode(value) || value === LUMI_MEETING_CAPTURE_SURFACE.id;
}

export function normalizeLumiClientMode(value: unknown): LumiClientMode {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (isLumiClientMode(normalized)) return normalized;
  if (normalized === 'music' || normalized === 'desktop_control' || normalized === 'terminal') {
    return 'assistant';
  }
  return 'assistant';
}

export function getLumiOperationModeDefinition(
  value: unknown,
): LumiOperationModeDefinition | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return LUMI_OPERATION_MODE_DEFINITIONS.find(definition => definition.id === normalized) || null;
}
