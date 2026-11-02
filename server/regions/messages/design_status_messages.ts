export type DesignStageId = 'project' | 'cad' | 'visualization' | 'presentation' | 'handoff';
export const DESIGN_STAGE_LABELS = {
  zh: { project: '设计项目', cad: 'CAD 方案', visualization: '效果图', presentation: '提案 PPT', handoff: '交付中心' },
  en: { project: 'Design project', cad: 'CAD scheme', visualization: 'Visualization', presentation: 'Proposal PPT', handoff: 'Handoff' },
} as const;

const COPY = {
  zh: { completed: '已完成', in_progress: '进行中', blocked: '已阻塞', waiting_confirmation: '等待确认', queued: '已排队', not_started: '未开始',
    passed: '已通过', failed: '未通过', needs_review: '待复核', unverified: '尚无验证', none: '无', allDone: '全部阶段已完成', nextUnknown: '下一阶段尚未记录',
    verification: '验证状态', task: '当前任务 ID', files: '交付文件', noFiles: '暂无已归档文件', blocker: '阻塞项', next: '下一阶段',
    readOnly: '以上结论来自当前持久项目账本，本次只读查询没有重新执行设计工作。', summaryOnly: '以上结论来自当前持久项目账本，本次没有执行新工作。',
    billing: '图像生成服务 DashScope（通义万相）账户欠费（Arrearage），没有产生真实图片，系统已停止自动重试。请恢复 DashScope 计费，或配置 OpenAI / SiliconFlow 图像服务后再继续。',
    provider: '当前没有可用的图像生成服务，未生成真实图片。请先在“设置 > 生成模型”中配置 OpenAI、DashScope 或 SiliconFlow。',
    unknown: '本次外部生成结果无法确认，为避免重复执行，系统已停止自动重试。' },
  en: { completed: 'Completed', in_progress: 'In progress', blocked: 'Blocked', waiting_confirmation: 'Awaiting confirmation', queued: 'Queued', not_started: 'Not started',
    passed: 'Passed', failed: 'Failed', needs_review: 'Needs review', unverified: 'Not verified', none: 'None', allDone: 'All stages completed', nextUnknown: 'Next stage not recorded',
    verification: 'Verification', task: 'Current task ID', files: 'Delivered files', noFiles: 'No archived files', blocker: 'Blocker', next: 'Next stage',
    readOnly: 'This result comes from the current persistent project ledger. This read-only query did not rerun design work.', summaryOnly: 'This result comes from the current persistent project ledger. No new work ran in this query.',
    billing: 'DashScope billing is overdue (Arrearage). No actual image was produced and automatic retries stopped. Restore billing or configure OpenAI / SiliconFlow image generation before continuing.',
    provider: 'No working image provider is configured; no actual image was generated. Configure OpenAI, DashScope or SiliconFlow in Settings > Generation models.',
    unknown: 'The external generation outcome is unknown. Automatic retries stopped to avoid duplicate execution.' },
} as const;

function object(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch {} }
  return {};
}

export function formatDesignLedgerMessage(project: Record<string, any>, workflow: Record<string, any>, selected: DesignStageId | null, locale: 'zh' | 'en'): string {
  const c = COPY[locale]; const labels = DESIGN_STAGE_LABELS[locale]; const zh = locale === 'zh';
  const separator = zh ? '：' : ': ';
  const statusLabel = (raw: unknown) => {
    const value = String(raw || '').toLowerCase();
    const key = value === 'delivered' ? 'completed' : value === 'executing' ? 'in_progress' : value || 'not_started';
    return ['completed', 'in_progress', 'blocked', 'waiting_confirmation', 'queued', 'not_started'].includes(key) ? c[key as 'completed'] : value;
  };
  const verificationLabel = (raw: unknown) => {
    const value = String(raw || '').toLowerCase();
    return value === 'verified' || value === 'passed' ? c.passed : value === 'blocked' || value === 'failed' ? c.failed : value === 'needs_review' ? c.needs_review : value || c.unverified;
  };
  const blockerLabel = (rawValue: unknown) => {
    const raw = String(rawValue || '').replace(/\s+/g, ' ').trim(); if (!raw) return c.none;
    const match = raw.match(/Design stage\s+([a-z_]+)\s+is blocked until verified upstream stages complete:\s*([^.]*)/i);
    if (match) {
      const target = labels[match[1] as DesignStageId] || match[1];
      const upstream = match[2].split(/[,\s]+/).filter(Boolean).map(v => labels[v as DesignStageId] || v).join(zh ? '、' : ', ');
      return zh ? `${target}${/[A-Za-z]$/.test(target) ? ' ' : ''}的前置阶段尚未通过：${upstream || '未知阶段'}。必须先完成并验证这些阶段，当前已停止执行。`
        : `${target} is blocked until upstream stages pass verification: ${upstream || 'unknown stage'}. Execution stopped.`;
    }
    if (/Arrearage|overdue payment|account is in good standing/i.test(raw)) return c.billing;
    if (/No working image generation provider|Configure OpenAI, DashScope, or SiliconFlow/i.test(raw)) return c.provider;
    if (/external commit outcome is unknown|automatic resend was stopped/i.test(raw)) return c.unknown;
    return raw.replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim().slice(0, 360);
  };
  const stages = object(workflow.stages); const ordered = Object.keys(labels) as DesignStageId[];
  const allVerified = ordered.every(id => { const stage = object(stages[id]); return stage.status === 'completed' && stage.verificationStatus === 'passed'; });
  const next = String(workflow.nextStage || '').trim() as DesignStageId;
  const nextLabel = labels[next] ? `${labels[next]}${zh ? '（' : ' ('}${statusLabel(object(stages[next]).status)}${zh ? '）' : ')'}` : allVerified ? c.allDone : c.nextUnknown;
  const header = zh ? `“${String(project.name || project.id)}”项目账本：` : `Project ledger: ${String(project.name || project.id)}`;
  if (selected && stages[selected]) {
    const stage = object(stages[selected]);
    const paths = [...new Set<string>((Array.isArray(stage.artifacts) ? stage.artifacts : []).map((a: any) => String(a?.path || '').trim()).filter(Boolean))];
    return [header, `- ${labels[selected]}${separator}${statusLabel(stage.status)}`, `- ${c.verification}${separator}${verificationLabel(stage.verificationStatus)}`,
      `- ${c.task}${separator}${String(stage.currentTaskId || c.none)}`, `- ${c.files}${separator}${paths.length ? paths.join(zh ? '；' : '; ') : c.noFiles}`,
      `- ${c.blocker}${separator}${blockerLabel(stage.blocker)}`, `- ${c.next}${separator}${nextLabel}`, c.readOnly].join('\n');
  }
  return [header, ...ordered.map(id => { const stage = object(stages[id]); return `- ${labels[id]}${separator}${statusLabel(stage.status)}${zh ? '，验证=' : ', verification='}${verificationLabel(stage.verificationStatus)}`; }),
    `- ${c.next}${separator}${nextLabel}`, c.summaryOnly].join('\n');
}
