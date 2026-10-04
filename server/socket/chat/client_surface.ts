import { ToolExecutionRecord } from "../../tools/types";
import { type LumiClientMode, LUMI_CLIENT_MODE_IDS } from "../../../shared/operation_modes";
import { toolRecordSucceeded } from "../../cognition/task_execution_ledger";
import { isGuardGeneratedConversationRecord } from "../../conversation/guard_history";
import { getRecentHistoryText } from "./history";
const SHORT_CLIENT_CONTINUATION_RE =
  /^(?:查|查一下|看|看看|看一下|继续|接着|继续查|接着查|开始|处理|做|整|改|打开|试试|重试|嗯|嗯嗯|好|好的|可以|来|走|为什么|怎么回事|在哪|在哪里|为什么不执行)$/iu;


const CLIENT_SURFACE_CONTEXT_RE =
  /客户端|自己的客户端|中枢世界|中枢|世界视图|云端画布|界面|入口|主屏幕|主页|技能大厅|知识库|运行日志|文件小组件|client_get_state|client_action|\b(?:client|nexus|nexus\s+view|cloud\s+canvas|world\s+view)\b/iu;


const CLIENT_SURFACE_ACTION_RE =
  /打开|进入|切换|查看|看看|检查|查|摸索|操作|入口|界面|状态|没有打开|没打开|为什么|怎么回事|能不能|能打开|\b(?:open|show|enter|switch|inspect|check|operate)\b/iu;


export function isShortClientContinuation(userText: string): boolean {
  const clean = String(userText || '').trim();
  return Boolean(clean) && clean.length <= 24 && SHORT_CLIENT_CONTINUATION_RE.test(clean);
}


export function getVerifiedClientModeChange(records: ToolExecutionRecord[]): LumiClientMode | null {
  const validModes = new Set<string>(LUMI_CLIENT_MODE_IDS);
  for (const record of [...records].reverse()) {
    if (
      record.name !== 'client_action'
      || record.arguments?.action !== 'set_client_mode'
      || !toolRecordSucceeded(record)
    ) continue;
    const mode = String(record.arguments?.mode || '').trim().toLowerCase();
    if (!validModes.has(mode)) continue;
    try {
      const parsed = JSON.parse(String(record.result || '{}'));
      const status = String(parsed?.verification?.status || parsed?.status || '').toLowerCase();
      if (/^(?:verified|not_applicable)$/.test(status) && parsed?.ok !== false) {
        return mode as LumiClientMode;
      }
    } catch {
      // A mode preference is never persisted from an unparseable receipt.
    }
  }
  return null;
}


function hasRecentClientSurfaceContext(history: any[] | undefined): boolean {
  const recent = getRecentHistoryText(
    Array.isArray(history)
      ? history.filter(item => !isGuardGeneratedConversationRecord(item))
      : history,
    5000,
  );
  return CLIENT_SURFACE_CONTEXT_RE.test(recent);
}


function isClientSurfaceRequestText(userText: string): boolean {
  const clean = String(userText || '').trim();
  if (!clean) return false;
  return CLIENT_SURFACE_CONTEXT_RE.test(clean) && CLIENT_SURFACE_ACTION_RE.test(clean);
}


export function buildClientSurfaceContinuationBridge(userText: string, history: any[] | undefined): string {
  const clean = String(userText || '').trim();
  const directClientSurfaceRequest = isClientSurfaceRequestText(clean);
  const shortContinuation = isShortClientContinuation(clean) && hasRecentClientSurfaceContext(history);
  if (!directClientSurfaceRequest && !shortContinuation) return '';

  return [
    '## Internal client-surface continuation context',
    'The user is continuing a Lumi client/UI operation or self-inspection request. Treat this as foreground client work, not deferred automation.',
    'Use client_get_state first unless a fresh client state is already available. For "中枢世界", "中枢", "Nexus", or "cloud canvas", use client_action with action=open_nexus.',
    'Do not claim that a client surface was opened, checked, or changed unless client_action verification is verified/not_applicable or fresh client state proves it. If verification is pending or failed, say the exact blocker and next retry.',
  ].join('\n');
}
