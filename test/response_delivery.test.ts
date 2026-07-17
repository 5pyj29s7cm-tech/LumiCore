import { describe, expect, it } from 'vitest';
import {
  createPreFinalizationTextGate,
  shouldDeferModelOutputUntilFinalized,
  shouldForwardPreFinalizationProgress,
} from '../server/cognition/response_delivery';
import type { LumiTurnFlow } from '../server/cognition/turn_flow';
import { resolveWorkSurfaceRoute } from '../server/cognition/work_surface';

function flow(overrides: Partial<LumiTurnFlow> = {}): LumiTurnFlow {
  return {
    channel: 'voice',
    surface: 'voice',
    operationMode: 'chat',
    effectiveOperationMode: 'chat',
    requestedMode: null,
    autoPromoteToAssistant: false,
    allowToolUseForTurn: false,
    selfRepairTurn: false,
    clientActionOnlyTurn: false,
    visionIntent: false,
    exposeAgentWork: false,
    workSurfaceRoute: resolveWorkSurfaceRoute('\u4f60\u597d'),
    workTakeover: {
      strength: 'none',
      shouldResumeTask: false,
    } as LumiTurnFlow['workTakeover'],
    specialWorkflow: null,
    executionGovernance: {
      verificationIntent: 'none',
      verificationReason: '',
      delegationIntent: 'none',
      delegationReason: '',
      capabilityLearningIntent: 'none',
      capabilityLearningReason: '',
      shouldInspectCapabilitiesFirst: false,
    },
    completionEvidenceNeeded: false,
    routeText: '',
    promptOverlay: '',
    ...overrides,
  };
}

describe('finalized output delivery gate', () => {
  it('keeps ordinary conversation streamable', () => {
    const taskText = '\u4f60\u80fd\u542c\u89c1\u6211\u8bf4\u8bdd\u5417';
    expect(shouldDeferModelOutputUntilFinalized({
      taskText,
      flow: flow({ routeText: taskText }),
    })).toBe(false);
  });

  it('buffers current-app editing until tool evidence is finalized', () => {
    const taskText = '\u5728\u8fd9\u91cc\u9762\u5199\u4e00\u7bc7\u68c0\u8ba8\u4e66\u7ed9\u6211';
    expect(shouldDeferModelOutputUntilFinalized({
      taskText,
      flow: flow({ routeText: taskText }),
    })).toBe(true);
  });

  it('buffers every tool-enabled and self-repair turn even when text classification is weak', () => {
    const taskText = '\u770b\u4e00\u4e0b';
    expect(shouldDeferModelOutputUntilFinalized({
      taskText,
      flow: flow({ routeText: taskText, allowToolUseForTurn: true }),
    })).toBe(true);
    expect(shouldDeferModelOutputUntilFinalized({
      taskText,
      flow: flow({ routeText: taskText, selfRepairTurn: true }),
    })).toBe(true);
    expect(shouldDeferModelOutputUntilFinalized({
      taskText,
      allowToolUse: true,
      flow: flow({ routeText: taskText }),
    })).toBe(true);
  });

  it('buffers special workflows until their tool ledger is finalized', () => {
    const taskText = 'Lumi, introduce yourself';
    expect(shouldDeferModelOutputUntilFinalized({
      taskText,
      flow: flow({
        routeText: taskText,
        specialWorkflow: { id: 'self_intro_demo' } as LumiTurnFlow['specialWorkflow'],
      }),
    })).toBe(true);
  });

  it('buffers an underspecified continuation even before routing succeeds', () => {
    const taskText = '\u7ee7\u7eed\u6267\u884c\u8fd9\u4e2a\u4efb\u52a1';
    expect(shouldDeferModelOutputUntilFinalized({
      taskText,
      flow: flow({ routeText: taskText }),
    })).toBe(true);
  });

  it('allows in-progress updates but blocks terminal progress before finalization', () => {
    expect(shouldForwardPreFinalizationProgress('正在调用 desktop_open')).toBe(true);
    expect(shouldForwardPreFinalizationProgress('Step 2/4: validating the active window')).toBe(true);
    expect(shouldForwardPreFinalizationProgress('Workflow complete')).toBe(false);
    expect(shouldForwardPreFinalizationProgress('已写好文档')).toBe(false);
    expect(shouldForwardPreFinalizationProgress('操作成功')).toBe(false);
    expect(shouldForwardPreFinalizationProgress('\u6587\u4ef6\u5df2\u4fdd\u5b58')).toBe(false);
    expect(shouldForwardPreFinalizationProgress('\u6587\u6863\u5199\u5b8c\u4e86')).toBe(false);
    expect(shouldForwardPreFinalizationProgress('\u4efb\u52a1\u641e\u5b9a\u4e86')).toBe(false);
    expect(shouldForwardPreFinalizationProgress('\u8f6c\u5199\u5b8c\u6210\uff1aqwen\uff0c\u5171 120 \u5b57')).toBe(false);
    expect(shouldForwardPreFinalizationProgress('DashScope \u8f6c\u5199\u5b8c\u6210\uff0c\u6b63\u5728\u4e0b\u8f7d\u8bc6\u522b\u7ed3\u679c')).toBe(false);
    expect(shouldForwardPreFinalizationProgress('\u65b0\u622a\u56fe\u590d\u6838\u5b8c\u6210\uff0c\u6b63\u5728\u751f\u6210\u53ef\u9a8c\u8bc1\u7ed3\u679c')).toBe(false);
  });

  it('buffers a terminal execution claim split across model chunks', () => {
    const gate = createPreFinalizationTextGate();

    expect(gate.push('\u4f60\u597d\uff0c\u6211\u5728\u3002')).toBe('\u4f60\u597d\uff0c\u6211\u5728\u3002');
    expect(gate.push('\u6211\u5df2\u7ecf')).toBe('');
    expect(gate.push('\u6253\u5f00\u5fae\u4fe1\u4e86\u3002\u8fd8\u6709\u4ec0\u4e48\u9700\u8981\uff1f')).toBe('');

    const snapshot = gate.finish();
    expect(snapshot.emittedText).toBe('\u4f60\u597d\uff0c\u6211\u5728\u3002');
    expect(snapshot.withheld).toBe(true);
    expect(snapshot.withheldText).toContain('\u6211\u5df2\u7ecf\u6253\u5f00\u5fae\u4fe1\u4e86\u3002');
    expect(snapshot.withheldText).toContain('\u8fd8\u6709\u4ec0\u4e48\u9700\u8981\uff1f');
  });

  it('keeps safe complete sentences streamable and withholds an incomplete tail', () => {
    const gate = createPreFinalizationTextGate();

    expect(gate.push('Hello there. How are')).toBe('Hello there.');
    const snapshot = gate.finish();
    expect(snapshot.emittedText).toBe('Hello there.');
    expect(snapshot.withheldText).toBe(' How are');
  });
});
