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

  it('normalizes old postures to one core and preserves meeting capture', () => {
    expect(LUMI_OPERATION_MODE_IDS).toEqual(['assistant']);
    expect(LUMI_CLIENT_MODE_IDS).toEqual(['assistant', 'meeting']);
    expect(LUMI_MEETING_CAPTURE_SURFACE).toMatchObject({
      id: 'meeting',
      kind: 'capture_surface',
      persistent: false,
      allowsTools: false,
    });
    expect(OPERATION_MODE_CONFIGS.chat).toBe(OPERATION_MODE_CONFIGS.assistant);
    expect(OPERATION_MODE_CONFIGS.autonomous).toBe(OPERATION_MODE_CONFIGS.assistant);
    expect(normalizeLumiClientMode('autonomy')).toBe('assistant');
  });

  it('does not advertise selectable modes to the model', () => {
    const snapshot = getSelfModelSnapshot('operation-mode-taxonomy-user');
    expect(snapshot.modes).toEqual([]);

    const adapter = getAdapterRegistry().adapters.find(item => item.id === 'client.modes');
    expect(adapter?.actions).toEqual(['start_meeting_mode', 'end_meeting_mode']);
    expect(adapter?.notes).toContain('not a live client.modes state field');
  });

  it('gives the model an explicit boundary between modes and response presets', () => {
    const prompt = buildOperationModeTaxonomyPrompt();
    expect(prompt).toContain('no user-selectable');
    expect(prompt).toContain('Meeting');
    expect(prompt).toContain('not a permission mode');
    expect(prompt).toContain('personality response presets');
  });
});
