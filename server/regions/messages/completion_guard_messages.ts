function retained(hasVerifiedProgress: boolean): string {
  return hasVerifiedProgress ? '已经完成的部分会保留，' : '';
}

export const CN_COMPLETION_GUARD_MESSAGES = {
  unknownOutcome: () => '执行结果尚未确认。请先核对这次操作的回执，再决定后续处理。',
  incompleteTargets: (targets: string[], hasVerifiedProgress: boolean) => (
    `尚未完成：${targets.join('；')}。${retained(hasVerifiedProgress)}可以继续处理剩余步骤。`
  ),
  promiseClient: () => `刚才没能完成这个客户端操作。这项要求仍然保留，可以从这里重试。`,
  promiseDesktop: () => `刚才没能完成这个桌面操作。重新确认目标后，可以从这一步重试。`,
  confirmation: () => `还差你的确认。在客户端确认后会接着执行。`,
  promiseGeneric: () => `刚才没能开始这项操作。这项要求仍然保留，可以从这里重试。`,
  statusNotStarted: () => `这项操作还没有开始。可以从这里重试。`,
  blockedDesktop: (hasVerifiedProgress: boolean) => (
    `这个桌面操作还没完成。${retained(hasVerifiedProgress)}重新确认目标后可以从这里重试。`
  ),
  blockedClient: (hasVerifiedProgress: boolean) => (
    `这个客户端操作还没完成。${retained(hasVerifiedProgress)}可以从这里重试。`
  ),
  blockedGeneric: (hasVerifiedProgress: boolean) => (
    `这项操作还没完成。${retained(hasVerifiedProgress)}可以从这里重试。`
  ),
} as const;
