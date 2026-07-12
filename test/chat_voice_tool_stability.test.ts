import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildForegroundWeChatReadArgs, buildForegroundWeChatSendArgs, shouldChainTask } from '../server/agents/nl_chainer';

describe('chat and voice tool-call stability', () => {
  it('keeps text and voice on the shared routing and desktop execution path', () => {
    const root = process.cwd();
    const chat = readFileSync(path.join(root, 'server/socket/chat.ts'), 'utf8');
    const voice = readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');
    const task = readFileSync(path.join(root, 'server/socket/task.ts'), 'utf8');

    for (const source of [chat, voice, task]) {
      expect(source).toContain('buildLumiTurnDispatch');
      expect(source).toContain('buildLumiExecutionDecision');
      expect(source).toContain('buildLumiCapabilitySelection');
      expect(source).toContain('buildDesktopExecutionStabilityPolicy');
      expect(source).toContain('actuationTools: desktopExecutionPolicy.actuationTools');
      expect(source).toContain('toolPolicy');
      expect(source).toContain('requestConfirmation');
      expect(source).toContain('supervisedExternalCommits');
    }
  });

  it('keeps legal entry prompts in the shared execution decision instead of per-channel scripts', () => {
    const executionDecision = readFileSync(path.join(process.cwd(), 'server/cognition/execution_decision.ts'), 'utf8');
    const legalEntry = readFileSync(path.join(process.cwd(), 'server/cognition/legal_entry.ts'), 'utf8');

    expect(executionDecision).toContain('buildUnifiedLegalEntryPrompt');
    expect(legalEntry).toContain('Unified Legal Casework Entry');
    expect(legalEntry).toContain('Execution order');
    expect(legalEntry).toContain('major premise -> minor premise -> conclusion/subsumption');
    expect(legalEntry).toContain('Current-law gate');
    expect(legalEntry).toContain('External legal platforms');
    expect(legalEntry).toContain('authorized-collaboration surfaces');
    expect(legalEntry).toContain('Remote bot intake must resolve the organization/case binding first');
    expect(legalEntry).toContain('archive into the organization case workspace and organization knowledge base');
    expect(legalEntry).toContain('personal chat, company/work chat, voice, task center');
  });

  it('keeps REST chat on the same legal entry and finalizer path', () => {
    const restChat = readFileSync(path.join(process.cwd(), 'server/routes/chat_routes.ts'), 'utf8');

    expect(restChat).toContain('buildUnifiedLegalEntryPrompt');
    expect(restChat).toContain('buildRestChatSystemInstruction');
    expect(restChat).toContain('buildRestProviderMessages');
    expect(restChat).toContain('buildRestAnthropicMessages');
    expect(restChat).toContain('finalizeRestChatResponse');
    expect(restChat).toContain('finalizeLumiResponse');
    expect(restChat).toContain("source: 'rest_chat'");
    expect(restChat).toContain('blocked: finalized.blocked');
  });

  it('archives legal meeting analysis through the legal casework toolchain', () => {
    const restChat = readFileSync(path.join(process.cwd(), 'server/routes/chat_routes.ts'), 'utf8');

    expect(restChat).toContain('buildLegalMeetingMinutesArgs');
    expect(restChat).toContain('shouldArchiveLegalMeeting');
    expect(restChat).toContain("return isLegalMeeting && domain === 'work' && Boolean(orgId)");
    expect(restChat).toContain('const orgId = requestScope.orgId');
    expect(restChat).toContain("toolRegistry.execute('legal_meeting_minutes_to_case'");
    expect(restChat).toContain('shouldArchiveLegalMeeting(purpose, legalCase, domain, orgId)');
    expect(restChat).toContain("source: 'meeting-analyze'");
    expect(restChat).toContain('legalCasework');
    expect(restChat).toContain('legalCaseArchived');
  });

  it('keeps personal direct legal tools out of the shared default organization scope', () => {
    const restChat = readFileSync(path.join(process.cwd(), 'server/routes/chat_routes.ts'), 'utf8');

    expect(restChat).toContain('function resolveLegalCaseworkOrgId');
    expect(restChat).toContain("return `personal:${safeLegalScopeSegment(input.userId)}`");
    expect(restChat).toContain('const requestScope = req.user ? resolveDomain(req.user)');
    expect(restChat).toContain('const legalOrgId = resolveLegalCaseworkOrgId({ domain, userOrgId: orgId, userId })');
    expect(restChat).toContain('...rawArgs,');
    expect(restChat).toContain('orgId: legalOrgId,');
    expect(restChat).toContain("source: 'legal-direct-tool'");
    expect(restChat).toContain("source: 'legal-contract-review'");
  });

  it('binds legal meeting analysis to the current case and organization scope in the desktop client', () => {
    const desktop = readFileSync(path.join(process.cwd(), 'src/components/DesktopUI.tsx'), 'utf8');

    expect(desktop).toContain('const legalCaseId = legalCase?.id || getLegalConsultationCaseId()');
    expect(desktop).toContain("const workLegalScope = workDomain === 'work' && Boolean(orgConnection?.connected && orgConnection?.orgId)");
    expect(desktop).toContain('id: legalCaseId');
    expect(desktop).toContain("domain: workLegalScope ? 'work' : 'personal'");
    expect(desktop).toContain('orgId: workLegalScope ? orgConnection?.orgId : undefined');
    expect(desktop).toContain('if (data.legalCaseArchived && workLegalScope && legalCaseId && notesForAnalysis.length > 0)');
    expect(desktop).toContain('lastLegalMeetingArchiveRef.current = archiveKey');
    expect(desktop).toContain('setLegalConsultationCaseId(String(detail.legalCaseId))');
  });

  it('keeps voice tool execution visible and aligned with chat permission behavior', () => {
    const voice = readFileSync(path.join(process.cwd(), 'server/socket/voice.ts'), 'utf8');

    expect(voice).toContain('shouldAllowVoiceLocalFileWriteForTurn');
    expect(voice).toContain('allowLocalFileWrites');
    expect(voice).toContain('localWriteIntentReason');
    expect(voice).toContain('emitToolLifecycle');
    expect(voice).toContain('socket.emit("agent:tool"');
    expect(voice).toContain('onProgress');
  });

  it('keeps personal and organization knowledge retrieval aligned across text and voice', () => {
    const root = process.cwd();
    const chat = readFileSync(path.join(root, 'server/socket/chat.ts'), 'utf8');
    const voice = readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');
    const messaging = readFileSync(path.join(root, 'server/messaging/routes.ts'), 'utf8');

    for (const source of [chat, voice]) {
      expect(source).toContain('retrieveChunks');
      expect(source).toContain('searchKnowledgeBase');
      expect(source).toContain('ragKnowledge');
      expect(source).toContain('## Company Knowledge Base');
      expect(source).toContain("domain === 'work'");
    }
    expect(voice).toContain('voiceScope.orgId');
    expect(voice).toContain('cite article titles');
    expect(messaging).toContain('searchOrgKnowledge(msg.boundOrgId');
    expect(messaging).toContain('OrgKB.createArticle(msg.boundOrgId!');
    expect(messaging).toContain('getMember(binding.orgId, binding.lumiUserId)');
  });

  it('keeps ordinary tools silent and records hard boundaries for one-time text confirmation', () => {
    const root = process.cwd();
    const chat = readFileSync(path.join(root, 'server/socket/chat.ts'), 'utf8');
    const voice = readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');
    const task = readFileSync(path.join(root, 'server/socket/task.ts'), 'utf8');

    for (const source of [chat, voice, task]) {
      expect(source).toContain('canAutoApproveAction(toolName, args,');
      expect(source).toContain('recordPendingConfirmation');
      expect(source).not.toContain("socket.emit('agent:confirm_tool'");
      expect(source).not.toContain('socket.emit("agent:confirm_tool"');
    }
  });

  it('routes short foreground WeChat send follow-ups into the task chain', () => {
    expect(shouldChainTask('\u76f4\u63a5\u53d1\u665a\u5b89')).toBe(true);
    expect(shouldChainTask('\u5fae\u4fe1\u5e2e\u6211\u7f16\u8f91\u4e00\u6761\u665a\u5b89\u53d1\u7ed9\u963f\u9646')).toBe(true);
  });

  it('keeps foreground WeChat sends on the dedicated chat fast path', () => {
    const args = buildForegroundWeChatSendArgs('\u6253\u5f00\u5fae\u4fe1\u7ed9\u963f\u9646\u53d1\u665a\u5b89');
    expect(args).toMatchObject({
      contact: '\u963f\u9646',
      applicationTarget: 'wechat',
      useVirtualCursor: true,
    });
    expect(String(args?.message || '')).toContain('\u665a\u5b89');

    const chat = readFileSync(path.join(process.cwd(), 'server/socket/chat.ts'), 'utf8');
    expect(chat).toContain('buildForegroundWeChatSendArgs');
    expect(chat).toContain("const toolName = 'wechat_send_message'");
    expect(chat).toContain('buildRecentFailureExplanation');
    expect(chat).toContain('recent_failure_explanation');
  });

  it('extracts foreground message recipients and content without hard-coded samples', () => {
    expect(buildForegroundWeChatSendArgs('\u5fae\u4fe1\u7ed9\u5f20\u4e09\u53d1\u4e0b\u5348\u4e09\u70b9\u5f00\u4f1a')).toMatchObject({
      contact: '\u5f20\u4e09',
      message: '\u4e0b\u5348\u4e09\u70b9\u5f00\u4f1a',
      applicationTarget: 'wechat',
      useVirtualCursor: true,
    });

    expect(buildForegroundWeChatSendArgs('\u53d1\u7ed9\u674e\u56db\u300c\u6211\u5230\u4e86\u300d')).toMatchObject({
      contact: '\u674e\u56db',
      message: '\u6211\u5230\u4e86',
    });

    expect(buildForegroundWeChatSendArgs('\u76f4\u63a5\u53d1\u660e\u5929\u89c1')).toMatchObject({
      contact: '',
      message: '\u660e\u5929\u89c1',
    });
  });

  it('extracts foreground WeChat chat reading as a generic contact task', () => {
    expect(buildForegroundWeChatReadArgs('\u6253\u5f00\u5fae\u4fe1\u770b\u770b\u6211\u548c\u963f\u9646\u6700\u8fd1\u7684\u804a\u5929\u5185\u5bb9')).toMatchObject({
      contact: '\u963f\u9646',
      applicationTarget: 'wechat',
      useSearch: true,
      maxMessages: 8,
    });

    const chat = readFileSync(path.join(process.cwd(), 'server/socket/chat.ts'), 'utf8');
    expect(chat).toContain('buildForegroundWeChatReadArgs');
    expect(chat).toContain("const toolName = 'wechat_read_recent_chat'");
  });
});
