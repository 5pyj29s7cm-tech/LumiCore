const HAN_RE = /[\u3400-\u9fff]/u;

export function formatPendingConfirmationRequestMessage(input: {
  actionIntent: string;
  toolName: string;
  target: string;
  payloadDigest: string;
  safeArgs: Record<string, any>;
}): string {
  const details = JSON.stringify(input.safeArgs);
  if (HAN_RE.test(input.actionIntent)) {
    return [
      '这项操作还没有执行，需要你确认后才能继续。',
      `操作：${input.toolName}`,
      `目标：${input.target || '当前已核验目标'}`,
      `内容摘要：${input.payloadDigest}`,
      `参数：${details}`,
      '如果目标和内容正确，请回复“确认”；如果不正确，请回复“取消”。',
    ].join('\n');
  }
  return [
    'Confirmation is required before this action can run.',
    `Action: ${input.toolName}`,
    `Target: ${input.target || 'current verified target'}`,
    `Payload digest: ${input.payloadDigest}`,
    `Arguments: ${details}`,
    'Reply “confirm” to run this exact action once, or “cancel” to stop.',
  ].join('\n');
}
