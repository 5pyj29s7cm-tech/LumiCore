export const desktopExecutionRecoveryCopy = {
  zh: {
    title: '桌面操作的停止状态尚未确认',
    detail: 'Lumi 正在向原桌面查询结果，暂不开始下一项操作。',
    inspect: '检查并恢复',
    confirmTitle: '确认原操作已停止',
    confirmMessage: '请先检查原桌面，并停止仍在运行的操作。确认仅允许后续操作继续；原任务仍记为结果未知，不会被标记为成功。',
    confirm: '我已检查并停止该操作，允许继续',
    cancel: '继续等待自动核对',
    waitNative: '原生命令尚未形成可确认的终态，请先停止原操作并等待结果核对。',
  },
  en: {
    title: 'Desktop action stop is not confirmed',
    detail: 'Lumi is checking the original desktop. Further actions are held.',
    inspect: 'Check and resume',
    confirmTitle: 'Confirm the original action has stopped',
    confirmMessage: 'Check the original desktop and stop any remaining operation first. Confirming only allows later actions; the original task remains outcome unknown and will not be marked successful.',
    confirm: 'I checked and stopped the action; allow continuing',
    cancel: 'Wait for automatic verification',
    waitNative: 'The native command has not reached an acknowledgeable terminal. Stop the original operation and wait for reconciliation.',
  },
};
