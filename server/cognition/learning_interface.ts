import { addMemory } from '../memory/store';
import {
  upsertCapabilityLearningRecord,
  type CapabilityLearningRecord,
  type CapabilityLearningStatus,
  type CapabilityRoute,
} from '../self_extension/capability_memory';
import type { ToolExecutionRecord } from '../tools/types';
import type { LumiTurnFlow } from './turn_flow';

export type LumiLearningChannel = 'chat' | 'voice' | 'task' | 'workflow';

export interface LumiLearningTurnInput {
  userId: string;
  userText: string;
  assistantText?: string;
  channel: LumiLearningChannel;
  flow?: LumiTurnFlow;
  toolNames?: string[];
  toolRecords?: ToolExecutionRecord[];
  domain?: string;
  orgId?: string;
  sourceInteractionId?: string;
  agentId?: string;
}

export interface LumiLearningTurnPlan {
  shouldPersist: boolean;
  reasons: string[];
  memoryCandidates: Array<{
    type: 'preference' | 'fact' | 'habit' | 'knowledge';
    content: string;
    keywords: string[];
    confidence: number;
  }>;
  capabilityCandidate: {
    goal: string;
    status: CapabilityLearningStatus;
    route: CapabilityRoute;
    observedFailure?: string;
  } | null;
}

export interface LumiLearningTurnResult extends LumiLearningTurnPlan {
  storedMemories: number;
  capabilityRecord?: CapabilityLearningRecord;
}

const LUMI_CONTEXT_RE = /lumi|露米|你|人格|核心|身体|客户端|桌面|自治|自然|顺畅|语音|文字|模型|大模型|学习|记忆|沉淀|能力|技能|工具|任务中心|接口|换模型|遗忘/i;
const DURABLE_RULE_RE = /以后|每次|一直|长期|必须|一定|不要|别|不能|希望|记住|沉淀|学会|做实|稳定|顺畅|自然|换.*模型|模型.*遗忘|学习接口/u;
const MODEL_INTERFACE_RE = /大模型|模型|llm|kimi|deepseek|qwen|openai|推理接口|理解接口|学习接口|换模型|遗忘/i;
const NATURAL_AUTONOMY_RE = /自然|顺畅|自治|内部自洽|语言逻辑|分派|不希望.*脚本|不像.*脚本|自然流转/u;
const BODY_SELF_RE = /身体|客户端|桌面|屏幕|窗口|语音|文字|工具|外部软件|看见|认识自己/u;
const FAILURE_RE = /失败|不稳定|卡死|卡住|不顺手|很烂|打不开|没成功|忘|遗忘|乱|冲突|不通|不同步|掉了/u;

function compact(value: unknown, limit = 500): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(item => item.trim()).filter(Boolean)));
}

function hasTool(toolNames: string[], name: string): boolean {
  return toolNames.includes(name);
}

function capabilityDomainForRoute(route: CapabilityRoute): string {
  if (route.id.startsWith('lumi.')) return 'lumi_core';
  return route.id.split('.')[0] || 'general';
}

function routeForLearningGoal(text: string, toolNames: string[]): CapabilityRoute {
  const preferredTools = [
    'capability_learning_list',
    'self_extension_plan',
    'adapter_registry_list',
    'client_get_state',
    'client_health_check',
    'work_takeover_capability_reuse_probe',
    'work_takeover_task_verify_result',
    'capability_gap_autofix',
  ].filter(name => hasTool(toolNames, name));

  if (MODEL_INTERFACE_RE.test(text)) {
    return {
      id: 'lumi.model_independent_learning_interface',
      label: '模型无关的 Lumi 学习接口路线',
      interfacePattern: 'core',
      preferredTools,
      fallbackTools: ['capability_gap_autofix'].filter(name => hasTool(toolNames, name)),
      avoid: ['不要把大模型当作长期记忆本体', '不要让单次对话覆盖人格核心', '不要把换模型当作换了一个 Lumi'],
      reason: '大模型只是本轮理解和推理接口；稳定人格、身体、记忆、任务和能力路线必须沉淀在 LumiOS 本地层。',
      confirmationRequired: ['修改人格核心、安装/修复技能、连接第三方服务、执行外部自动化前需要确认'],
    };
  }

  if (NATURAL_AUTONOMY_RE.test(text)) {
    return {
      id: 'lumi.natural_autonomy_flow',
      label: 'Lumi 自然自治和跨入口一致路线',
      interfacePattern: 'core',
      preferredTools,
      fallbackTools: ['self_extension_plan', 'capability_gap_autofix'].filter(name => hasTool(toolNames, name)),
      avoid: ['不要把固定演示脚本写进主程序', '不要让文字和语音走两套人格逻辑', '不要用工具日志代替自然汇报'],
      reason: 'Lumi 的聊天、语音、任务分派、技能和外部系统调用应像同一个自然助理在流转。',
      confirmationRequired: ['修改核心行为、安装技能、执行外部软件或自动发布/发送前需要确认'],
    };
  }

  if (BODY_SELF_RE.test(text)) {
    return {
      id: 'lumi.client_body_self_model',
      label: 'Lumi 客户端身体和桌面感知路线',
      interfacePattern: 'core',
      preferredTools,
      fallbackTools: ['client_get_state', 'desktop_ui_snapshot'].filter(name => hasTool(toolNames, name)),
      avoid: ['不要把语音、文字、任务面板当成三个不同人格', '不要声称看见或操作了没有验证过的界面'],
      reason: 'Lumi 需要稳定认识自己的客户端身体、桌面状态、工具和外部软件控制边界。',
      confirmationRequired: ['桌面控制、外部软件自动化、消息发送和系统改动前需要确认'],
    };
  }

  return {
    id: 'lumi.general_learning_route',
    label: 'Lumi 通用学习接口路线',
    interfacePattern: 'core',
    preferredTools,
    fallbackTools: ['self_extension_plan', 'capability_gap_autofix'].filter(name => hasTool(toolNames, name)),
    avoid: ['不要把一次性聊天当作永久能力', '不要未经确认修改核心代码或安装第三方能力'],
    reason: '通用学习信号应先沉淀为本地记忆和可复用能力路线，再通过验证变成稳定技能。',
    confirmationRequired: ['修改核心行为、安装技能、执行外部软件或自动发布/发送前需要确认'],
  };
}

function goalForText(text: string): string {
  if (MODEL_INTERFACE_RE.test(text)) return '模型无关的 Lumi 学习接口和人格身体稳定沉淀';
  if (BODY_SELF_RE.test(text)) return 'Lumi 客户端身体认知和跨入口一致性';
  if (NATURAL_AUTONOMY_RE.test(text)) return 'Lumi 自然自治、语言逻辑和任务分派顺畅性';
  return compact(text, 160) || 'Lumi 能力沉淀';
}

function memoryCandidatesFor(text: string): LumiLearningTurnPlan['memoryCandidates'] {
  const candidates: LumiLearningTurnPlan['memoryCandidates'] = [];
  if (MODEL_INTERFACE_RE.test(text)) {
    candidates.push({
      type: 'knowledge',
      content: '用户要求 Lumi 将大模型视为可替换的理解和推理接口；稳定人格、身体、记忆、任务和能力路线必须沉淀在 LumiOS 本地系统中，不能因为换模型而遗忘。',
      keywords: ['Lumi', '大模型', '学习接口', '换模型', '人格核心', '能力沉淀'],
      confidence: 0.88,
    });
  }
  if (NATURAL_AUTONOMY_RE.test(text)) {
    candidates.push({
      type: 'preference',
      content: '用户要求 Lumi 的文字、语音、任务分派、技能调用和外部操作保持自然顺畅，不要像固定脚本或工具日志。',
      keywords: ['Lumi', '自然', '顺畅', '文字语音统一', '任务分派', '脚本感'],
      confidence: 0.86,
    });
  }
  if (BODY_SELF_RE.test(text)) {
    candidates.push({
      type: 'knowledge',
      content: '用户强调 Lumi 必须稳定认识自己的客户端身体、桌面、屏幕、窗口、工具、外部软件和确认边界。',
      keywords: ['Lumi', '身体认知', '客户端', '桌面', '工具', '确认边界'],
      confidence: 0.84,
    });
  }
  return candidates;
}

function statusFor(input: LumiLearningTurnInput): CapabilityLearningStatus {
  if (input.flow?.executionGovernance.capabilityLearningIntent === 'learn_missing') return 'needs_core_work';
  if (FAILURE_RE.test(input.userText)) return 'needs_core_work';
  return 'hypothesis';
}

export function planLumiLearningTurn(input: LumiLearningTurnInput): LumiLearningTurnPlan {
  const text = compact(input.userText, 1000);
  const reasons: string[] = [];
  const aboutLumi = LUMI_CONTEXT_RE.test(text);
  const durableRule = DURABLE_RULE_RE.test(text);
  const capabilityIntent = input.flow?.executionGovernance.capabilityLearningIntent || 'none';
  const shouldCaptureCapability = capabilityIntent !== 'none' || (aboutLumi && durableRule && /(能力|沉淀|学会|学习|模型|接口|身体|自治|自然|顺畅|稳定|记忆)/u.test(text));
  const memories = aboutLumi && durableRule ? memoryCandidatesFor(text) : [];

  if (memories.length) reasons.push('durable_lumi_instruction');
  if (shouldCaptureCapability) reasons.push(`capability_${capabilityIntent}`);

  const toolNames = input.toolNames || [];
  const capabilityCandidate = shouldCaptureCapability
    ? {
        goal: goalForText(text),
        status: statusFor(input),
        route: routeForLearningGoal(text, toolNames),
        observedFailure: FAILURE_RE.test(text) ? text.slice(0, 300) : undefined,
      }
    : null;

  return {
    shouldPersist: memories.length > 0 || Boolean(capabilityCandidate),
    reasons,
    memoryCandidates: memories,
    capabilityCandidate,
  };
}

export function persistLumiLearningTurn(input: LumiLearningTurnInput): LumiLearningTurnResult {
  const plan = planLumiLearningTurn(input);
  let storedMemories = 0;
  let capabilityRecord: CapabilityLearningRecord | undefined;

  for (const candidate of plan.memoryCandidates) {
    try {
      addMemory({
        userId: input.userId,
        type: candidate.type,
        content: candidate.content,
        keywords: candidate.keywords,
        confidence: candidate.confidence,
        sourceInteractionId: input.sourceInteractionId || '',
        agentId: input.agentId || '',
      } as any, {
        domain: input.domain,
        orgId: input.orgId,
        source: input.channel === 'voice' ? 'voice' : input.channel === 'chat' ? 'chat' : 'system',
        tier: 'internalized',
        perspective: 'lumi_self',
        importance: 0.82,
      });
      storedMemories++;
    } catch (err: any) {
      console.warn('[LumiLearningInterface] memory persistence skipped:', err?.message || err);
    }
  }

  if (plan.capabilityCandidate) {
    const candidate = plan.capabilityCandidate;
    try {
      capabilityRecord = upsertCapabilityLearningRecord({
        userId: input.userId,
        scopeDomain: input.domain === 'work' && input.orgId ? 'work' : 'personal',
        orgId: input.domain === 'work' ? String(input.orgId || '') : '',
        domain: capabilityDomainForRoute(candidate.route),
        goal: candidate.goal,
        context: compact(`${input.channel}: ${input.userText}`, 500),
        observedFailure: candidate.observedFailure,
        status: candidate.status,
        selectedRoute: candidate.route,
        planReadiness: candidate.status === 'needs_core_work' ? 'needs_core_work' : 'candidate_needs_experiment',
        existingTools: unique([...(input.toolNames || []), ...candidate.route.preferredTools]).slice(0, 40),
        nextUse: {
          triggerHints: unique([candidate.goal, '人格核心', '学习接口', '换模型不遗忘', '自然自治', '身体认知']).slice(0, 10),
          preferredTools: candidate.route.preferredTools,
          firstStep: candidate.route.preferredTools[0] || 'self_extension_plan',
          reportRule: '先复用 LumiOS 本地人格、记忆、任务、技能和能力路线；只汇报已验证结果、阻塞和下一步确认。',
        },
        experiment: {
          status: 'prepared',
          summary: 'Learning signal captured from a user turn. No external experiment was executed automatically.',
          toolCalls: (input.toolRecords || []).slice(-8).map(record => ({
            name: record.name,
            args: record.arguments || {},
            status: record.error ? 'error' : 'success',
            result: record.result?.slice(0, 300),
            error: record.error,
          })),
          artifacts: [],
          verification: [
            {
              label: '候选记录持久化',
              passed: false,
              detail: '候选已记录，但数据库写入不构成能力验证；必须经过真实实验和终态回执后才能晋级为可复用能力。',
            },
          ],
        },
        safety: unique([
          ...candidate.route.confirmationRequired,
          ...candidate.route.avoid,
          '大模型输出不是永久记忆；长期学习必须写入 LumiOS 本地层。',
        ]),
      });
    } catch (err: any) {
      console.warn('[LumiLearningInterface] capability persistence skipped:', err?.message || err);
    }
  }

  return {
    ...plan,
    storedMemories,
    capabilityRecord,
  };
}
