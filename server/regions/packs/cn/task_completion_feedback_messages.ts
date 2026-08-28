import type {
  TaskCompletionFeedback,
  TaskTerminalReceipt,
} from '../../../cognition/acceptance_evidence';

function compactList(values: string[], limit = 4): string {
  return values.filter(Boolean).slice(0, limit).join('；');
}

export function formatCnTaskCompletionFeedback(
  baseText: string,
  taskLabel: string,
  feedback: TaskCompletionFeedback,
  receipt?: TaskTerminalReceipt | null,
): string {
  const status = feedback.status === 'completed'
    ? '已验证完成'
    : feedback.status === 'working'
      ? '仍在执行'
      : feedback.status === 'cancelled'
        ? '已取消'
        : '未完成';
  const evidence = [
    ...(receipt?.toolNames?.length ? [`工具终态回执：${receipt.toolNames.join('、')}`] : []),
    ...(receipt?.receiptId ? [`验收回执：${receipt.receiptId}`] : []),
  ];
  const lines = [String(baseText || '').trim(), '', '执行回馈', `- 状态：${status}`];
  if (feedback.status === 'completed') lines.push(`- 完成项：${taskLabel}`);
  if (evidence.length > 0) lines.push(`- 证据：${compactList(evidence)}`);
  if (feedback.status !== 'completed') lines.push(`- 未完成项：${taskLabel}`);
  if (feedback.blockers.length > 0) lines.push(`- 阻塞原因：${compactList(feedback.blockers)}`);
  if (feedback.status !== 'completed' && feedback.status !== 'cancelled') {
    lines.push('- 下一步：目标、计划和已有回执均已保留；Lumi 将从尚未验证的步骤继续，不会重复已确认的外部副作用。');
  }
  return lines.filter((line, index) => line || index > 0).join('\n').trim();
}
