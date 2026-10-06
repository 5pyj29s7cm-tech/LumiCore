import type { WorkTakeoverResultVerification } from "../../work_takeover/result_verifier";

export const cnWorkTakeoverMessages = {
  verificationLabel: '任务结果验证记录',
  packetLabel: '工作接管任务包',
  toolFailed: (name: string, error: string) => `工具 ${name} 执行失败：${error}`,
  toolExecuted: (name: string, result: string) => `工具 ${name} 已执行。\n${result}`,
  toolResultLabel: (name: string) => `工具执行结果：${name}`,
};

export function formatCnWorkTakeoverVerification(verification: WorkTakeoverResultVerification): string {
  return [
    verification.summary,
    '',
    ...verification.checks.map(item => `- ${item.passed ? '通过' : '待复核'}｜${item.label}：${item.detail}`),
    verification.activeWindow
      ? `\n活动窗口：${verification.activeWindow.processName} ${verification.activeWindow.title}`
      : '\n活动窗口：未读取',
    verification.screen?.captured
      ? `屏幕截图：${verification.screen.width || '?'}x${verification.screen.height || '?'} ${verification.screen.format || ''}`.trim()
      : '屏幕截图：未读取',
    verification.detectedSurfaces.length
      ? `检测到的外部表面：${verification.detectedSurfaces.join('、')}`
      : '检测到的外部表面：暂无',
  ].join('\n');
}
