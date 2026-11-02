import type { IndustryCapabilityEntry } from '../routing/industry_profile';
function describeDesignConfirmationBoundaries(values: unknown[]): string[] {
  const text = values.map(String).join(' ').toLowerCase();
  const labels: string[] = [];
  const add = (label: string) => { if (!labels.includes(label)) labels.push(label); };
  if (/external delivery|client delivery|client-facing claims?|customer delivery/.test(text)) add('客户外发');
  if (/professional review|professional sign-off|structural|\bmep\b|site dimensions?/.test(text)) add('专业复核或签认');
  if (/final quotations?|final selections?|commercial terms?|commercial acceptance/.test(text)) add('最终方案、报价或商业验收');
  if (/overwrit(?:e|ing) source drawings?/.test(text)) add('覆盖源图');
  if (/licensed assets?|copyright/.test(text)) add('版权素材');
  return labels;
}

function designProjectStageStatusLabel(stage: any): string {
  const status = String(stage?.status || 'not_started');
  const verificationStatus = String(stage?.verificationStatus || '').trim();
  if (status === 'completed' && verificationStatus === 'passed') return '已完成（最终回执已验证）';
  if (status === 'completed') return '已完成（等待最终验证）';
  if (status === 'blocked') return `受阻${verificationStatus ? `（验证状态：${verificationStatus}）` : ''}`;
  if (status === 'waiting_confirmation') return '等待确认';
  if (status === 'in_progress') return '执行中';
  return '尚未开始';
}

export function formatDesignProjectWorkflowLedgerStatus(project: any, requestedEntries: IndustryCapabilityEntry[], profileDisplayName: string): string {
  const sections = requestedEntries.map(entry => {
    const stage = project.workflow?.stages?.[entry.entryId];
    if (!stage) {
      return [
        `【${entry.displayName}】`,
        '最近任务状态：无项目阶段记录',
        `关键结果：项目“${project.name}”中没有该阶段的持久化回执`,
        '交付物：无最终回执记录',
        '确认边界：没有把未验证步骤描述成已完成',
      ].join('\n');
    }
    const taskId = String(stage.currentTaskId || '').trim();
    const verificationStatus = String(stage.verificationStatus || '').trim();
    const blocker = String(stage.blocker || '').trim();
    const keyResults = [
      `项目“${project.name}”`,
      taskId ? `任务 ${taskId}` : '',
      verificationStatus ? `验证状态 ${verificationStatus}` : '',
      blocker ? `阻塞原因：${blocker}` : '',
    ].filter(Boolean);
    const deliverables = (Array.isArray(stage.artifacts) ? stage.artifacts : [])
      .map((artifact: any) => {
        const label = String(artifact?.label || '').trim();
        const fileName = String(artifact?.fileName || '').trim();
        return label && fileName && label !== fileName ? `${label}（${fileName}）` : label || fileName;
      })
      .filter(Boolean);
    const boundaries = describeDesignConfirmationBoundaries(entry.contract.confirmationBoundaries || []);
    return [
      `【${entry.displayName}】`,
      `最近任务状态：${designProjectStageStatusLabel(stage)}`,
      `关键结果：${keyResults.join('；') || '尚无可验证执行结果'}`,
      `交付物：${deliverables.length ? deliverables.join('、') : '最终回执中未记录交付物'}`,
      `确认边界：${boundaries.length ? `${boundaries.join('、')}仍需逐项确认和真实平台回执` : '没有把未验证步骤描述成已完成'}`,
    ].join('\n');
  });
  return [
    `行业任务账本汇总（${profileDisplayName}）`,
    ...sections,
    '本次仅读取已存在的项目账本与最终回执；未重新执行工作流、未调用外部工具、未创建新任务、未进行客户外发、覆盖源图或专业签认。',
  ].join('\n\n');
}
