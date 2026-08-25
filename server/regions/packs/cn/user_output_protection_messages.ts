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
  genericSummary: '已获取执行结果。为便于阅读并保护本机信息，原始系统数据已省略；我会只汇报与当前任务有关的结论和异常。',
} as const;
