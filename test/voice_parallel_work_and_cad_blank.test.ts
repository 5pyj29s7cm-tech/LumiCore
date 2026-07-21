import { describe, expect, it } from 'vitest';
import {
  buildActionContract,
  hasCoreActionEvidence,
  requestsBlankAutoCadDocument,
} from '../server/cognition/action_contract';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { routeToolsForTurn } from '../server/cognition/tool_router';
import { hasExplicitToolIntent } from '../server/cognition/tool_intent';
import { buildAutocadNewDocumentScript } from '../server/skills/bundled/cad-drafting/autocad_control';
import { classifyVoiceWorkInterruption } from '../server/socket/voice_turn_state';

function declaration(name: string, description = name) {
  return {
    type: 'function' as const,
    function: {
      name,
      description,
      parameters: { type: 'object', properties: {} },
    },
  };
}

describe('voice work queue and blank AutoCAD document regression', () => {
  it('separates a new actionable request from progress and side chat while work is active', () => {
    const browserRequest = '打开浏览器，并把浏览器放到主显示屏。';
    expect(hasExplicitToolIntent(browserRequest)).toBe(true);
    expect(classifyVoiceWorkInterruption(browserRequest, {
      hasExplicitToolIntent: hasExplicitToolIntent(browserRequest),
    })).toBe('new_work');
    expect(classifyVoiceWorkInterruption('你有在执行这个任务吗？', {
      hasExplicitToolIntent: true,
    })).toBe('progress_query');
    expect(classifyVoiceWorkInterruption('你觉得这张图怎么样？', {
      hasExplicitToolIntent: false,
    })).toBe('side_chat');
  });

  it('routes a blank CAD canvas to document creation without geometry synthesis', () => {
    const text = '在新 CAD 里新建一个空白画布。';
    expect(requestsBlankAutoCadDocument(text)).toBe(true);
    const contract = buildActionContract(text);
    expect(contract.kind).toBe('cad_document');
    expect(contract.preferredTools).toEqual(['mcp_cad-drafting_autocad_new_document']);

    const route = routeToolsForTurn(text, [
      declaration('mcp_cad-drafting_autocad_new_document'),
      declaration('cad_prepare_autocad_operations'),
      declaration('mcp_cad-drafting_autocad_playback_file'),
      declaration('floorplan_extract_geometry'),
      declaration('cad_generate_dxf'),
    ]);
    expect(route.toolNames).toEqual(['mcp_cad-drafting_autocad_new_document']);
  });

  it('does not downgrade a source drawing request into blank-document creation', () => {
    expect(requestsBlankAutoCadDocument('读取桌面的草稿图，在 AutoCAD 里新建画布并照着绘制。')).toBe(false);
  });

  it('creates a real AutoCAD document through COM without drawing placeholder entities', () => {
    const script = buildAutocadNewDocumentScript();
    expect(script).toContain('$acad.Documents.Add()');
    expect(script).toContain('documentCreated = $true');
    expect(script).toContain('entityCount = [int]$model.Count');
    expect(script).not.toContain('$model.AddLine');
  });

  it('accepts and summarizes only a verified empty-document receipt', () => {
    const text = '在新 CAD 里新建一个空白画布。';
    const record = {
      name: 'mcp_cad-drafting_autocad_new_document',
      arguments: {},
      result: JSON.stringify({
        status: 'completed',
        transport: 'mcp_autocad_com',
        documentCreated: true,
        visible: true,
        document: 'Drawing3.dwg',
        entityCount: 0,
      }),
    };
    expect(hasCoreActionEvidence(buildActionContract(text), [record], text)).toBe(true);
    const finalized = finalizeLumiResponse({
      taskText: text,
      responseText: '已经新建完成。',
      toolRecords: [record],
      source: 'voice',
    });
    expect(finalized.blocked).toBe(false);
    expect(finalized.text).toContain('Drawing3.dwg');
    expect(finalized.text).toContain('实体数 0');
    expect(finalized.text).not.toContain('原图');
  });

  it('does not label manually specified CAD playback as source-image verification', () => {
    const finalized = finalizeLumiResponse({
      taskText: '在 AutoCAD 里画一个 1000 x 800 的矩形。',
      responseText: '绘图完成。',
      toolRecords: [{
        name: 'mcp_cad-drafting_autocad_playback_file',
        arguments: {},
        result: JSON.stringify({
          status: 'completed',
          transport: 'mcp_autocad_com',
          visiblePlayback: true,
          completionMarkerExists: true,
          geometryVerified: true,
          geometryVerificationRequired: false,
          geometryReceiptPath: '',
          entityCountMatches: true,
          operationCount: 4,
          expectedEntityCount: 4,
          entitiesAdded: 4,
          operationSetId: 'manual-rectangle',
        }),
      }],
      source: 'voice',
    });
    expect(finalized.blocked).toBe(false);
    expect(finalized.text).not.toContain('原图几何复核');
  });
});
