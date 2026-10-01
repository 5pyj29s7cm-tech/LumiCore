import { Socket } from "socket.io";
import { ToolExecutionRecord } from "../../../../tools/types";
import { buildSelfIntroductionPlan, getSelfModelSnapshot } from '../../../../client/self_model';
import { DESKTOP_APPLICATION_REGISTRY } from '../../../../desktop/execution_plan';

type VoiceScope = {
  domain: 'personal' | 'work';
  orgId: string;
};

type DesktopRelay = (toolName: string, args: Record<string, any>) => Promise<string>;
type Speak = (text: string) => void | number | Promise<void | number>;

interface SelfIntroDemoOptions {
  socket: Socket;
  userText: string;
  userId: string;
  desktopRelay: DesktopRelay;
  speak: Speak;
  voiceScope: VoiceScope;
  isCancelled?: () => boolean;
}

const SELF_INTRO_PATTERNS = [
  /自我介绍/,
  /介绍(?:一下|下)?(?:你自己|自己|lumi|Lumi)/,
  /介绍(?:一下|下)?你(?:的能力|能做什么|会做什么)/,
  /(?:你|lumi|Lumi).{0,8}介绍.{0,8}(?:自己|一下)/,
  /(?:你|lumi|Lumi).{0,12}(?:能做什么|会做什么|有哪些能力|能力演示)/,
  /(?:展示|演示)(?:一下)?(?:你自己|自己|lumi|Lumi)/,
  /(?:展示|演示)(?:一下|下)?(?:你|lumi|Lumi).{0,12}(?:能力|桌面|操作|自己)/,
  /(?:让|叫|请)(?:你|lumi|Lumi).{0,8}(?:自我介绍|介绍自己|演示自己)/,
  /(?:给|向)(?:新用户|用户|大家).{0,12}(?:介绍|演示)(?:一下|下)?(?:你|lumi|Lumi|自己)/,
  /(?:开始|播放|启动).{0,8}(?:自我介绍|能力演示|介绍视频)/,
  /(?:你|lumi|Lumi).{0,8}是谁/,
  /introduce\s*(yourself|lumi)/i,
  /show\s*(yourself|lumi)/i,
  /demo\s*(yourself|lumi)/i,
];

function normalizeIntentText(text: string): string {
  return text.replace(/\s+/g, '');
}

export function isSelfIntroDemoRequest(text: string): boolean {
  const normalized = normalizeIntentText(text || '');
  if (!normalized) return false;
  const selfIntroduction = SELF_INTRO_PATTERNS.some(pattern => pattern.test(normalized))
    || /(?:自我介绍|介绍(?:一下)?你自己|你是谁|(?:introduce|demo|show).{0,40}(?:yourself|lumi))/iu.test(normalized); // i18n-allow: Chinese self-introduction input recognition.
  const visibleDemo = /(?:演示|展示|桌面操作|实际操作|边介绍边操作|(?:demo|show).{0,40}(?:yourself|lumi))/iu.test(normalized); // i18n-allow: Chinese visible-demo input recognition.
  return selfIntroduction && visibleDemo;
}

export async function runSelfIntroDemo(options: SelfIntroDemoOptions): Promise<{
  responseText: string;
  toolCalls: ToolExecutionRecord[];
  speechSummary: string;
}> {
  const { userId, userText, voiceScope, desktopRelay, isCancelled } = options;
  const snapshot = getSelfModelSnapshot(userId, voiceScope);
  const introPlan = buildSelfIntroductionPlan(userId, voiceScope, {
    visibleDemo: true,
    requestText: userText,
  });
  const toolCalls: ToolExecutionRecord[] = [];
  const run = async (name: string, args: Record<string, any>): Promise<string> => {
    const id = `self-intro-dynamic-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    if (isCancelled?.()) {
      toolCalls.push({ id, name, arguments: args, result: '', error: 'cancelled_before_execution' });
      return '';
    }
    try {
      const result = String(await desktopRelay(name, args) || '');
      toolCalls.push({ id, name, arguments: args, result });
      return result;
    } catch (error: any) {
      toolCalls.push({
        id,
        name,
        arguments: args,
        result: '',
        error: String(error?.message || error || 'workflow_adapter_failed'),
      });
      return '';
    }
  };

  // The presentation sequence is compiled from the current snapshot. These
  // are client-native adapters, not hard-coded pixel coordinates or business
  // decisions. Missing/stale capabilities simply do not enter the plan.
  const clientActions: Array<Record<string, any>> = [];
  if (snapshot.runtime.awareness !== 'missing') {
    clientActions.push({ action: 'refresh_client_state' });
  }
  if (snapshot.configuredModels.some(model => model.configured)) {
    clientActions.push({ action: 'open_settings', section: 'ai-providers' });
  }
  if (snapshot.knowledgeCoverage.totalFiles > 0) {
    clientActions.push({ action: 'show_knowledge_base' });
  }
  clientActions.push({ action: 'open_chat' });

  for (const action of clientActions) {
    await run('client_action', action);
  }

  // External applications are considered only when the request named one.
  // Installed-app and foreground-window evidence are mandatory preflight and
  // postflight gates; an unavailable app is reported instead of substituted.
  const requestedExternal = introPlan.demoCandidates
    .filter(candidate => candidate.enabled && candidate.applicationId !== 'lumi-client');
  for (const candidate of requestedExternal) {
    const application = DESKTOP_APPLICATION_REGISTRY
      .find(item => item.id === candidate.applicationId);
    if (!application) continue;
    const installed = await run('desktop_list_apps', {});
    const identityTerms = [application.displayName, application.id, ...application.aliases]
      .map(value => value.toLowerCase());
    if (!identityTerms.some(term => installed.toLowerCase().includes(term))) continue;
    await run('desktop_open', { target: application.displayName });
    await run('desktop_active_window', {});
  }

  const succeeded = toolCalls.filter(call => !call.error && call.result).length;
  const failed = toolCalls.filter(call => Boolean(call.error)).length;
  const facts = introPlan.statements.map(statement => statement.text).join('');
  const executionSummary = failed > 0
    ? `Visible demo produced ${succeeded} verified adapter result(s) and ${failed} failure(s); failed actions were stopped.`
    : `Visible demo produced ${succeeded} adapter result(s) from the live capability plan.`;
  return {
    responseText: `${facts}\n\n${executionSummary}`,
    speechSummary: `${introPlan.statements.slice(0, 3).map(statement => statement.text).join('')} ${executionSummary}`,
    toolCalls,
  };
}
