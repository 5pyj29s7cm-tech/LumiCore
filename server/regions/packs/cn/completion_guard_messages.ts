function issue(detail: string): string {
  const clean = String(detail || '').trim().replace(/[。；;]+$/u, '');
  return clean ? `：${clean}` : '';
}

function retained(hasVerifiedProgress: boolean): string {
  return hasVerifiedProgress ? '已经完成的部分会保留，' : '';
}

export const CN_COMPLETION_GUARD_MESSAGES = {
  promiseClient: (detail: string) => `刚才没能完成这个客户端操作${issue(detail)}。这项要求仍然保留，可以从这里重试。`,
  promiseDesktop: (detail: string) => `刚才没能完成这个桌面操作${issue(detail)}。重新确认目标后，可以从这一步重试。`,
  confirmation: (detail: string) => `还差你的确认${issue(detail)}。在客户端确认后会接着执行。`,
  promiseGeneric: (detail: string) => `刚才没能开始这项操作${issue(detail)}。这项要求仍然保留，可以从这里重试。`,
  statusNotStarted: (detail: string) => `这项操作还没有开始${issue(detail)}。可以从这里重试。`,
  blockedDesktop: (detail: string, hasVerifiedProgress: boolean) => (
    `这个桌面操作还没完成${issue(detail)}。${retained(hasVerifiedProgress)}重新确认目标后可以从这里重试。`
  ),
  blockedClient: (detail: string, hasVerifiedProgress: boolean) => (
    `这个客户端操作还没完成${issue(detail)}。${retained(hasVerifiedProgress)}可以从这里重试。`
  ),
  blockedGeneric: (detail: string, hasVerifiedProgress: boolean) => (
    `这项操作还没完成${issue(detail)}。${retained(hasVerifiedProgress)}可以从这里重试。`
  ),
} as const;
