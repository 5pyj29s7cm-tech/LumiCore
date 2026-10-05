import './helpers';
import { beforeAll } from 'vitest';
import { initDatabase } from '../db_layer';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import type { LumiTurnChannel } from '../server/cognition/turn_flow';
import type { ToolPolicy } from '../server/personality/types';
import { ToolRegistry } from '../server/tools/registry';
import { registerAllTools } from '../server/tools/definitions';

beforeAll(async () => { await initDatabase(); });

export function foregroundPipeline(text: string, channel: LumiTurnChannel = 'voice', personalityToolPolicy?: ToolPolicy) {
  const registry = new ToolRegistry();
  registerAllTools(registry);
  return buildLumiExecutionPipeline({
    dispatch: { userId: 'foreground-convergence-fixture', text, channel, source: channel,
      operationMode: 'assistant', targetIsLumi: true },
    registry, personalityToolPolicy,
  });
}
