/**
 * Quick Command Fast-Path — deterministic pattern-match tree.
 *
 * Catches common commands before they reach the LLM, returning millisecond responses.
 * Used by both chat.ts and voice.ts to bypass full LLM orchestration.
 */

import { readDB } from '../../db_layer';
import { getWorkTakeoverContinuationQuickCommand, type WorkTakeoverTurnSurface } from '../work_takeover/continuity';
import { listWorkflows } from '../agents/workflows';

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
}

const patterns: QuickPattern[] = [
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
      toolCall: { name: 'desktop_open', arguments: { target: 'https://www.google.com' } },
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
