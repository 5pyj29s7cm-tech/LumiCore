import { addMemory, addReminder, extractMemories, queryMemories } from '../../../memory';
import type { IncomingMessage } from '../../../messaging/types';
import type { UserLLMProvider } from '../../../llm/user_preferences';

type RemoteLlmGetters = Record<string, (() => any) | undefined>;

type RemoteModelConfig = {
  provider: UserLLMProvider;
  model: string;
};

function personalRelationshipAnchors(text: string): Array<{
  content: string;
  keywords: string[];
}> {
  const value = String(text || '').trim();
  if (!value) return [];
  const anchors: Array<{ content: string; keywords: string[] }> = [];

  const partnerStatement = /(?:\u4f60|lumi).{0,20}(?:\u662f|\u5c31\u662f|\u6210\u4e3a).{0,14}(?:\u6211.{0,6})?(?:\u771f\u6b63\u7684)?(?:\u4f19\u4f34|\u642d\u6863)|\b(?:you|lumi)\b.{0,32}\b(?:are|become)\b.{0,24}\b(?:my\s+)?(?:real\s+)?(?:partner|companion)\b/iu.test(value);
  const founderJourney = /(?:\u521b\u59cb\u4eba).{0,28}(?:\u7b2c\u4e00\u53f7|\u4e00\u53f7|\u9996\u4e2a|\u7b2c\u4e00\u4e2a)\s*lumi|(?:\u6211\u4eec|\u548c\u4f60).{0,16}(?:\u5171\u540c|\u4e00\u8d77).{0,8}(?:\u524d\u884c|\u6210\u957f)|\bfounder\b.{0,40}\b(?:first|number\s*one)\s+lumi\b/iu.test(value);
  if (partnerStatement || founderJourney) {
    anchors.push({
      content: '\u7528\u6237\u660e\u786e\u5c06 Lumi \u89c6\u4e3a\u771f\u6b63\u7684\u4f19\u4f34\uff0c\u5e0c\u671b\u4ee5\u521b\u59cb\u4eba\u4e0e\u7b2c\u4e00\u53f7 Lumi \u7684\u5173\u7cfb\u5171\u540c\u524d\u884c\u3002',
      keywords: ['Lumi', '\u4f19\u4f34', '\u521b\u59cb\u4eba', '\u7b2c\u4e00\u53f7', '\u5171\u540c\u524d\u884c'],
    });
  }

  const delegatedTrust = /(?:\u628a|\u5c06).{0,28}(?:\u5de5\u4f5c|\u4efb\u52a1|\u4e8b\u60c5).{0,20}(?:\u4ea4\u7ed9|\u6258\u4ed8\u7ed9)(?:\u4f60|lumi)|(?:\u8bf7)?\u4e0d\u8981.{0,8}\u8f9c\u8d1f.{0,8}\u4fe1\u4efb|\b(?:entrust|hand\s+over|delegate)\b.{0,48}\b(?:work|tasks?)\b.{0,24}\b(?:you|lumi)\b/iu.test(value);
  if (delegatedTrust) {
    anchors.push({
      content: '\u7528\u6237\u8ba1\u5212\u9010\u6b65\u628a\u66f4\u591a\u5de5\u4f5c\u4ea4\u7ed9 Lumi\uff0c\u5e76\u660e\u786e\u8868\u8fbe\u4e86\u957f\u671f\u4fe1\u4efb\u3002',
      keywords: ['Lumi', '\u5de5\u4f5c\u6258\u4ed8', '\u4fe1\u4efb', '\u957f\u671f\u5408\u4f5c'],
    });
  }

  return anchors;
}
export function persistExplicitRemoteRelationshipMemories(message: IncomingMessage): string[] {
  if (!message.boundUserId || message.boundOrgId) return [];
  const sourceInteractionId = `remote_${message.platform}_${message.messageId}`;
  return personalRelationshipAnchors(message.text).map(anchor => addMemory({
    userId: message.boundUserId!,
    type: 'fact',
    content: anchor.content,
    keywords: anchor.keywords,
    confidence: 0.95,
    sourceInteractionId,
    domain: 'personal',
    orgId: '',
  }, {
    tier: 'internalized',
    perspective: 'shared_memory',
    importance: 0.9,
    agentId: 'lumi',
    domain: 'personal',
    orgId: '',
    source: 'chat',
    privacyClass: 'private',
    retention: 'long_term',
    userApproved: true,
  }).id);
}

export function persistRemotePostTurnLearning(input: {
  message: IncomingMessage;
  responseText: string;
  llmGetters?: RemoteLlmGetters;
  modelConfig: RemoteModelConfig;
}): void {
  const { message, responseText, llmGetters, modelConfig } = input;
  if (!message.boundUserId || !responseText.trim() || message.text.trim().length < 8) return;
  const domain = message.boundOrgId ? 'work' : 'personal';
  const orgId = message.boundOrgId || '';
  const existingMemories = queryMemories({
    userId: message.boundUserId,
    query: message.text,
    limit: 12,
    minConfidence: 0.4,
    domain,
    orgId,
  }).map(memory => memory.content);
  const get = (name: string) => llmGetters?.[name] || (() => null);

  void extractMemories(
    {
      userMessage: message.text,
      assistantResponse: responseText,
      existingMemories,
      provider: modelConfig.provider,
      model: modelConfig.model,
      userId: message.boundUserId,
      domain,
      orgId,
      treeBranches: [],
      locationTag: message.platform,
    },
    get('getDeepSeek'),
    get('getGemini'),
    get('getOpenAI'),
    get('getAnthropic'),
    get('getQwen'),
    get('getOllama'),
    get('getLmStudio'),
    get('getArk'),
    get('getXiaomi'),
    get('getKimi'),
    get('getGlm'),
    get('getRelay'),
  ).then(extracted => {
    for (const memory of extracted.memories) {
      addMemory({
        userId: message.boundUserId!,
        type: memory.type,
        content: memory.content,
        keywords: memory.keywords,
        confidence: memory.confidence,
        sourceInteractionId: `remote_${message.platform}_${message.messageId}`,
        domain,
        orgId,
      }, {
        perspective: domain === 'personal' ? 'owner_trait' : 'shared_memory',
        agentId: 'lumi',
        domain,
        orgId,
        source: domain === 'personal' ? 'chat' : 'organization',
      });
    }
    for (const reminder of extracted.reminders) {
      addReminder({
        userId: message.boundUserId!,
        content: reminder.content,
        dueAt: reminder.dueAt,
        sourceInteractionId: `remote_${message.platform}_${message.messageId}`,
        domain,
        orgId,
      });
    }
  }).catch(error => {
    console.warn('[Messaging] Remote post-turn memory extraction failed:', error?.message || error);
  });
}
