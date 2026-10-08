export function fileLocationCopy(isZh: boolean) {
  return isZh ? {
    savedAt: '已保存位置', openFolder: '打开所在文件夹', openDownloads: '打开下载文件夹',
    desktopDownloadHint: '下载副本默认保存在系统“下载”文件夹；另存时以所选目录为准。',
    browserDownloadHint: '下载副本保存在浏览器设置的下载目录，或另存时选择的目录。',
    failed: '无法打开文件夹，请确认文件仍在本机。',
  } : {
    savedAt: 'Saved location', openFolder: 'Open containing folder', openDownloads: 'Open Downloads folder',
    desktopDownloadHint: 'Downloaded copies use the system Downloads folder by default, or the location chosen when saving.',
    browserDownloadHint: 'Downloaded copies use your browser download directory, or the location chosen when saving.',
    failed: 'Could not open the folder. Check that the file is still on this computer.',
  };
}
