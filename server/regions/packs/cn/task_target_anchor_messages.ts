export const CN_TASK_TARGET_ANCHOR_MESSAGES = {
  inspectActiveDocument: '请先把要分析的 WPS 文档切到前台，或告诉我最终文件名（含扩展名）。',
  locateNamedFile: (fileName: string) => (
    `我已识别文件名 ${fileName}，但还需在桌面、文档、下载或你指定的目录中锁定它的完整路径。`
  ),
  unresolvedTarget: '我还没有锁定你要分析的文件。请告诉我最终文件名（含扩展名）或具体位置。',
} as const;
