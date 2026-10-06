export const CN_STREAM_INTERRUPTION_RECOVERY_INSTRUCTION =
  '上一条是流式连接中断前的草稿。请基于用户原请求完整重写最终回答，补齐遗漏内容；只输出可直接交付给用户的最终回答。';

export function formatConversationIncompleteMessage(taskText: string): string {
  return /[\u3400-\u9fff]/u.test(taskText)
    ? '这次没有生成完整、符合要求的回答，请再试一次。'
    : 'I could not produce a complete answer that meets your request. Please try again.';
}

export function formatCnSentenceCountCorrectionInstruction(expected: number): string {
  return `重写上一条回答，完整满足用户要求。最终回答必须严格为 ${expected} 句话：不能少答任何问题，也不能增加第 ${expected + 1} 句话。只输出重写后的最终回答。`;
}
