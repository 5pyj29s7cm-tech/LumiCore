export interface DesktopControlPausePresentation {
  text: string;
  reason: string;
}

/** One public presentation for the physical-input desktop pause boundary. */
export function formatDesktopControlPausePresentation(taskText: string): DesktopControlPausePresentation {
  if (/[\u3400-\u9fff]/.test(taskText)) {
    return {
      text: '我注意到你正在操作电脑，所以先暂停了桌面操作。当前任务和已完成步骤都已保留；你准备好后说“继续”即可。',
      reason: 'desktop_control_paused_for_user_activity',
    };
  }
  return {
    text: 'I noticed that you are using the computer, so I paused desktop control. The task and completed steps are preserved; say “continue” when you are ready.',
    reason: 'desktop_control_paused_for_user_activity',
  };
}
