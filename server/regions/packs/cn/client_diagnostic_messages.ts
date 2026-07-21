export interface ClientDiagnosticFacts {
  hasSuccessfulSubstantiveCheck: boolean;
  hasLiveState: boolean;
  healthLevel: string;
  stateAgeSeconds: number | null;
  scopeDomain: string;
  scopeOrgId: string;
  stateDigest: Record<string, any> | null;
  findings: string[];
  disconnectedSkills: string[];
  successfulChecks: string[];
  failedChecks: string[];
  repairResults: string[];
  activeWindow: string;
  processCount: number | null;
}

export const CN_CLIENT_DIAGNOSTIC_MESSAGES = {
  checking: '我在检查客户端和运行链路，马上告诉你结果。',
} as const;

export function formatCnMissingClientDiagnosticReceipts(): string {
  return '本轮没有取得任何客户端自检工具回执，因此不能判断桌面、技能或运行时状态。';
}

export function formatCnClientDiagnosticFacts(facts: ClientDiagnosticFacts): string {
  const lines = [facts.hasSuccessfulSubstantiveCheck
    ? '自检完成。以下只采用本轮真实工具回执，不沿用此前聊天里的状态说法。'
    : '自检未完成。本轮没有任何成功的实质性客户端自检回执。'];
  const scope = facts.scopeDomain === 'work'
    ? `组织工作域${facts.scopeOrgId ? `（${facts.scopeOrgId}）` : ''}`
    : '个人域';
  lines.push(`检查作用域：${scope}。`);

  if (facts.hasLiveState) {
    const digest = facts.stateDigest || {};
    const details = [
      digest.mode ? `模式=${digest.mode}` : '',
      digest.activeTab ? `界面=${digest.activeTab}` : '',
      digest.focusedWindow ? `焦点=${digest.focusedWindow}` : '',
      facts.stateAgeSeconds != null ? `状态年龄=${facts.stateAgeSeconds}秒` : '',
    ].filter(Boolean);
    lines.push(`桌面客户端状态：已取得实时状态${details.length ? `（${details.join('，')}）` : ''}。`);
  } else {
    lines.push('桌面客户端状态：当前作用域没有取得实时状态。');
    lines.push('这只说明本轮作用域或设备路由没有匹配，不能据此断言“微信天然看不到桌面”或“桌面客户端已经下线”。');
  }

  lines.push(`健康等级：${facts.healthLevel || 'unknown'}。`);
  if (facts.activeWindow) lines.push(`活动窗口：${facts.activeWindow}。`);
  if (facts.processCount != null) lines.push(`进程读取：${facts.processCount} 条。`);
  if (facts.findings.length) lines.push(`健康发现：${facts.findings.join('；')}。`);
  if (facts.failedChecks.length) lines.push(`未完成的检查：${facts.failedChecks.join('；')}。`);
  if (facts.repairResults.length) lines.push(`修复回执：${facts.repairResults.join('；')}。`);
  if (facts.disconnectedSkills.length) {
    lines.push(`可选技能当前未连接：${facts.disconnectedSkills.join('、')}。未连接不等于核心故障，也不能在没有回执时猜测具体原因。`);
  }
  if (facts.successfulChecks.length) lines.push(`本轮有回执的检查：${facts.successfulChecks.join('、')}。`);
  return lines.join('\n');
}
