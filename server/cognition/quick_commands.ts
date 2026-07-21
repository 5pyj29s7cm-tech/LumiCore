/**
 * Quick Command Fast-Path — deterministic pattern-match tree.
 *
 * Catches common commands before they reach the LLM, returning millisecond responses.
 * Used by both chat.ts and voice.ts to bypass full LLM orchestration.
 */

import { readDB } from '../../db_layer';
import { getWorkTakeoverContinuationQuickCommand, type WorkTakeoverTurnSurface } from '../work_takeover/continuity';
import { listWorkflows } from '../agents/workflows';
import {
  CN_VOICE_FAST_PATH_MESSAGES,
  CN_VOICE_QUICK_WORK_MESSAGES,
} from '../regions/packs/cn/voice_fast_path_messages';
import type { ToolPolicy } from '../personality/types';
import { listWebLoginSitePresets } from '../web_login/legal_presets';
import { formatKnownLoginOpening, formatKnownLoginResult } from '../i18n/naturalness_messages';
import { classifyRuntimeWorkIntent } from './runtime_work_intent';
import {
  extractCurrentAppTarget,
  isRunningSoftwareInspectionRequest,
  requestedDesktopWindowAction,
} from './action_contract';

export interface QuickCommandResult {
  /** The response text to send back to the user */
  responseText: string;
  /** Optional tool call to execute alongside the response */
  toolCall?: { name: string; arguments: Record<string, any> };
  /** Optional formatter for commands whose reply depends on the tool result */
  formatToolResult?: (raw: string, error?: string) => string;
  /** Whether this input was matched as a quick command */
  matched: boolean;
}

interface QuickPattern {
  patterns: RegExp[];
  handler: (match: RegExpMatchArray, userId: string, options?: QuickCommandOptions) => QuickCommandResult | Promise<QuickCommandResult>;
}

export interface QuickCommandOptions {
  domain?: string;
  orgId?: string;
  surface?: WorkTakeoverTurnSurface;
  currentAppTarget?: string;
}

function resolveKnownSiteUrl(target: string): string | null {
  const clean = String(target || '').trim();
  // i18n-allow: Chinese site-name recognition patterns; not user-visible copy.
  const knownSites: Array<[RegExp, string]> = [
    [/(?:中国)?裁判文书网/u, 'https://wenshu.court.gov.cn/'], // i18n-allow: site-name input recognition
    [/人民法院案例库/u, 'https://rmfyalk.court.gov.cn/'], // i18n-allow: site-name input recognition
    [/人民法院在线服务/u, 'https://zxfw.court.gov.cn/'], // i18n-allow: site-name input recognition
  ];
  const known = knownSites.find(([pattern]) => pattern.test(clean));
  return known?.[1] || null;
}

function quickOpenToolCall(target: string): { name: string; arguments: Record<string, any> } {
  const clean = String(target || '').trim();
  const knownSiteUrl = resolveKnownSiteUrl(clean);
  if (knownSiteUrl) return { name: 'browser_open_task', arguments: { url: knownSiteUrl, open: true } };
  if (/^(?:https?:\/\/|www\.)/i.test(clean)) return { name: 'browser_open_task', arguments: { url: clean, open: true } };
  // i18n-allow: Chinese website-target recognition pattern; not user-visible copy.
  if (/(?:网站|网页|网址|网)$/u.test(clean)) return { name: 'browser_open_task', arguments: { query: clean, open: true } };
  return { name: 'desktop_open', arguments: { target: clean } };
}

/**
 * A deterministic quick command has already selected one exact tool from the
 * user's words. Route selection occasionally omits that same tool from the
 * broader LLM allow-list; add only the selected tool while preserving every
 * explicit forbidden rule and confirmation setting.
 */
export function buildQuickCommandToolPolicy(
  policy: ToolPolicy | undefined,
  toolName: string,
): ToolPolicy | undefined {
  if (!policy) return undefined;
  if (policy.forbiddenTools.includes('*') || policy.forbiddenTools.includes(toolName)) return policy;
  if (policy.allowedTools.includes('*') || policy.allowedTools.includes(toolName)) return policy;
  return {
    ...policy,
    allowedTools: [...policy.allowedTools, toolName],
  };
}

function normalizeQuickOpenTarget(value: string): string | null {
  let target = String(value || '').trim().replace(/[。！？.!?]+$/u, '').trim();
  if (!target) return null;

  // “打开正在运行的微信，不要启动新的微信” means focus the existing
  // application. desktop_open already focuses a matching running window first,
  // so reduce the phrase to the real application name.
  target = target
    .replace(/^(?:正在运行|当前运行|已经打开|已打开|现有)(?:着)?(?:的)?/u, '') // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    .replace(/[，,；;。]\s*(?:不要|别)(?:再|重新)?(?:启动|打开|新开).+$/u, '') // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    .replace(/\s*(?:不要|别)(?:再|重新)?(?:启动|打开|新开)(?:一个|新的?)?.+$/u, '') // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    .trim();

  if (!target) return null;
  // Natural-language website labels are context-sensitive in speech (ASR can
  // turn a recently mentioned brand into a homophone). Keep URLs and cataloged
  // sites deterministic, but let unknown home-page/site labels reach the
  // normal contextual planner instead of launching an unrelated local app.
  // i18n-allow: Chinese website-target recognition; not user-visible copy.
  if (!resolveKnownSiteUrl(target) && !/^(?:https?:\/\/|www\.)/i.test(target) && /(?:主页|官网|网站|网页|页面|平台)$/u.test(target)) {
    return null;
  }
  // Do not let the low-latency app launcher eat a compound task. The full turn
  // must reach the normal planner so later actions (inspect, count, remember,
  // message, edit, etc.) remain part of the user's requested outcome.
  if (/(?:然后|接着|随后|之后|以后|并且|同时|打开后|启动后|运行后|看下|看一下|看看|看一看|查一下|检查一下|统计|数一下|有多少|记住|读取|联系人|画图|绘制|生成|创建|新建|修改|编辑|保存|导出|登录|搜索|发送|发布|播放|执行脚本|运行脚本|问一下|问问|询问|回复|告诉|值守|监控|盯着|处理|管理|协作|聊天|对话|操作|移动|搬到|窗口|消息|工作流|任务|\b(?:then|after|inspect|count|remember|read|draw|draft|create|generate|edit|save|export|login|search|send|publish|play|script|ask|reply|tell|watch|monitor|handle|manage|collaborate|chat|message|workflow|task|move|window)\b)/iu.test(target)) { // i18n-allow: Chinese compound-work recognition; not user-visible copy.
    return null;
  }
  return target;
}

function findKnownLoginPreset(target: string) {
  const clean = String(target || '')
    .replace(/(?:网站|官网|平台|网页)$/u, '') // i18n-allow: Chinese site-target normalization; not user-visible copy.
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
  if (!clean) return undefined;
  return listWebLoginSitePresets().find(preset => {
    const label = preset.label.replace(/\s+/g, '').toLowerCase();
    return clean.includes(label) || label.includes(clean);
  });
}

const patterns: QuickPattern[] = [
  {
    patterns: [/[\s\S]+/u],
    handler: (match) => {
      const intent = classifyRuntimeWorkIntent(match[0]);
      if (intent === 'none') return { responseText: '', matched: false };
      const cancelling = intent === 'cancel';
      return {
        responseText: CN_VOICE_QUICK_WORK_MESSAGES.readingRuntimeWork(cancelling),
        matched: true,
        toolCall: { name: cancelling ? 'runtime_work_cancel' : 'runtime_work_status', arguments: {} },
        formatToolResult: (raw, error) => {
          if (error) return CN_VOICE_QUICK_WORK_MESSAGES.runtimeReadFailed;
          try {
            const payload = JSON.parse(raw || '{}');
            if (cancelling) {
              if (payload.status === 'idle' || Number(payload.matchedCount || 0) === 0) return CN_VOICE_QUICK_WORK_MESSAGES.noActiveWork;
              if (payload.status === 'cancelling') return CN_VOICE_QUICK_WORK_MESSAGES.workCancelling(Number(payload.cancellingCount || 0));
              return CN_VOICE_QUICK_WORK_MESSAGES.workCancelled(Number(payload.cancelledCount || payload.matchedCount || 0));
            }
            if (payload.status === 'idle' || Number(payload.activeCount || 0) === 0) return CN_VOICE_QUICK_WORK_MESSAGES.noActiveWork;
            const titles = Array.isArray(payload.items)
              ? payload.items.slice(0, 3).map((item: any) => String(item.title || item.id || '')).filter(Boolean)
              : [];
            return CN_VOICE_QUICK_WORK_MESSAGES.activeWork(Number(payload.activeCount || titles.length), titles);
          } catch {
            return CN_VOICE_QUICK_WORK_MESSAGES.runtimeReceiptInvalid;
          }
        },
      };
    },
  },
  {
    patterns: [/[\s\S]+/u],
    handler: (match) => {
      if (!isRunningSoftwareInspectionRequest(match[0])) return { responseText: '', matched: false };
      return {
        responseText: CN_VOICE_QUICK_WORK_MESSAGES.readingProcesses,
        matched: true,
        toolCall: { name: 'desktop_running_processes', arguments: { top: 50 } },
        formatToolResult: (raw, error) => {
          if (error) return CN_VOICE_QUICK_WORK_MESSAGES.processReadFailed;
          try {
            const payload = JSON.parse(raw || '[]');
            const entries = Array.isArray(payload) ? payload : Array.isArray(payload?.processes) ? payload.processes : [];
            const names = Array.from(new Set(entries
              .map((item: any) => String(item?.name || item?.process_name || '').replace(/\.exe$/i, '').trim())
              .filter(Boolean)));
            const topNames = names.slice(0, 8).join('\u3001');
            return [
              CN_VOICE_QUICK_WORK_MESSAGES.processSummary(entries.length, names.length),
              topNames ? CN_VOICE_QUICK_WORK_MESSAGES.processExamples(topNames) : '',
              CN_VOICE_QUICK_WORK_MESSAGES.processSnapshotCaveat,
            ].filter(Boolean).join('');
          } catch {
            return CN_VOICE_QUICK_WORK_MESSAGES.processReceiptInvalid;
          }
        },
      };
    },
  },
  {
    patterns: [/[\s\S]+/u],
    handler: (match, _userId, options) => {
      const action = requestedDesktopWindowAction(match[0]);
      if (!action) return { responseText: '', matched: false };
      const expectedTarget = String(options?.currentAppTarget || extractCurrentAppTarget(match[0]) || '').trim();
      return {
        responseText: CN_VOICE_QUICK_WORK_MESSAGES.adjustingWindow,
        matched: true,
        toolCall: {
          name: 'desktop_window_control',
          arguments: { action, ...(expectedTarget ? { expectedTarget } : {}) },
        },
        formatToolResult: (raw, error) => {
          if (error) return CN_VOICE_QUICK_WORK_MESSAGES.windowControlFailed;
          try {
            const payload = JSON.parse(raw || '{}');
            if (payload.ok === true && payload.status === 'verified' && payload.targetMatched === true) {
              return CN_VOICE_QUICK_WORK_MESSAGES.windowAdjusted(
                CN_VOICE_QUICK_WORK_MESSAGES.windowActionLabels[action],
                expectedTarget ? ` ${expectedTarget}` : '',
              );
            }
            if (payload.status === 'target_mismatch') return CN_VOICE_QUICK_WORK_MESSAGES.windowTargetMismatch;
            return CN_VOICE_QUICK_WORK_MESSAGES.windowNotVerified;
          } catch {
            return CN_VOICE_QUICK_WORK_MESSAGES.windowReceiptInvalid;
          }
        },
      };
    },
  },
  // ── Voice connection acknowledgement ──
  {
    patterns: [
      // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
      /^(?:你)?(?:能不能|能否|可以不可以|可不可以|能)?\s*(?:听见|听到|听清|听得到)\s*(?:我说话(?:吗|么)?|我吗|吗|么)?[。！？.!?]*$/i,
      /^can\s+you\s+hear\s+me[。！？.!?]*$/i,
    ],
    handler: () => ({
      responseText: CN_VOICE_FAST_PATH_MESSAGES.audible,
      matched: true,
    }),
  },

  {
    patterns: [
      // i18n-allow: direct client-mode status question.
      /^(?:你)?(?:现在|当前)?(?:是|处于)?(?:什么|哪种|哪个)模式[。！？.!?]*$/u,
      /^(?:what|which)\s+(?:client\s+)?mode\s+(?:are\s+you|is\s+active)[?!.]*$/i,
    ],
    handler: async (_, userId) => {
      const { getStoredOperationMode } = await import('./operation_mode_store');
      let mode = 'assistant';
      try { mode = getStoredOperationMode(userId); } catch {}
      return {
        responseText: CN_VOICE_FAST_PATH_MESSAGES.operationModeStatus(mode),
        matched: true,
      };
    },
  },

  {
    patterns: [
      // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
      /^(?:(?:看一下|查一下|查一查|告诉我)\s*)?(?:现在\s*)?知识库(?:里|里面|中)?(?:现在\s*)?有多少(?:个|的)?文件(?:内容)?[。！？.!?]*$/u,
    ],
    handler: () => ({
      responseText: CN_VOICE_FAST_PATH_MESSAGES.readingKnowledgeStats,
      toolCall: { name: 'knowledge_file_stats', arguments: {} },
      formatToolResult: (raw, error) => CN_VOICE_FAST_PATH_MESSAGES.knowledgeStats(raw, error),
      matched: true,
    }),
  },

  // ── Time / Date ──
  {
    patterns: [/^(几点|几点了|现在几点|什么时间|what\s*time|current\s*time|时间)[。！？.!?]*$/i],
    handler: () => {
      const now = new Date();
      const time = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const weekday = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()];
      return {
        responseText: `现在是${time}，${weekday}。`,
        matched: true,
      };
    },
  },
  {
    patterns: [/^(今天几号|今天日期|日期|几号|星期几|what\s*day|date\s*today)[。！？.!?]*$/i],
    handler: () => {
      const now = new Date();
      const date = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
      const weekday = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()];
      return {
        responseText: `今天是${date}，${weekday}。`,
        matched: true,
      };
    },
  },

  // ── Weather ──
  {
    patterns: [/^(天气|今天天气|天气怎么样|what'?s?\s*the\s*weather|weather|查天气|今天热不热|今天冷不冷)[。！？.!?]*$/i],
    handler: async (_, userId) => {
      try {
        const { getWeatherBrief } = await import('../services/weather');
        const weather = await getWeatherBrief();
        if (weather) {
          return { responseText: weather, matched: true };
        }
      } catch {}
      return { responseText: '抱歉，暂时获取不到天气信息。', matched: true };
    },
  },

  // ── Calculator / Apps ──
  {
    patterns: [/^(打开计算器|计算器|calculator|open\s*calculator)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '好的，正在打开计算器。',
      toolCall: { name: 'desktop_open', arguments: { target: 'calc.exe' } },
      matched: true,
    }),
  },
  {
    patterns: [/^(打开记事本|记事本|notepad|open\s*notepad)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '好的，正在打开记事本。',
      toolCall: { name: 'desktop_open', arguments: { target: 'notepad.exe' } },
      matched: true,
    }),
  },
  {
    patterns: [/^(打开任务管理器|任务管理器|task\s*manager)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '好的，正在打开任务管理器。',
      toolCall: { name: 'desktop_run_command', arguments: { command: 'taskmgr' } },
      matched: true,
    }),
  },
  {
    patterns: [/^(打开终端|终端|terminal|cmd|命令提示符|命令行)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '好的，正在打开终端。',
      toolCall: { name: 'desktop_open', arguments: { target: 'cmd.exe' } },
      matched: true,
    }),
  },
  {
    patterns: [/^(打开浏览器|浏览器|browser|open\s*browser)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '好的，正在打开浏览器。',
      toolCall: { name: 'browser_open_task', arguments: { url: 'https://www.google.com', open: true } },
      matched: true,
    }),
  },
  {
    patterns: [/^(打开VS\s*Code|打开vscode|vscode|code)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '好的，正在打开 VS Code。',
      toolCall: { name: 'desktop_open', arguments: { target: 'code' } },
      matched: true,
    }),
  },
  {
    // Known account sites use the visible persistent login session directly.
    // Captcha/QR/2FA remain manual and are reported by the tool receipt.
    patterns: [
      /^(?:(?:请|麻烦|请你|帮我|你帮我|给我)\s*)?(?:登录|登陆|登入|log\s*in(?:to)?|sign\s*in(?:to)?)\s*(.+?)[。！？.!?]*$/iu, // i18n-allow: Chinese login-intent recognition; not user-visible copy.
    ],
    handler: (match) => {
      const target = String(match[1] || '').trim();
      const preset = findKnownLoginPreset(target);
      if (!preset) return { responseText: '', matched: false };
      return {
        responseText: formatKnownLoginOpening(match[0], preset.label),
        toolCall: {
          name: 'web_login_run',
          arguments: {
            profileId: preset.id,
            url: preset.loginUrl,
            headless: false,
            waitForManualMs: 45_000,
          },
        },
        formatToolResult: (raw, error) => formatKnownLoginResult(match[0], preset.label, raw, error),
        matched: true,
      };
    },
  },
  {
    // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
    patterns: [/^(?:(?:请|麻烦|请你|帮我|你帮我|给我|我要|我想)\s*)?(?:打开|启动|运行|开启|launch|open|start|run)\s*(?:程序|应用|app|软件)?\s*(?:一下)?\s*(.+?)[。！？.!?]*$/i],
    handler: (match) => {
      const target = normalizeQuickOpenTarget(String(match[1] || ''));
      if (
        !target
        // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
        || /^(?:了|着|得|多久|这么久|这么慢|为什么|怎么|为何)/u.test(target)
        // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
        || /(?:然后|接着|随后|之后|以后|并且|同时|打开后|启动后|运行后|画图|绘制|生成|创建|新建|修改|编辑|保存|导出|登录|搜索|发送|发布|播放|执行脚本|运行脚本|问一下|问问|询问|回复|告诉|\b(?:then|after|draw|draft|create|generate|edit|save|export|login|search|send|publish|play|script|ask|reply|tell)\b)/iu.test(target)
      ) {
        return { responseText: '', matched: false };
      }
      return {
        responseText: CN_VOICE_FAST_PATH_MESSAGES.opening(target),
        toolCall: quickOpenToolCall(target),
        formatToolResult: (raw, error) => error
          ? CN_VOICE_FAST_PATH_MESSAGES.openFailed(target, error)
          : raw.trim()
            ? CN_VOICE_FAST_PATH_MESSAGES.opened(target)
            : CN_VOICE_FAST_PATH_MESSAGES.openReceiptMissing(target),
        matched: true,
      };
    },
  },

  // ── Volume Control ──
  {
    patterns: [/^(静音|mute|关闭声音|关声音)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '好的，已静音。',
      toolCall: { name: 'desktop_run_command', arguments: { command: 'nircmd mutesysvolume 1' } },
      matched: true,
    }),
  },
  {
    patterns: [/^(取消静音|开声音|unmute|打开声音)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '好的，已取消静音。',
      toolCall: { name: 'desktop_run_command', arguments: { command: 'nircmd mutesysvolume 0' } },
      matched: true,
    }),
  },

  // ── Screenshot ──
  {
    patterns: [/^(截图|截屏|screenshot|screen\s*shot|屏幕截图)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '正在截图...',
      toolCall: { name: 'ocr_screen', arguments: {} },
      matched: true,
    }),
  },

  // ── System Info ──
  {
    patterns: [/^(系统信息|system\s*info|sysinfo|内存|CPU|磁盘|电脑配置)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '正在获取系统信息...',
      toolCall: { name: 'desktop_run_command', arguments: { command: 'systeminfo | findstr /B /C:"OS Name" /C:"Total Physical Memory" /C:"Available Physical Memory"' } },
      matched: true,
    }),
  },

  // ── Settings Toggles ──
  {
    patterns: [/^(打开|关闭)?(深色模式|dark\s*mode|夜间模式|浅色模式|light\s*mode)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '你可以在设置中切换主题模式。',
      matched: true,
    }),
  },

  // ── Lumi Status / Health ──
  {
    patterns: [/^\/status$|^状态$|^系统状态$|^健康检查$|^lumi.*状态|^检查.*系统/i],
    handler: async (_, userId, options) => {
      try {
        const { runHealthAudit } = await import('../agents/health_audit');
        const report = runHealthAudit(userId, {
          domain: options?.domain === 'work' ? 'work' : 'personal',
          orgId: options?.orgId || '',
        });
        const lines = [
          `## Lumi 系统状态: ${report.overallStatus === 'healthy' ? '✅ 健康' : report.overallStatus === 'degraded' ? '⚠️ 部分降级' : '❌ 异常'}`,
          '',
          ...report.checks.map(c =>
            `- **${c.name}**: ${c.status === 'ok' ? '✅' : c.status === 'warn' ? '⚠️' : '❌'} ${c.detail}`
          ),
          '',
        ];
        if (report.recommendations.length > 0) {
          lines.push('### 建议');
          report.recommendations.forEach(r => lines.push(`- ${r}`));
        }
        if (report.evolutionInsight) {
          lines.push('', `> ${report.evolutionInsight}`);
        }
        return { responseText: lines.join('\n'), matched: true };
      } catch (e: any) {
        return { responseText: `状态检查失败: ${e.message}`, matched: true };
      }
    },
  },

  // ── Evolution / Self-awareness ──
  {
    patterns: [/^(你学到了什么|你有什么变化|你进化了吗|你变了吗|你更懂我了吗|你的成长|你的记忆|你记得什么|what.*learn|what.*change|how.*evolve)[。！？.!?]*$/i],
    handler: async (_, userId, options) => {
      try {
        const { personalityRegistry } = await import('../personality');
        const domain = options?.domain === 'work' ? 'work' : 'personal';
        const orgId = domain === 'work' ? String(options?.orgId || '') : '';
        const personality = personalityRegistry.getForUser('lumi', userId, orgId || undefined);
        if (!personality) return { responseText: '我还是出厂设置，还没开始学习呢。多和我互动吧！', matched: true };

        const history = personalityRegistry.getEvolutionHistory('lumi', userId, orgId || undefined);
        const lines: string[] = [];

        // Memory stats
        try {
          const db = readDB();
          const memories = ((db as any).memories || []).filter((memory: any) => (
            memory.userId === userId
            && (memory.domain || 'personal') === domain
            && (memory.orgId || '') === orgId
          ));
          const byType: Record<string, number> = {};
          for (const m of memories) {
            const t = m.type || 'other';
            byType[t] = (byType[t] || 0) + 1;
          }
          const memSummary = Object.entries(byType)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');
          lines.push(`**记忆**: ${memories.length} 条 (${memSummary || 'empty'})`);
        } catch {
          lines.push('**记忆**: 暂时无法读取');
        }

        // Agent team
        try {
          const db = readDB();
          const agents = ((db as any).agents || []).filter((agent: any) => {
            if (domain === 'work') {
              return (agent.domain || 'work') === 'work' && (agent.orgId || '') === orgId;
            }
            return agent.domain !== 'work'
              && !agent.orgId
              && (!agent.ownerUid || agent.ownerUid === userId);
          });
          const internal = agents.filter((a: any) => a.runtime !== 'external');
          const external = agents.filter((a: any) => a.runtime === 'external');
          lines.push(`**团队**: ${agents.length} 个 Agent (${internal.length} 内置, ${external.length} 外部)`);
        } catch {
          lines.push('**团队**: 暂时无法读取');
        }

        // Workflow count
        try {
          const wfs = listWorkflows(userId, undefined, { domain, orgId });
          lines.push(`**工作流**: ${wfs.length} 个已保存的自动化流程`);
        } catch {
          lines.push('**工作流**: 暂时无法读取');
        }

        // Personality evolution
        if (history && history.length > 0) {
          const last = history[history.length - 1];
          const daysAgo = Math.round((Date.now() - new Date(last.timestamp).getTime()) / 86400000);
          lines.push(`**人格演化**: ${history.length} 次进化，最近一次 ${daysAgo} 天前`);
          if (last.narrative) {
            lines.push(`> "${last.narrative.slice(0, 200)}"`);
          }
        } else {
          lines.push('**人格演化**: 还在出厂设置，多聊天我会自动调整风格');
        }

        const version = personality.version || '2.3';
        lines.push('', `*Lumi ${version} · 持续进化中*`);

        return { responseText: lines.join('\n'), matched: true };
      } catch (e: any) {
        return { responseText: `抱歉，暂时无法读取进化数据: ${e.message}`, matched: true };
      }
    },
  },

  // ── Work takeover continuity ──
  {
    patterns: [
      /^(继续|继续做|继续推进|继续执行|继续处理|接着|接着做|往下|往下走|下一步|下一步呢|接下来呢|做下一步|跑下一步|再跑一步|然后呢|然后|开始吧|来吧|做完了吗|好了没|好了吗|完成了吗|跑完了吗|结果呢|结果怎么样|进度呢|状态呢|状态怎么样|卡在哪|哪里卡了|哪里卡住了|为什么没做完|怎么回事|好|好的|可以|行|嗯|嗯嗯|ok|okay|收到|继续吧|继续一下|推进一下)[。！？.!?]*$/i,
      /(刚刚|刚才|上一个|上一条|这个任务|这个事|那件事|它|这个).*(继续|下一步|接着|推进|执行|处理|跑|做|做完|完成|结果|进度|状态|卡|失败|成功|怎么回事)/u,
    ],
    handler: (match, userId, options) => {
      const command = getWorkTakeoverContinuationQuickCommand(match.input || '', userId, {
        domain: options?.domain,
        orgId: options?.orgId,
        surface: options?.surface,
      });
      if (!command) return { responseText: '', matched: false };
      return {
        responseText: command.responseText,
        toolCall: command.toolCall,
        formatToolResult: command.formatToolResult,
        matched: true,
      };
    },
  },

  // ── Simple Yes/No ──
  {
    patterns: [
      // i18n-allow: a short affirmative result from the user, not a new open command.
      /^(?:(?:已经|现在|刚才|它|软件|页面|窗口)\s*)?(?:打开|启动|运行)(?:了|好(?:了)?)[。！!]*$/u,
      /^(?:it\s+)?(?:opened|launched|started)(?:\s+now)?[.!]*$/i,
    ],
    handler: () => ({
      responseText: CN_VOICE_FAST_PATH_MESSAGES.openConfirmedByUser,
      matched: true,
    }),
  },
  {
    patterns: [/^(好的|ok|okay|好|嗯|知道了|收到|明白了|懂了|got\s*it|alright|fine)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '👍',
      matched: true,
    }),
  },
  {
    patterns: [/^(谢谢|多谢|thanks|thank\s*you|3Q|thx)[。！？.!?]*$/i],
    handler: () => ({
      responseText: '不客气！',
      matched: true,
    }),
  },
  {
    patterns: [/^(晚安|good\s*night|bye|再见|拜拜|回头见|see\s*you|later)[。！？.!?]*$/i],
    handler: () => ({
      responseText: new Date().getHours() < 6 ? '晚安，早点休息。' : '再见，有需要随时叫我。',
      matched: true,
    }),
  },
];

/**
 * Try to match user input against quick command patterns.
 * Returns null if no match — caller should proceed to LLM path.
 */
export async function matchQuickCommand(
  text: string,
  userId: string,
  options?: QuickCommandOptions,
): Promise<QuickCommandResult | null> {
  const clean = text.trim();

  for (const pattern of patterns) {
    for (const regex of pattern.patterns) {
      const match = clean.match(regex);
      if (match) {
        const result = await pattern.handler(match, userId, options);
        if (result?.matched) return result;
      }
    }
  }

  return null;
}

/**
 * Quick check: can this input be handled without LLM?
 * Returns true if any pattern matches — used to skip LLM classifier cost.
 */
export function isQuickCommand(text: string): boolean {
  const clean = text.trim();
  for (const pattern of patterns) {
    for (const regex of pattern.patterns) {
      if (regex.test(clean)) return true;
    }
  }
  return false;
}
