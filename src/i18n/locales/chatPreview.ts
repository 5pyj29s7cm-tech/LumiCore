export function chatPreviewCopy(isZh: boolean) {
  return isZh ? {
    preview: '预览', close: '关闭预览', download: '保存文件', open: '用系统应用打开',
    loading: '正在加载预览…', failed: '无法加载预览。文件可能已移动或删除，也可能当前无权访问。',
    mediaFailed: '当前客户端无法显示或播放这个文件，可以保存后用系统应用打开。',
    retry: '重试', unsupported: '此格式暂不支持在对话内预览，可以保存或用系统应用打开。',
    partial: '这里只展示部分内容，完整内容请打开原文件。',
    extracted: '内容预览：保留文字和表格，完整排版请打开原文件。',
    empty: '没有可展示的文字内容。', zoom: '点击放大或还原图片',
  } : {
    preview: 'Preview', close: 'Close preview', download: 'Save file', open: 'Open in system app',
    loading: 'Loading preview…', failed: 'Cannot load the preview. The file may have moved, been removed, or no longer be accessible.',
    mediaFailed: 'This client cannot display or play this file. Save it or open it in a system app.',
    retry: 'Retry', unsupported: 'This format cannot be previewed here yet. Save it or open it in a system app.',
    partial: 'Showing part of the content. Open the original file for the complete content.',
    extracted: 'Content preview: text and tables. Open the original file for full formatting.',
    empty: 'No text is available to preview.', zoom: 'Click to zoom or fit the image',
  };
}
