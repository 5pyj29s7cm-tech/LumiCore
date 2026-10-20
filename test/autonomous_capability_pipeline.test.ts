import { beforeAll, describe, expect, it, vi } from 'vitest';
import { executeToolCall } from '../server/tools/execution_engine';
import { buildCapabilityExecutionPlan } from '../server/cognition/capability_execution_plan';
async function observeCall(pipeline: ReturnType<typeof buildLumiExecutionPipeline>, name:string,args:Record<string,unknown>,autonomous=false){const original=registry.get(name)!;const handler=vi.fn(async()=>JSON.stringify({ok:true,status:'completed',items:[]}));registry.register({...original,handler});const record=await executeToolCall({registry,name,arguments:args,context:{userId:'autonomous-plan-user',taskId:pipeline.taskId,requestId:pipeline.resolution.requestId,autonomous,userConfirmed:true,actionIntent:pipeline.resolution.userText,toolPolicy:pipeline.authorizationPolicy}});const plan=buildCapabilityExecutionPlan({record,capability:registry.getCapabilityManifestEntry(name)!,taskId:pipeline.taskId!});return{record,plan,handler};}
import { buildAutonomousToolPolicy } from '../server/autonomy/task_executor';
import { autonomousTurnPlanningData } from '../server/autonomy/executor/tool_policy';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';

let registry: ToolRegistry;

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
  registry = new ToolRegistry();
  registerAllTools(registry);
});

describe('autonomous capability planning entrance', () => {
  it('routes scheduled work through the same durable capability protocol', async () => {
    const pipeline = buildLumiExecutionPipeline(autonomousTurnPlanningData({
      id: 'autotask-scheduled-1',
      userId: 'autonomous-plan-user',
      title: 'Inspect installed applications',
      description: '检查本机已经安装的桌面应用并生成只读清单。',
      source: 'scheduler',
    }, 30, registry));

    expect(pipeline.turnIntent.channel).toBe('scheduler');
    expect(pipeline.turnIntent.boundary).toBe('task_center');
    expect(pipeline.taskId).toBe('autotask-scheduled-1');
    expect(pipeline.executionPlan).toBeUndefined();
    const name=pipeline.modelToolProjection.toolNames.find(name=>registry.getCapabilityManifestEntry(name)?.operation==='observe')!;
    expect(name).toBeTruthy();
    const observed=await observeCall(pipeline,name,{});
    expect(observed.plan).toMatchObject({taskId:'autotask-scheduled-1',decisionAuthority:'registry_bound_call',scriptAuthority:'adapter_only'});
    expect(observed.plan.nodes).toHaveLength(1);
    expect(observed.plan.nodes[0].toolName).toBe(name);
  });

  it('fails autonomous external commits closed before any tool can execute', async () => {
    const pipeline = buildLumiExecutionPipeline(autonomousTurnPlanningData({
      id: 'autotask-external-1',
      userId: 'autonomous-plan-user',
      title: 'Send a message',
      description: 'send to Alice: deployment is complete',
      source: 'user_request',
    }, 30, registry));

    expect(pipeline.turnIntent.channel).toBe('autonomy');
    const observed=await observeCall(pipeline,'wechat_send_message',{contact:'Alice',message:'deployment is complete'},true);
    expect(observed.handler).not.toHaveBeenCalled();
    expect(observed.record.error).toMatch(/Autonomous external commit blocked/);
    expect(observed.record.envelope?.taskId).toBe('autotask-external-1');
    expect(observed.plan.risk).toMatchObject({
      sideEffectClass: 'external_commit',
      requiresConfirmation: true,
      failClosed: true,
    });
    expect(observed.record.envelope?.status).toBe('waiting_confirmation');
  });

  it.each(['registry_bound_call', undefined])('never turns observed calls into an authority ceiling (%s)', decisionAuthority=>{const policy=buildAutonomousToolPolicy({title:'Resume read task',description:'Read the same target',executionPlan:{decisionAuthority,nodes:[{toolName:'url_fetch'}]} as any,recovery:{planRevisions:[{revision:1,strategy:'retry_same_plan'}]} as any},30);expect(policy.allowedTools).toContain('*');});
  it('keeps a recovery attempt inside the capabilities persisted by its prior plan', () => {
    const policy = buildAutonomousToolPolicy({
      title: 'Resume a read task',
      description: 'Read the same target after a provider timeout',
      executionPlan: {
        decisionAuthority: 'semantic_planner',
        nodes: [
          { toolName: 'url_fetch' },
          { toolName: 'web_search' },
          { toolName: undefined },
        ],
      } as any,
      recovery: {
        planRevisions: [{ revision: 1, strategy: 'retry_same_plan' }],
      } as any,
    }, 30);
    expect(policy.allowedTools).toEqual(['url_fetch', 'web_search']);
    expect(policy.allowedTools).not.toContain('*');
  });
});
