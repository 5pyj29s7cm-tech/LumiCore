import '../test/helpers';
import {it,expect} from 'vitest';
import {ToolRegistry} from '../server/tools/registry';
import {registerAllTools} from '../server/tools/definitions';
import {buildLumiExecutionPipeline} from '../server/cognition/execution_pipeline';
import {routeToolsForTurn} from '../server/cognition/tool_router';
import {initDatabase} from '../db_layer';
it('preserves the registered original-task recovery reader',async()=>{await initDatabase();const registry=new ToolRegistry();registerAllTools(registry);const text="请使用 get_video_generation_status，参数 JSON 为 {\"recoveryId\":\"existing-provider-job\"}，把这一个工具返回的结果完整发回本次聊天。只取回原有结果；本次禁止生成视频、禁止生成音乐，也不改变任何工程。";const pipeline=buildLumiExecutionPipeline({dispatch:{userId:'synthetic-status-reader',text,channel:'chat',source:'ai-creation',operationMode:'assistant',targetIsLumi:true,domain:'personal'},registry,executionBoundary:'trusted_local'});expect(pipeline.modelToolProjection.toolNames).toContain('get_video_generation_status');expect(pipeline.modelToolProjection.toolNames).not.toContain('generate_video');});

it('retains production and opening with actual registered capability metadata',async()=>{const registry=new ToolRegistry();registerAllTools(registry);const text='生成 D:/reports/meeting.docx，并在 WPS 打开文件检查内容。';const pipeline=buildLumiExecutionPipeline({dispatch:{userId:'synthetic-document-handoff',text,channel:'chat',source:'command-center-chat',operationMode:'assistant',targetIsLumi:true,domain:'personal'},registry,executionBoundary:'trusted_local'});expect(pipeline.modelToolProjection.toolNames).toContain('create_docx');const route=routeToolsForTurn(text,registry.getToolDeclarations(),{capabilityManifest:registry.getCapabilityManifest()});expect(route.toolNames).toContain('desktop_open');});
