export const CN_REPORTED_EXECUTION_MESSAGES = {
  priorDiagnostic: '没有可核实的客户端自检工具回执，不能把本轮检查说成之前做过的自检。',
  missingDiagnostic: (names: string[]) => `没有找到这些检查的成功记录：${names.join('、')}。目前不能确认检查已完成。`,
  ended: '本轮操作已经结束，没有证据表明所说的后续操作正在执行。',
  ledgerOnly: '当前记录只证明了记账或状态写回，没有真实动作的已验证终态回执，任务执行尚未完成。',
  unverified: {
    send: '没有取得发送成功的确认，目前不能确认消息或文件已经发出。',
    open: '没有确认目标已经打开，确认目标后可以重试。',
    playback: '没有确认播放器达到了你要求的状态。',
    configuration: '还没有读取当前语音或模型配置，不能确认当前使用的配置。',
    reminder: '没有记录到提醒创建成功的结果，不能承诺会按时提醒。',
  },
} as const;
