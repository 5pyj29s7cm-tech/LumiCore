import fs from 'fs';
import os from 'os';
import path from 'path';
import { planWorkTakeoverExecution, type WorkTakeoverExecutionPlan } from './execution_planner';
import type { WorkTakeoverArtifact, WorkTakeoverTask } from './tasks';

export interface WorkTakeoverPacketFile {
  label: string;
  path: string;
  type: WorkTakeoverArtifact['type'] | 'json';
  bytes: number;
}

export interface WorkTakeoverPacket {
  packetId: string;
  createdAt: string;
  taskId: string;
  folderPath: string;
  files: WorkTakeoverPacketFile[];
  summary: string;
}

function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeSegment(value: string, fallback: string): string {
  const safe = compact(value)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.+$/g, '')
    .slice(0, 50);
  return safe || fallback;
}

function desktopDirectory(): string {
  const candidates = [
    path.join(os.homedir(), 'Desktop'),
    process.env.OneDrive ? path.join(process.env.OneDrive, 'Desktop') : '',
    path.join(os.homedir(), 'OneDrive', 'Desktop'),
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || path.join(os.homedir(), 'Desktop');
}

function resolveOutputRoot(outputDirectory?: string): string {
  if (!outputDirectory) return desktopDirectory();
  const expanded = outputDirectory.replace(/^~(?=$|[\\/])/, os.homedir());
  return path.resolve(expanded);
}

function dateStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function mdList(items: string[], empty = '暂无'): string {
  const clean = items.map(compact).filter(Boolean);
  return clean.length ? clean.map(item => `- ${item}`).join('\n') : `- ${empty}`;
}

function mdTable(rows: Array<[string, string]>): string {
  return [
    '| 项目 | 内容 |',
    '| --- | --- |',
    ...rows.map(([k, v]) => `| ${k} | ${compact(v).replace(/\|/g, '\\|') || '暂无'} |`),
  ].join('\n');
}

function renderTaskSummary(task: WorkTakeoverTask, plan: WorkTakeoverExecutionPlan): string {
  const industryParameters = task.metadata?.industryParameters;
  return [
    `# ${task.title}`,
    '',
    mdTable([
      ['任务ID', task.id],
      ['分类', task.category],
      ['状态', task.status],
      ['紧急度', task.urgency],
      ['来源', task.source],
      ['联系人', task.contact || ''],
      ['推荐工作流', task.recommendedWorkflow || ''],
      ['生成时间', new Date().toLocaleString('zh-CN')],
    ]),
    '',
    '## 目标摘要',
    '',
    task.summary || task.sourceMessage || plan.objective || '暂无摘要。',
    '',
    '## 原始消息',
    '',
    task.sourceMessage || '暂无原始消息。',
    '',
    '## 行业任务参数',
    '',
    industryParameters && typeof industryParameters === 'object'
      ? renderIndustryParameters(industryParameters)
      : '暂无结构化行业参数。',
    '',
    '## 当前可做',
    '',
    mdList(plan.safeActions),
    '',
    '## 确认边界',
    '',
    mdList(plan.confirmationRequired, '暂无额外确认边界'),
    '',
    '## 当前阻塞',
    '',
    mdList(plan.blockers, '暂无阻塞'),
  ].join('\n');
}

function renderIndustryParameters(params: any): string {
  const lines = Array.isArray(params.summaryLines) ? params.summaryLines : [];
  const required = Array.isArray(params.requiredArtifactLabels) ? params.requiredArtifactLabels : [];
  const terms = Array.isArray(params.expectedContentTerms) ? params.expectedContentTerms : [];
  return [
    lines.length ? mdList(lines) : '暂无摘要参数。',
    '',
    '### 交付要求',
    '',
    mdList(required, '暂无参数化交付要求'),
    '',
    '### 验收关键词',
    '',
    mdList(terms, '暂无验收关键词'),
  ].join('\n');
}

function renderPlan(plan: WorkTakeoverExecutionPlan): string {
  const steps = plan.steps.map((step, index) => [
    `## ${index + 1}. ${step.title}`,
    '',
    step.goal,
    '',
    `状态：${step.status}`,
    '',
    '建议工具：',
    mdList(step.suggestedTools, '暂无建议工具'),
    '',
    '预期交付物：',
    mdList(step.expectedArtifacts, '暂无预期交付物'),
    '',
    '确认边界：',
    mdList(step.confirmationRequired, '暂无当前步骤确认边界'),
  ].join('\n')).join('\n\n');

  return [
    `# 接管执行计划`,
    '',
    `计划ID：${plan.planId}`,
    '',
    `目标：${plan.objective}`,
    '',
    '## 能力组合',
    '',
    mdList(plan.capabilities.map(capability => `${capability.label} (${capability.id})：${capability.reason || '基础能力'}`)),
    '',
    '## 执行步骤',
    '',
    steps || '暂无执行步骤。',
    '',
    '## 给 Lumi 的下一步提示',
    '',
    plan.handoffPrompt,
  ].join('\n');
}

function renderArtifacts(task: WorkTakeoverTask): string {
  const artifactLines = task.artifacts.map((artifact, index) => [
    `## ${index + 1}. ${artifact.label}`,
    '',
    mdTable([
      ['类型', artifact.type],
      ['状态', artifact.status],
      ['路径', artifact.path || ''],
      ['创建时间', artifact.createdAt],
      ['更新时间', artifact.updatedAt],
    ]),
    '',
    artifact.content ? `### 内容\n\n${artifact.content}` : '',
  ].filter(Boolean).join('\n'));

  return [
    '# 交付物清单',
    '',
    artifactLines.length ? artifactLines.join('\n\n') : '暂无交付物。',
  ].join('\n');
}

function renderDrafts(task: WorkTakeoverTask): string {
  const drafts = task.drafts.map((draft, index) => [
    `## ${index + 1}. ${draft.channel} 草稿`,
    '',
    mdTable([
      ['状态', draft.status],
      ['创建时间', draft.createdAt],
      ['更新时间', draft.updatedAt],
    ]),
    '',
    draft.text,
  ].join('\n'));

  return [
    '# 沟通草稿',
    '',
    drafts.length ? drafts.join('\n\n') : '暂无沟通草稿。',
    '',
    '> 默认不自动发送。发送微信、邮件、平台消息或任何对外承诺前需要用户确认。',
  ].join('\n');
}

function renderVerification(task: WorkTakeoverTask, plan: WorkTakeoverExecutionPlan): string {
  return [
    '# 验证与风险',
    '',
    '## 验证清单',
    '',
    mdList(plan.verificationChecklist),
    '',
    '## 风险',
    '',
    mdList(task.risks, '暂无风险'),
    '',
    '## 确认事项',
    '',
    mdList(task.confirmationRequired, '暂无确认事项'),
    '',
    '## 最新结果',
    '',
    task.result || '暂无结果记录。',
  ].join('\n');
}

function writePacketFile(folderPath: string, name: string, label: string, type: WorkTakeoverPacketFile['type'], content: string): WorkTakeoverPacketFile {
  const filePath = path.join(folderPath, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return {
    label,
    path: filePath,
    type,
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

export function exportWorkTakeoverPacket(
  task: WorkTakeoverTask,
  options: { outputDirectory?: string; plan?: WorkTakeoverExecutionPlan } = {},
): WorkTakeoverPacket {
  const plan = options.plan || planWorkTakeoverExecution(task);
  const root = resolveOutputRoot(options.outputDirectory);
  const folderName = `Lumi-工作接管任务包-${safeSegment(task.title, task.category)}-${dateStamp()}`;
  const folderPath = path.join(root, folderName);
  fs.mkdirSync(folderPath, { recursive: true });

  const files: WorkTakeoverPacketFile[] = [];
  files.push(writePacketFile(folderPath, '00-任务摘要.md', '任务摘要', 'document', renderTaskSummary(task, plan)));
  files.push(writePacketFile(folderPath, '01-执行计划.md', '执行计划', 'document', renderPlan(plan)));
  files.push(writePacketFile(folderPath, '02-交付物清单.md', '交付物清单', 'checklist', renderArtifacts(task)));
  files.push(writePacketFile(folderPath, '03-沟通草稿.md', '沟通草稿', 'draft', renderDrafts(task)));
  files.push(writePacketFile(folderPath, '04-验证与风险.md', '验证与风险', 'checklist', renderVerification(task, plan)));
  files.push(writePacketFile(folderPath, 'task.json', '任务结构化数据', 'json', JSON.stringify({ task, plan }, null, 2)));

  return {
    packetId: `wt_packet_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    taskId: task.id,
    folderPath,
    files,
    summary: `已生成工作接管任务包：${folderPath}`,
  };
}
