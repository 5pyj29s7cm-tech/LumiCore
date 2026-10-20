const HAN_RE = /[\u3400-\u9fff]/u;

/** Reviewable user content; executor prompts and argument envelopes stay internal. */
export function formatPendingConfirmationRequestMessage(input: {
  actionIntent: string;
  target: string;
  safeArgs: Record<string, any>;
  requiresExternalMode?: boolean;
}): string {
  const args = input.safeArgs;
  const zh = HAN_RE.test(input.actionIntent);
  const details: Array<[string, string, unknown]> = [
    ['请求', 'Request', input.actionIntent],
    ['操作', 'Action', args.action || args.operation],
    ['目标', 'Target', input.target || args.filePath],
    ['应用', 'Application', args.target_application || args.application],
    ['账号', 'Account', args.username],
    ['标题', 'Subject', args.subject],
    ['金额', 'Amount', args.amount === undefined ? undefined : [args.amount, args.currency].filter(v => v !== undefined).join(' ')],
    ['内容', 'Content', args.message ?? args.text ?? args.body ?? args.content ?? args.contentSummary?.preview],
    ['命令', 'Command', args.command],
    ['修改文件', 'Changed files', args.patchReview?.changedPaths || args.expectedChangedPaths],
    ['修改内容', 'Changes', args.patchReview?.fullPatch],
    ['仓库', 'Repository', args.expectedRepositoryId],
    ['交付分支', 'Delivery branch', args.expectedDeliveryBranch],
    ['基础版本', 'Base revision', args.expectedBaseCommit],
    ['待启用版本', 'Revision to activate', args.expectedStagedCommit],
    ['版本内容指纹', 'Revision fingerprint', args.expectedTreeDigest],
  ];
  return [
    input.requiresExternalMode
      ? (zh ? '这项操作需要使用外部桌面软件。确认后将切换到外部执行模式并完成这一次操作；后续桌面任务默认使用外部模式。危险操作仍需另行确认。' : 'This action needs external desktop software. Confirm to select External execution and run this exact action; subsequent desktop work will default to External. Sensitive actions still require their own confirmation.')
      : (zh ? '请确认下面的操作，确认后我才会执行。' : 'Confirmation is required before the following action can run.'),
    ...details.filter(([, , value]) => (typeof value === 'string' && value.trim()) || Array.isArray(value))
      .map(([cn, en, value]) => `${zh ? cn : en}: ${Array.isArray(value) ? value.join(', ') : value}`),
    zh ? '请回复“确认”执行这一次操作，或回复“取消”停止。' : 'Reply “confirm” to run this action once, or “cancel” to stop.',
  ].join('\n');
}
