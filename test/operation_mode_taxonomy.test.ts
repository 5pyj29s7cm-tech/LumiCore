import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  LUMI_CLIENT_MODE_IDS,
  LUMI_MEETING_CAPTURE_SURFACE,
  LUMI_OPERATION_MODE_IDS,
  normalizeLumiClientMode,
} from '../shared/operation_modes';
import {
  OPERATION_MODE_CONFIGS,
  buildOperationModeTaxonomyPrompt,
} from '../server/cognition/operation_modes';
import { getAdapterRegistry } from '../server/adapters/registry';
import { getSelfModelSnapshot } from '../server/client/self_model';

describe('canonical LumiCore operation-mode taxonomy', () => {
  beforeAll(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  it('keeps exactly three persistent permission modes and a separate meeting surface', () => {
    expect(LUMI_OPERATION_MODE_IDS).toEqual(['chat', 'assistant', 'autonomous']);
    expect(LUMI_CLIENT_MODE_IDS).toEqual(['chat', 'assistant', 'autonomous', 'meeting']);
    expect(LUMI_MEETING_CAPTURE_SURFACE).toMatchObject({
      id: 'meeting',
      kind: 'capture_surface',
      persistent: false,
      allowsTools: false,
    });
    expect(Object.keys(OPERATION_MODE_CONFIGS)).toEqual(LUMI_CLIENT_MODE_IDS);
    expect(normalizeLumiClientMode('autonomy')).toBe('assistant');
  });

  it('projects the same three modes into the self-model and client adapter', () => {
    const snapshot = getSelfModelSnapshot('operation-mode-taxonomy-user');
    expect(snapshot.modes.map(mode => mode.id)).toEqual(LUMI_OPERATION_MODE_IDS);

    const adapter = getAdapterRegistry().adapters.find(item => item.id === 'client.modes');
    expect(adapter?.actions).toEqual([
      'set_client_mode(chat)',
      'set_client_mode(assistant)',
      'set_client_mode(autonomous)',
      'start_meeting_mode',
    ]);
    expect(adapter?.notes).toContain('not a live client.modes state field');
  });

  it('gives the model an explicit boundary between modes and response presets', () => {
    const prompt = buildOperationModeTaxonomyPrompt();
    expect(prompt).toContain('exactly 3 persistent');
    expect(prompt).toContain('meeting');
    expect(prompt).toContain('not a fourth permission mode');
    expect(prompt).toContain('personality response presets');
  });
});
