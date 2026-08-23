import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeAgentResponseDelivery,
  isActionSuccessClaim,
  isFinalizedSuccessfulResponse,
  isTerminalAgentStatus,
  shouldDisplayAgentResponse,
  shouldSpeakAgentResponse,
} from '../src/lib/agentResponseDelivery';
import {
  describeToolProgress,
  describeTurnCompletionProgress,
} from '../src/lib/chatProgress';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('frontend agent response finalization gate', () => {
  it('detects concrete success claims without confusing failure wording for success', () => {
    expect(isActionSuccessClaim('\u5df2\u65b0\u5efa\u5e76\u5199\u597d\u6587\u6863\u3002')).toBe(true);
    expect(isActionSuccessClaim('Opened AutoCAD successfully.')).toBe(true);
    expect(isActionSuccessClaim('\u8fd8\u6ca1\u6709\u6253\u5f00 AutoCAD\u3002')).toBe(false);
    expect(isActionSuccessClaim('\u521a\u624d\u6ca1\u6709\u6253\u5f00\uff0c\u73b0\u5728\u5df2\u6253\u5f00 AutoCAD\u3002')).toBe(true);
    expect(isActionSuccessClaim("I couldn't save the file.")).toBe(false);
    expect(isActionSuccessClaim('The document describes a completed project.')).toBe(false);
  });

  it('withholds unfinalized action claims but always delivers terminal receipts', () => {
    const unverified = { text: '\u5df2\u6253\u5f00 WPS\u3002', finalized: false, blocked: false };
    const verified = { ...unverified, finalized: true };
    const blocked = { ...verified, blocked: true };

    expect(shouldDisplayAgentResponse(unverified)).toBe(false);
    expect(shouldSpeakAgentResponse(unverified)).toBe(false);
    expect(shouldDisplayAgentResponse(verified)).toBe(true);
    expect(shouldSpeakAgentResponse(verified)).toBe(true);
    expect(shouldDisplayAgentResponse(blocked)).toBe(true);
    expect(shouldSpeakAgentResponse(blocked)).toBe(false);
    expect(isFinalizedSuccessfulResponse(verified)).toBe(true);
    expect(isFinalizedSuccessfulResponse(blocked)).toBe(false);
  });

  it('does not hide a blocker merely because it reports the successful prefix of a partial operation', () => {
    const partialFailure = {
      text: '\u6587\u4ef6\u5df2\u7ecf\u5199\u5165\uff0c\u4f46\u6ca1\u6709\u53d6\u5f97\u540c\u4e00\u8def\u5f84\u7684\u6210\u529f\u56de\u8bfb\u56de\u6267\uff0c\u4e0d\u80fd\u62a5\u544a\u5b8c\u6210\u3002',
      finalized: true,
      blocked: true,
      reason: 'Requested post-write readback is missing or failed.',
    };
    expect(isActionSuccessClaim(partialFailure.text)).toBe(true);
    expect(shouldDisplayAgentResponse(partialFailure)).toBe(true);
    expect(shouldSpeakAgentResponse(partialFailure)).toBe(false);
  });

  it('keeps confirmation boundaries visible even when transport finalization is absent', () => {
    expect(shouldDisplayAgentResponse({
      text: '\u5df2\u51c6\u5907\u5199\u5165\uff0c\u9700\u8981\u4f60\u786e\u8ba4\u540e\u624d\u80fd\u7ee7\u7eed\u3002',
      finalized: false,
      status: 'waiting_confirmation',
    })).toBe(true);
  });

  it('turns backend reason codes into actionable copy and never renders guard diagnostics', () => {
    expect(describeAgentResponseDelivery({
      text: 'No successful current-turn tool execution was recorded for that execution-status claim.',
      finalized: true,
      blocked: true,
      reason: 'execution_recovery_incomplete',
    }, true)).toContain('\u5df2\u4fdd\u7559');
    expect(describeAgentResponseDelivery({
      text: '\u9700\u8981\u786e\u8ba4\u540e\u624d\u80fd\u7ee7\u7eed\u3002',
      reason: 'waiting_confirmation',
    }, true)).toContain('\u786e\u8ba4\u540e');
    expect(describeAgentResponseDelivery({
      text: 'blocked',
      reason: 'execution_capability_unavailable',
    }, false)).toContain('Settings');
  });

  it('uses retained-state language instead of exposing the missing-tool guard in progress', () => {
    const blocked = describeTurnCompletionProgress(true, false, true, {
      finalized: true,
      blocked: true,
      reason: 'execution_recovery_incomplete',
    });
    expect(blocked.text).toContain('\u4e0a\u4e0b\u6587');
    expect(blocked.text).not.toContain('\u672a\u68c0\u6d4b\u5230\u5b9e\u9645\u5de5\u5177\u6267\u884c');
  });

  it('allows ordinary text and finalized blocker explanations without marking them successful', () => {
    expect(shouldDisplayAgentResponse({ text: '\u4f60\u597d\uff0c\u6211\u5728\u3002' })).toBe(true);
    expect(shouldSpeakAgentResponse({ text: '\u4f60\u597d\uff0c\u6211\u5728\u3002' })).toBe(true);
    expect(shouldDisplayAgentResponse({
      text: '\u8fd9\u6b21\u6ca1\u6709\u5b8c\u6210\uff0c\u7f3a\u5c11\u53ef\u9a8c\u8bc1\u7684\u6267\u884c\u8bc1\u636e\u3002',
      finalized: true,
      blocked: true,
    })).toBe(true);
    expect(shouldSpeakAgentResponse({
      text: '\u8fd9\u6b21\u6ca1\u6709\u5b8c\u6210\u3002',
      finalized: true,
      blocked: true,
    })).toBe(false);
  });

  it('treats idle as terminal transport state, not semantic success', () => {
    expect(isTerminalAgentStatus('idle')).toBe(true);
    expect(isTerminalAgentStatus('cancelled')).toBe(true);
    expect(isTerminalAgentStatus('blocked')).toBe(true);
    expect(isTerminalAgentStatus('thinking')).toBe(false);

    expect(describeTurnCompletionProgress(false, false, false).tone).not.toBe('done');
    expect(describeTurnCompletionProgress(false, false, false, {
      finalized: true,
      blocked: false,
    }).tone).toBe('done');
  });

  it('describes a tool result as pending overall verification', () => {
    const progress = describeToolProgress('desktop_open', 'result', false);
    expect(progress).toContain('still verifying');
    expect(progress).not.toMatch(/\b(?:done|completed|success)\b/i);
  });
});

describe('frontend dynamic output path audit', () => {
  it('gates every non-desktop agent response consumer in scope', () => {
    const displayGated = [
      'src/components/AgentChatPage.tsx',
      'src/components/ChatPanel.tsx',
      'src/components/UnifiedAgent.tsx',
      'src/components/Sanctuary.tsx',
      'src/components/org/CentralLumiChat.tsx',
      'src/components/ProactiveNotifications.tsx',
      'src/hooks/useVoiceCall.ts',
    ];
    for (const relativePath of displayGated) {
      expect(read(relativePath), relativePath).toContain('shouldDisplayAgentResponse');
    }

    expect(read('src/components/HolographicOverlay.tsx')).toContain('isUnverifiedActionClaim');
  });

  it('keeps proactive display and browser-to-server speech requests behind the same gate', () => {
    const source = read('src/components/ProactiveNotifications.tsx');
    expect(source).toContain('shouldDisplayAgentResponse');
    expect(source).toContain('shouldSpeakAgentResponse');
    expect(source).toContain('if (!shouldDisplayAgentResponse(delivery)) return');
  });

  it('does not keep a browser system-voice fallback in chat surfaces', () => {
    for (const relativePath of [
      'src/components/UnifiedAgent.tsx',
    ]) {
      const source = read(relativePath);
      expect(source, relativePath).not.toContain('useTTS');
      expect(source, relativePath).not.toContain('shouldSpeakAgentResponse');
      expect(source, relativePath).not.toMatch(/speechSynthesis|SpeechSynthesisUtterance/);
    }
    expect(fs.existsSync(path.join(root, 'src/hooks/useTTS.ts'))).toBe(false);
  });

  it('does not turn transport idle into a completed workflow', () => {
    const agentChat = read('src/components/AgentChatPage.tsx');
    const idleStart = agentChat.indexOf("} else if (data.status === 'idle') {");
    const idleEnd = agentChat.indexOf("} else if (isTerminalAgentStatus(data.status)) {", idleStart);
    const idleBranch = agentChat.slice(idleStart, idleEnd);
    expect(idleBranch).toContain("setWorkflowStatus('idle')");
    expect(idleBranch).not.toContain("setWorkflowStatus('done')");
    expect(idleBranch).not.toContain('workflowResponseReady');

    const chatPanel = read('src/components/ChatPanel.tsx');
    const panelIdleStart = chatPanel.indexOf("if (data.status === 'idle') {");
    const panelIdleEnd = chatPanel.indexOf('finishChatProgress(', panelIdleStart);
    const panelIdleBranch = chatPanel.slice(panelIdleStart, panelIdleEnd);
    expect(panelIdleBranch).toContain('clearChatProgress()');
    expect(panelIdleBranch).not.toContain('describeTurnCompletionProgress');
  });
});
