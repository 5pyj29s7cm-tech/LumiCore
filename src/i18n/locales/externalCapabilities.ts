import { getLocale, type Locale } from '../runtime';

const EXTERNAL_CAPABILITY_COPY = {
  en: {
    intakeAction: 'Connect external tool',
    intakeTitle: 'Review an external capability',
    intakeDescription: 'Import or paste a reviewed capability proposal. Nothing is activated until the exact proposal passes server review and you confirm it.',
    jsonLabel: 'Capability proposal JSON',
    jsonPlaceholder: 'Paste the reviewed capability package JSON here…',
    importJson: 'Import JSON',
    importedFile: (name: string) => `Imported ${name}`,
    invalidJson: 'Enter a valid JSON object before review.',
    reviewAction: 'Run preflight review',
    reviewing: 'Reviewing…',
    reviewTitle: 'Preflight review',
    summary: 'Summary',
    documents: 'Documentation',
    permissions: 'Permissions',
    actions: 'Actions',
    runtime: 'Runtime',
    warnings: 'Warnings',
    noneDeclared: 'None declared',
    executable: 'Executable',
    notExecutable: 'Not executable',
    confirmationRequired: 'Confirmation required',
    approvalExpires: (value: string) => `Approval expires ${value}`,
    activateAction: 'Confirm and activate',
    activating: 'Activating…',
    activationConfirm: (name: string) => `Activate the exact reviewed capability “${name}”? Its permissions and actions will become available to LumiCore.`,
    reviewReady: 'Preflight review completed. Inspect the evidence before activation.',
    activated: (name: string) => `${name} was activated and added to LumiCore.`,
    deactivateAction: 'Deactivate',
    deactivating: 'Deactivating…',
    deactivationConfirm: (name: string) => `Deactivate “${name}”? LumiCore and its desktop launcher will no longer be able to use this capability.`,
    deactivated: (name: string) => `${name} was deactivated and removed from LumiCore.`,
    close: 'Close',
    reviewedCapabilities: 'Reviewed external capabilities',
    reviewedCapabilitiesDescription: 'These entries are the same capability projection used by LumiCore and desktop launchers.',
    noReviewedCapabilities: 'No reviewed external capabilities are active yet.',
    refresh: 'Refresh',
    unavailableReason: 'Unavailable reason',
    whenToUse: 'When Lumi should use it',
    workflowSteps: 'Workflow steps',
    completionRules: 'Completion rules',
    actionCount: (count: number) => `${count} action${count === 1 ? '' : 's'}`,
    verifiedAt: (value: string) => `Verified ${value}`,
    verifiedRuns: (count: number) => `${count} verified run${count === 1 ? '' : 's'}`,
    stage: {
      configured: 'Configured', connected: 'Connected', verified: 'Tested', automatic: 'Automatic', unknown: 'Unknown stage',
    },
    availability: { ready: 'Ready', unavailable: 'Temporarily unavailable', unknown: 'Availability unknown' },
    verification: { never: 'Not tested', verified: 'Verified', unverified: 'Unverified', failed: 'Failed' },
    launchConfirm: (name: string) => `Launch ${name}?`,
    launchCompleted: (name: string) => `A launch action was sent to ${name}, and its execution result was recorded.`,
    loadFailed: 'Reviewed capabilities could not be loaded.',
  },
  zh: {
    intakeAction: '接入外部工具',
    intakeTitle: '审核外部能力',
    intakeDescription: '导入或粘贴经过整理的能力提案。只有服务端完成预审并由你确认后，能力才会激活。',
    jsonLabel: '能力提案 JSON',
    jsonPlaceholder: '在这里粘贴待审核的能力包 JSON…',
    importJson: '导入 JSON',
    importedFile: (name: string) => `已导入 ${name}`,
    invalidJson: '请先提供有效的 JSON 对象。',
    reviewAction: '开始预审',
    reviewing: '正在预审…',
    reviewTitle: '预审结果',
    summary: '能力摘要',
    documents: '资料与文档',
    permissions: '权限范围',
    actions: '可用动作',
    runtime: '接入方式',
    warnings: '审核提醒',
    noneDeclared: '未声明',
    executable: '可执行',
    notExecutable: '不可执行',
    confirmationRequired: '执行前需确认',
    approvalExpires: (value: string) => `本次审核授权有效期至 ${value}`,
    activateAction: '确认并激活',
    activating: '正在激活…',
    activationConfirm: (name: string) => `确认激活已审核的“${name}”吗？其声明的权限与动作将提供给 LumiCore。`,
    reviewReady: '预审已完成，请核对证据后再激活。',
    activated: (name: string) => `“${name}”已激活并加入 LumiCore。`,
    deactivateAction: '停用',
    deactivating: '正在停用…',
    deactivationConfirm: (name: string) => `确认停用“${name}”吗？LumiCore 和桌面启动入口将不再能够使用此能力。`,
    deactivated: (name: string) => `“${name}”已停用并从 LumiCore 移除。`,
    close: '关闭',
    reviewedCapabilities: '已审核外部能力',
    reviewedCapabilitiesDescription: '这里与 LumiCore 自动调用及桌面启动入口使用同一份能力投影。',
    noReviewedCapabilities: '目前没有已激活的外部能力。',
    refresh: '刷新',
    unavailableReason: '不可用原因',
    whenToUse: 'Lumi 何时使用',
    workflowSteps: '执行步骤',
    completionRules: '完成标准',
    actionCount: (count: number) => `${count} 个动作`,
    verifiedAt: (value: string) => `验证于 ${value}`,
    verifiedRuns: (count: number) => `${count} 次已验证运行`,
    stage: {
      configured: '已配置', connected: '已连接', verified: '已实测', automatic: '可自动执行', unknown: '阶段未知',
    },
    availability: { ready: '可用', unavailable: '暂时失效', unknown: '可用性未知' },
    verification: { never: '尚未实测', verified: '已验证', unverified: '未验证', failed: '验证失败' },
    launchConfirm: (name: string) => `确认启动“${name}”吗？`,
    launchCompleted: (name: string) => `已向“${name}”发送启动动作，并记录本次执行结果。`,
    loadFailed: '无法读取已审核能力。',
  },
} as const;

export function externalCapabilityCopy(locale: Locale = getLocale()) {
  return EXTERNAL_CAPABILITY_COPY[locale];
}

export function externalCapabilityStageLabel(stage: string, locale: Locale = getLocale()): string {
  const copy = externalCapabilityCopy(locale);
  const key = String(stage || '').toLowerCase() as keyof typeof copy.stage;
  return copy.stage[key] || copy.stage.unknown;
}

export function externalCapabilityAvailabilityLabel(availability: string, locale: Locale = getLocale()): string {
  const copy = externalCapabilityCopy(locale);
  const key = String(availability || '').toLowerCase() as keyof typeof copy.availability;
  return copy.availability[key] || copy.availability.unknown;
}

export function externalCapabilityVerificationLabel(status: string, locale: Locale = getLocale()): string {
  const copy = externalCapabilityCopy(locale);
  const key = String(status || '').toLowerCase() as keyof typeof copy.verification;
  return copy.verification[key] || copy.verification.unverified;
}
