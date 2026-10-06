const HAN_RE = /[\u3400-\u9fff]/u;

function usesChinese(userText: string): boolean {
  return HAN_RE.test(String(userText || ''));
}

export function formatDesktopProcessCount(
  userText: string,
  entryCount: number,
  processNames: string[],
): string {
  const listedNames = processNames.slice(0, 8);
  if (usesChinese(userText)) {
    return `当前快照读取到 ${entryCount} 个活跃进程条目，涉及 ${processNames.length} 个进程名称${listedNames.length ? `：${listedNames.join('、')}` : ''}。这是当前采样；一个软件可能有多个进程，而且结果有数量上限，因此不能据此得出正在运行的软件总数或窗口总数。`;
  }
  return `The current snapshot contains ${entryCount} active process entries across ${processNames.length} process names${listedNames.length ? `, including ${listedNames.join(', ')}` : ''}. One app can own several processes and the result is bounded, so this is not the total number of running apps or open windows.`;
}

export function formatInternalDispatchUnavailable(chinese: boolean): string {
  return chinese
    ? '这次内部调度没有形成可用结果。'
    : 'The internal dispatch did not produce a usable result.';
}

export function formatArtifactCreatedOpenFailed(
  userText: string,
  path: string,
  verified: boolean,
  failure: string,
): string {
  if (usesChinese(userText)) {
    return `文件已创建${verified ? '并验证' : ''}：${path}\n自动打开没有完成：${failure}`;
  }
  return `The file was created${verified ? ' and verified' : ''}: ${path}\nAutomatic opening did not complete: ${failure}`;
}

export function formatArtifactCreatedAndOpened(
  userText: string,
  path: string,
  verified: boolean,
): string {
  return usesChinese(userText)
    ? `文件已创建${verified ? '、验证' : ''}并打开：${path}`
    : `The file was created${verified ? ', verified,' : ''} and opened: ${path}`;
}
