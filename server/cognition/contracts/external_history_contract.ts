import { requiresExternalAiHistory } from "../action_request";
import type { LumiActionContract } from './contracts';
import { withDefaults } from './contracts';

export function buildExternalHistoryActionContract(text: string): LumiActionContract | null {


  if (requiresExternalAiHistory(text)) {
    // i18n-allow: Multilingual external-AI authorization intent recognition; not user-visible copy.
    const wantsAuthorization = /(?:授权|注册|添加|连接).{0,28}(?:来源|历史|会话)|\b(?:authorize|register|add|connect)\b.{0,32}\b(?:source|history|session)\b/iu.test(text);
    // i18n-allow: Multilingual external-AI revocation intent recognition; not user-visible copy.
    const wantsRevocation = /(?:撤销|取消|禁用).{0,28}(?:授权|来源)|\b(?:revoke|disable|remove)\b.{0,32}\b(?:authorization|source)\b/iu.test(text);
    // i18n-allow: Multilingual external-AI sync status intent recognition; not user-visible copy.
    const wantsStatus = /(?:状态|进度|同步到哪)|\b(?:status|progress)\b/iu.test(text);
    // i18n-allow: Multilingual external-AI history query intent recognition; not user-visible copy.
    const wantsQuery = /(?:读取|查看|搜索|查询|总结).{0,32}(?:聊天|对话|历史|内容)|\b(?:read|view|search|query|summari[sz]e)\b/iu.test(text);
    const preferredTools = wantsRevocation
      ? ['external_ai_history_source_revoke', 'external_ai_history_status']
      : wantsAuthorization
        ? ['external_ai_history_source_register', 'external_ai_history_source_list']
        : wantsStatus
          ? ['external_ai_history_status', 'external_ai_history_source_list']
          : wantsQuery
            ? ['external_ai_history_query', 'external_ai_history_status', 'external_ai_history_sync', 'external_ai_history_source_list']
            : ['external_ai_history_sync', 'external_ai_history_status', 'external_ai_history_source_list'];
    return withDefaults({
      kind: 'external_ai_history',
      label: 'Authorized external AI history access',
      coreAction: 'Read, synchronize, or manage only the external AI history source and scope explicitly authorized by this user in the current personal or organization domain.',
      preparationIsNotCompletion: ['opening an AI app', 'seeing a conversation list without message evidence', 'using an unregistered session', 'reading only a process/window title', 'treating one visible viewport as complete history'],
      requiredEvidence: [
        wantsAuthorization
          ? 'external_ai_history_source_register receipt with an immutable authorizationDigest'
          : wantsRevocation
            ? 'external_ai_history_source_revoke receipt with status=revoked'
            : wantsStatus
              ? 'external_ai_history_status receipt derived from the persistent source and job ledger'
              : wantsQuery
                ? 'external_ai_history_query receipt with message ids and sourceEvidence'
                : 'external_ai_history_sync receipt with verified=true, a durable jobId/cursor, counts, completeness, and source limitations',
      ],
      preferredTools,
      verificationTools: ['external_ai_history_status', 'external_ai_history_query'],
      nextStep: 'Use an existing exact authorization source. If none exists, explain the missing source and request confirmation to register a connector, JSON export, authorized session, or desktop-visible source. Never submit a new prompt while fulfilling a history-read request.',
      caution: 'Do not claim arbitrary account access. Credentials remain outside this ledger; scope expansion requires a new confirmation; desktop-visible extraction is partial, uses local vision first, and never scrolls or submits.',
    });
  }
  return null;
}
