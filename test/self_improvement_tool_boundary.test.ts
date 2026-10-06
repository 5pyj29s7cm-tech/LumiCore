import './helpers';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { registerSelfExtensionTools } from '../server/tools/definitions/self_extension_tools';
const sourceTools = ['self_improvement_program_get', 'self_improvement_program_update', 'self_improvement_propose',
  'self_improvement_list', 'self_improvement_read_scope', 'self_improvement_replay_verified_stage',
  'self_improvement_stage_patch', 'self_improvement_queue', 'self_improvement_activate'];
function tool(name: string) {
  const registry = new ToolRegistry(); registerSelfExtensionTools(registry); return registry.get(name)!;
}
describe('one local source-operation boundary', () => {
  it.each(sourceTools)('rejects nonlocal calls before proposal lookup or argument processing: %s', async name => {
    await expect(tool(name).handler({}, { userId: 'boundary-owner', domain: 'personal', localExecution: false }))
      .rejects.toThrow('authenticated local desktop administrator');
  });
  it.each(sourceTools)('rejects organization calls before source lookup or mutation: %s', async name => {
    await expect(tool(name).handler({}, { userId: 'boundary-owner', domain: 'work', orgId: 'organization', localExecution: true }))
      .rejects.toThrow('local personal administrator workspace');
  });
});
