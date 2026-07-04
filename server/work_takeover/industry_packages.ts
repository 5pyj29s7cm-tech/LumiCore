import fs from 'fs';
import {
  updateWorkTakeoverTask,
  type WorkTakeoverArtifact,
  type WorkTakeoverTask,
} from './tasks';
import type { WorkTakeoverIndustryParameters } from './industry_parameters';
import {
  getIndustryPackageAdapter,
  isEcommerceGrowthCategory,
  packageKindForCategory,
  type WorkTakeoverIndustryPackageKind,
} from './industry_package_adapters';

export {
  isEcommerceGrowthCategory,
  packageKindForCategory,
  type WorkTakeoverIndustryPackageKind,
} from './industry_package_adapters';

export interface WorkTakeoverIndustryPackageResult {
  kind: WorkTakeoverIndustryPackageKind;
  task: WorkTakeoverTask;
  files: any;
  reused: boolean;
  note: string;
}

function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map(compact).filter(Boolean)));
}

function readOptionalText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

export function getTaskIndustryParameters(task: any): WorkTakeoverIndustryParameters | undefined {
  const params = task?.metadata?.industryParameters;
  return params && typeof params === 'object' ? params as WorkTakeoverIndustryParameters : undefined;
}

function taskIndustrySource(task: any): string {
  const params = getTaskIndustryParameters(task);
  return [
    task.sourceMessage,
    task.summary,
    task.title,
    params?.summaryLines?.join('；'),
    ...(Array.isArray(task.nextActions) ? task.nextActions : []),
    ...(Array.isArray(task.artifacts) ? task.artifacts.map((artifact: any) => artifact?.label || artifact?.content || '') : []),
  ].map(compact).filter(Boolean).join('\n');
}

function taskDesignDeliverySource(task: any): string {
  return [
    task.sourceMessage,
    task.summary,
    task.title,
    ...(Array.isArray(task.nextActions) ? task.nextActions : []),
    ...(Array.isArray(task.artifacts) ? task.artifacts.map((artifact: any) => artifact?.label || artifact?.content || '') : []),
  ].map(compact).filter(Boolean).join('\n');
}

function addArtifacts(
  userId: string,
  task: WorkTakeoverTask,
  artifacts: Array<Partial<WorkTakeoverArtifact> & { label: string }>,
  needsReview = false,
): WorkTakeoverTask {
  let updatedTask = task;
  for (const artifact of artifacts) {
    updatedTask = updateWorkTakeoverTask(userId, updatedTask.id, {
      artifact: {
        ...artifact,
        status: artifact.type === 'checklist' && needsReview ? 'needs_review' : (artifact.status || 'prepared'),
      },
    } as any) || updatedTask;
  }
  return updatedTask;
}

function recordDesignDeliveryPackage(
  userId: string,
  task: WorkTakeoverTask,
  outputDirectory?: string,
  regenerate = false,
): WorkTakeoverIndustryPackageResult {
  const existing = task?.metadata?.workTakeoverDesignDelivery?.files;
  if (!regenerate && existing?.folder && fs.existsSync(existing.folder)) {
    return {
      kind: 'design_delivery',
      task,
      files: existing,
      reused: true,
      note: 'Existing design delivery package was reused and remains recorded on the task.',
    };
  }

  const files = getIndustryPackageAdapter('design_delivery').createFiles(taskDesignDeliverySource(task), { outputDirectory });
  const verificationText = readOptionalText(files.verification);
  const wechatDraftText = readOptionalText(files.wechatDraft);
  const verificationPassed = files.verificationResult.passed;
  const result = [
    `已生成装修设计交付包：${files.folder}`,
    `项目：${files.project.projectTitle}`,
    `交付自检：${verificationPassed ? '通过' : '需要复核'}`,
    files.verificationResult.checks
      .filter(check => !check.passed)
      .map(check => `${check.label}：${check.detail}`)
      .join('；'),
    '下一步：用户确认发送口径、预算边界、现场尺寸/结构/水电复核后，再进入外部 CAD/Revit 深化或微信发送。',
  ].map(compact).filter(Boolean).join('\n');

  let updatedTask = updateWorkTakeoverTask(userId, task.id, {
    status: 'waiting_confirmation',
    result,
    allowedNow: uniqueStrings([
      ...task.allowedNow,
      '生成本地装修设计交付包',
      '准备客户微信回复草稿',
      '记录交付自检结果',
    ]),
    confirmationRequired: uniqueStrings([
      ...task.confirmationRequired,
      '发送客户微信消息',
      '打开外部 CAD/Revit 并修改生产图纸',
      '承诺最终报价、工期、合同或施工结果',
    ]),
    metadata: {
      workTakeoverDesignDelivery: {
        files,
        verificationText,
        preparedAt: new Date().toISOString(),
      },
    },
    note: `装修设计交付包已生成，自检${verificationPassed ? '通过' : '需要复核'}。`,
    ...(wechatDraftText && !task.drafts?.some((draft: any) => draft.text === wechatDraftText) ? { draftReply: wechatDraftText } : {}),
  } as any) || task;

  updatedTask = addArtifacts(userId, updatedTask, [
    { type: 'file', label: '装修设计交付包', path: files.folder, content: result },
    { type: 'document', label: '装修设计方案 RTF', path: files.proposal },
    { type: 'quote', label: '预算与材料清单 RTF', path: files.budget },
    { type: 'document', label: '客户方案 PPTX', path: files.presentation },
    { type: 'document', label: '客户方案 PDF', path: files.pdf },
    { type: 'cad', label: 'CAD DXF 初稿', path: files.cadDxf },
    { type: 'cad', label: 'Revit/Dynamo 交接数据', path: files.dynamoScript },
    { type: 'draft', label: '微信交付草稿', path: files.wechatDraft, content: wechatDraftText },
    { type: 'checklist', label: '交付验证记录', path: files.verification, content: verificationText },
  ], !verificationPassed);

  return {
    kind: 'design_delivery',
    task: updatedTask,
    files,
    reused: false,
    note: 'Design delivery package generated locally and recorded on the task. External app operation and message sending remain confirmation-gated.',
  };
}

function recordEcommerceGrowthPackage(
  userId: string,
  task: WorkTakeoverTask,
  outputDirectory?: string,
  regenerate = false,
): WorkTakeoverIndustryPackageResult {
  const existing = task?.metadata?.workTakeoverEcommerceGrowth?.files;
  if (!regenerate && existing?.folder && fs.existsSync(existing.folder)) {
    return {
      kind: 'ecommerce_growth',
      task,
      files: existing,
      reused: true,
      note: 'Existing ecommerce growth package was reused and remains recorded on the task.',
    };
  }

  const files = getIndustryPackageAdapter('ecommerce_growth').createFiles(taskIndustrySource(task), { outputDirectory });
  const verificationText = readOptionalText(files.verification);
  const customerServiceText = readOptionalText(files.customerServiceRtf);
  const verificationPassed = files.verificationResult.passed;
  const result = [
    `已生成电商/短视频接管交付包：${files.folder}`,
    `商品：${files.brief.productName}`,
    `平台：${files.brief.platform}`,
    `目标：${files.brief.target}`,
    `交付自检：${verificationPassed ? '通过' : '需要复核'}`,
    files.verificationResult.checks
      .filter(check => !check.passed)
      .map(check => `${check.label}：${check.detail}`)
      .join('；'),
    '下一步：用户确认发布口径、账号状态、投放预算和客服发送后，再进入外部平台发布或微信发送。',
  ].map(compact).filter(Boolean).join('\n');

  let updatedTask = updateWorkTakeoverTask(userId, task.id, {
    status: 'waiting_confirmation',
    result,
    allowedNow: uniqueStrings([
      ...task.allowedNow,
      '生成本地电商/短视频交付包',
      '准备发布草稿、图文提示词、视频脚本和客服回复草稿',
      '记录交付自检结果',
    ]),
    confirmationRequired: uniqueStrings([
      ...task.confirmationRequired,
      '正式发布内容',
      '投放扣费或预算消耗',
      '修改价格、库存、商品状态或店铺设置',
      '发送客户/客服/微信消息',
      '首次登录、扫码、验证码、切号或外部平台授权',
    ]),
    metadata: {
      workTakeoverEcommerceGrowth: {
        files,
        verificationText,
        preparedAt: new Date().toISOString(),
      },
    },
    note: `电商/短视频接管交付包已生成，自检${verificationPassed ? '通过' : '需要复核'}。`,
    ...(customerServiceText && !task.drafts?.some((draft: any) => draft.text === customerServiceText) ? { draftReply: customerServiceText } : {}),
  } as any) || task;

  updatedTask = addArtifacts(userId, updatedTask, [
    { type: 'file', label: '电商/短视频接管交付包', path: files.folder, content: result },
    { type: 'document', label: '店铺体检报告', path: files.storeAuditHtml },
    { type: 'document', label: '内容矩阵 CSV', path: files.contentMatrixCsv },
    { type: 'document', label: '内容矩阵 HTML', path: files.contentMatrixHtml },
    { type: 'video', label: '短视频脚本与分镜', path: files.videoScriptRtf },
    { type: 'document', label: '图文种草笔记包', path: files.imageNotesRtf },
    { type: 'document', label: '图片生成提示词', path: files.imagePromptsTxt },
    { type: 'video', label: '视频生成提示词', path: files.videoPromptsTxt },
    { type: 'document', label: '发布草稿/发布确认项', path: files.publishPageHtml },
    { type: 'draft', label: '微信/客服回复草稿', path: files.customerServiceRtf, content: customerServiceText },
    { type: 'document', label: '今日运营战报', path: files.battleReportHtml },
    { type: 'document', label: '外部工具调度台', path: files.toolConsoleHtml },
    { type: 'checklist', label: '电商交付验证记录', path: files.verification, content: verificationText },
    { type: 'file', label: '店铺/账号任务参数', path: files.taskJson },
  ], !verificationPassed);

  return {
    kind: 'ecommerce_growth',
    task: updatedTask,
    files,
    reused: false,
    note: 'Ecommerce growth package generated locally and recorded on the task. Publishing, ad spend, store changes, login, and message sending remain confirmation-gated.',
  };
}

export function prepareWorkTakeoverIndustryPackage(
  userId: string,
  task: WorkTakeoverTask,
  options: { outputDirectory?: string; regenerate?: boolean; kind?: WorkTakeoverIndustryPackageKind | 'auto' } = {},
): WorkTakeoverIndustryPackageResult {
  const kind = options.kind && options.kind !== 'auto'
    ? options.kind
    : packageKindForCategory(task.category);
  if (kind === 'design_delivery') {
    return recordDesignDeliveryPackage(userId, task, options.outputDirectory, options.regenerate === true);
  }
  if (kind === 'ecommerce_growth') {
    return recordEcommerceGrowthPackage(userId, task, options.outputDirectory, options.regenerate === true);
  }
  throw new Error(`No industry package adapter is available for category "${task.category}".`);
}
