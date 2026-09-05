import type {
  TaskCompletionFeedback,
  TaskTerminalReceipt,
} from '../../../cognition/acceptance_evidence';

export function formatCnTaskCompletionFeedback(
  baseText: string,
  taskLabel: string,
  feedback: TaskCompletionFeedback,
  _receipt?: TaskTerminalReceipt | null,
): string {
  const text = String(baseText || '').trim();
  if (feedback.status === 'completed') {
    return text || `“${taskLabel}”已经完成。`;
  }
  if (feedback.status === 'cancelled') {
    return text || `“${taskLabel}”已经停下。`;
  }
  if (feedback.status === 'working') {
    return text || `正在处理“${taskLabel}”。`;
  }
  const blocker = feedback.blockers.find(Boolean)?.trim();
  if (text) return text;
  return blocker
    ? `“${taskLabel}”还没完成：${blocker.replace(/[。！？!?]+$/u, '')}。可以从这里重试。`
    : `“${taskLabel}”还没完成。可以从这里重试。`;
}
