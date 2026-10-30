/** Customer-facing input and execution-checkpoint copy. Recognition stays with its domain owner. */
export const COMPLETENESS_BOUNDARY_MESSAGES = {
  zh: {
    contextCapacity: '这轮需要保留的内容超出了可处理容量，暂时没能生成完整回答。已有聊天内容保留。可以减少同时处理的材料，或在新聊天中继续。',
    modelDeadline: '等待模型结果超时，本次回答尚未完成；已经取得的结果保留。',
    missingSource: (source: string, name: string, folder: string, absolute: boolean) => {
      const location = folder === 'Desktop' ? '桌面' : folder === 'Downloads' ? '下载目录' : '文档目录';
      return (!absolute ? '没有在' + location + '找到“' + name + '”' : '没有找到这项任务需要的源文件：' + source)
        + '，暂时无法完成这项文件处理。请补齐文件或提供正确路径。';
    },
  },
  en: {
    contextCapacity: 'The content that must be retained exceeds the available processing capacity, so a complete answer was not produced. Existing conversation content is retained. Reduce the material handled together or continue in a new chat.',
    modelDeadline: 'The model response timed out. This request remains incomplete; verified results are retained.',
    missingSource: (source: string) => 'The required source file was not found: ' + source + '\nSupply the file or correct its path before continuing.',
  },
};
