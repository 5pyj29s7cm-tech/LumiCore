import { describe, expect, it } from 'vitest';
import {
  hasClientActionOnlyIntent,
  hasExplicitToolIntent,
  isCurrentClientDiagnosticRequest,
  isDiagnosticOrRepairRequest,
  isInformationOnlyQuestion,
  isUserCorrectionOrExplanationQuestion,
  shouldAllowToolUseForTurn,
  traceToolIntentDecision,
} from '../server/cognition/tool_intent';

describe('audio transcription tool intent', () => {
  it('routes an explicit Lumi runtime mutation into the self-repair tool lane', () => {
    const text = '\u91cd\u542f\u540e\u7aef\u8fdb\u7a0b\u3002';
    expect(isInformationOnlyQuestion(text)).toBe(false);
    expect(isDiagnosticOrRepairRequest(text)).toBe(true);
    expect(shouldAllowToolUseForTurn(text, 'voice', 'assistant')).toBe(true);
  });

  it('treats a negated authorization as correction rather than execution', () => {
    const correction = '\u6ca1\u6709\u4eba\u8ba9\u4f60\u6267\u884c\u963f\u9c81\u6587\u4ef6\u5939';
    expect(isUserCorrectionOrExplanationQuestion(correction)).toBe(true);
    expect(hasClientActionOnlyIntent(correction)).toBe(false);
    expect(hasExplicitToolIntent(correction)).toBe(false);
  });

  it('keeps transcript file requests out of pure chat and enables them in assistant mode', () => {
    const text = 'Please transcribe this audio recording and save it as a text file.';
    expect(shouldAllowToolUseForTurn(text, undefined, 'chat')).toBe(false);
    expect(shouldAllowToolUseForTurn(text, undefined, 'assistant')).toBe(true);
  });

  it('distinguishes a WeChat inquiry from a channel correction', () => {
    const inquiry = '你打开微信问一下阿露在干嘛。';
    expect(isUserCorrectionOrExplanationQuestion(inquiry)).toBe(false);
    expect(hasClientActionOnlyIntent(inquiry)).toBe(false);
    expect(shouldAllowToolUseForTurn(inquiry, 'voice', 'autonomous')).toBe(true);

    const correction = '不是，我现在就在桌面客户端上，哪来的微信客户端啊？';
    expect(isUserCorrectionOrExplanationQuestion(correction)).toBe(true);
    expect(hasClientActionOnlyIntent(correction)).toBe(false);
    expect(shouldAllowToolUseForTurn(correction, 'voice', 'autonomous')).toBe(false);
  });

  it('keeps a missing-reply complaint in conversation instead of client self-repair', () => {
    for (const text of [
      '为什么不回我',
      '你怎么没有回答我？',
      '为什么没有回答我刚才的问题？',
      "Why didn't you answer my question?",
    ]) {
      expect(isUserCorrectionOrExplanationQuestion(text), text).toBe(true);
      expect(isInformationOnlyQuestion(text), text).toBe(true);
      expect(isDiagnosticOrRepairRequest(text), text).toBe(false);
      expect(shouldAllowToolUseForTurn(text, 'chat', 'assistant'), text).toBe(false);
      const trace = traceToolIntentDecision(text, 'chat', 'assistant');
      expect(trace.allowToolUse, text).toBe(false);
      expect(trace.signals.diagnosticOrRepair, text).toBe(false);
      expect(trace.blockedBy, text).toContain('information-only-question');
    }
  });

  it('still enables diagnostics for a concrete client failure', () => {
    const text = '为什么客户端打不开了？';
    expect(isUserCorrectionOrExplanationQuestion(text)).toBe(false);
    expect(isDiagnosticOrRepairRequest(text)).toBe(true);
    expect(shouldAllowToolUseForTurn(text, 'chat', 'assistant')).toBe(true);
  });

  it.each([
    '你刚才是不是在做自检？',
    '刚刚是在后台做检查吗？',
  ])('treats a question about a prior check as explanation, not a fresh diagnostic: %s', (text) => {
    expect(isCurrentClientDiagnosticRequest(text)).toBe(false);
    expect(isUserCorrectionOrExplanationQuestion(text)).toBe(true);
    expect(isDiagnosticOrRepairRequest(text)).toBe(false);
  });

  it.each([
    '检查一下你自己有没有问题',
    '检查一下你自己有没有问题，然后给我一份报告',
    '检查一下客户端',
    '你自己检查一下',
    '帮我检查 MCP 状态',
  ])('recognizes a current client self-diagnostic request: %s', (text) => {
    expect(isCurrentClientDiagnosticRequest(text)).toBe(true);
    expect(isDiagnosticOrRepairRequest(text)).toBe(true);
  });

  it.each([
    '检查一下这个文件',
    '检查合同',
    '检查桌面图片',
    '你自己检查一下这份合同',
    '检查你自己的合同有没有问题',
    '检查微信新消息',
    '检查股票',
    '检查日程',
    '这段代码报错了，帮我修复',
    '合同有问题，帮我改一下',
  ])('routes artifact work outside client self-repair: %s', (text) => {
    expect(isCurrentClientDiagnosticRequest(text)).toBe(false);
    expect(isDiagnosticOrRepairRequest(text)).toBe(false);

    const trace = traceToolIntentDecision(text, 'chat', 'assistant');
    expect(trace.signals.diagnosticOrRepair).toBe(false);
    expect(trace.allowToolUse).toBe(true);
    expect(trace.decisionReason).not.toContain('self-inspection');
  });

  it.each([
    'AutoCAD 打不开了',
    '微信没反应',
    'Lumi 客户端有问题',
  ])('keeps client and external-app runtime failures diagnostic: %s', (text) => {
    expect(isDiagnosticOrRepairRequest(text)).toBe(true);
    expect(traceToolIntentDecision(text, 'chat', 'assistant').signals.diagnosticOrRepair).toBe(true);
  });
});
