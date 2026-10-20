export const CN_USER_OUTPUT_PROTECTION_MESSAGES = {
  screenVisionIncomplete: '已获取屏幕画面，但视觉识别没有完成，因此暂时无法可靠判断画面内容。原始图像数据已省略。',
  screenCaptured: '已获取屏幕画面。原始图像数据已省略；需要时我会直接说明画面中的关键信息。',
  directoryExamples: (count: number, examples: string[]) => (
    `已读取目录${count ? `，识别到 ${count} 项` : ''}。示例：${examples.join('、')}。原始路径和系统字段已省略。`
  ),
  directoryRead: '已读取目录。原始路径和系统字段已省略；需要时我可以按文件名或类型整理。',
  processExamples: (examples: string[]) => (
    `已检查运行中的程序。可见示例：${examples.join('、')}。原始进程表和系统字段已省略。`
  ),
  processesChecked: '已检查运行中的程序。原始进程表和系统字段已省略；需要时我可以只列出相关程序。',
  savedFiles: (files: string[], failed: boolean) => `已保存文件：${files.join('、')}。${failed ? '部分步骤失败，尚不能确认整项任务完成。' : '目前只确认这些文件已生成，是否完成任务需核对你要求的交付物。'}`,
  genericSummary: '这次未能给出可确认的结果。',
  failedSummary: '执行中有步骤失败，目前不能确认任务完成。原始系统数据已省略。',
} as const;
