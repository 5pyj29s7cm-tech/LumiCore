const INTERNAL_CAPABILITY_LABELS: Array<[RegExp, string]> = [
  [/`?mcp_design-studio-pack_interior_visual_direction`?/gi, '专业视觉方向评估'],
  [/`?mcp_design-studio-pack_drawing_ingest_qa`?/gi, '专业图纸资料质检'],
  [/`?mcp_design-studio-pack_interior_project_brief`?/gi, '专业项目需求梳理'],
  [/`?mcp_design-studio-pack_space_planning_checklist`?/gi, '空间规划检查'],
  [/`?generate_image`?/gi, '图片生成服务'],
  [/`?create_ppt`?/gi, '提案文件生成'],
  [/`?design_delivery_package_create`?/gi, '交付包整理'],
  [/`?cad_generate_dxf`?/gi, 'CAD 文件生成'],
  [/`?industry_workflow_complete`?/gi, '完成校验'],
  [/`?work_takeover_task_get`?/gi, '任务状态读取'],
];

const EN_CAPABILITY_LABELS = ['Professional visual direction review', 'Drawing evidence QA', 'Project brief review', 'Space planning check', 'Image generation service', 'Proposal generation', 'Delivery packaging', 'CAD file generation', 'Completion verification', 'Task status reading'];

export function humanizeIndustryWorkflowResponse(text: unknown, locale: 'zh' | 'en' = /[\u3400-\u9fff]/u.test(String(text || '')) ? 'zh' : 'en'): string {
  let value = String(text || '');
  value = value.replace(/`?(?:industry_)?wt_task_[A-Za-z0-9_-]+`?/g, locale === 'zh' ? '当前任务' : 'current task');
  for (const [index, [pattern, label]] of INTERNAL_CAPABILITY_LABELS.entries()) {
    value = value.replace(pattern, locale === 'zh' ? label : EN_CAPABILITY_LABELS[index]);
  }
  value = value.replace(/未调用完成校验/g, '因此没有标记为完成');
  return value;
}

const DESIGN_STAGE_LABELS: Record<string, string> = {
  project: '项目建档',
  cad: 'CAD 方案',
  visualization: '效果图',
  presentation: '提案 PPT',
  handoff: '交付中心',
};

export function formatIndustryWorkflowPrerequisiteBlocker(input: {
  projectName?: string;
  entryId: string;
  missing: string[];
  locale?: 'zh' | 'en';
}): string {
  if (input.locale === 'en') {
    const labels: Record<string, string> = { project: 'Project setup', cad: 'CAD scheme', visualization: 'Visualization', presentation: 'Proposal PPT', handoff: 'Handoff' };
    const target = labels[input.entryId] || input.entryId;
    const missing = input.missing.map(id => labels[id] || id).join(', ');
    return [`I checked the persistent ledger for ${String(input.projectName || '').trim() || 'the current design project'}.`,
      `${target} cannot start: upstream stages have not passed receipt verification: ${missing}.`,
      'No downstream files were generated or overwritten, and nothing was sent externally.',
      `Complete and verify ${missing} first. The same project and existing outputs will be reused.`].join('\n');
  }
  const projectName = String(input.projectName || '').trim() || '当前设计项目';
  const target = DESIGN_STAGE_LABELS[input.entryId] || input.entryId;
  const missing = input.missing.map(item => DESIGN_STAGE_LABELS[item] || item).join('、');
  return [
    `我已核对「${projectName}」的持久项目账本。`,
    `当前不能进入${target}：上游阶段“${missing}”尚未通过真实回执。`,
    '本轮没有生成或覆盖下游文件，也没有执行任何对外发送。',
    `请先完成并核验：${missing}。通过后，Lumi 会继续沿用同一项目和已有成果，不需要重新建项目或重新猜测资料。`,
  ].join('\n');
}
