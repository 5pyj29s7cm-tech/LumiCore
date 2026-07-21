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

export function formatDesktopObservationUnavailable(userText: string): string {
  return usesChinese(userText)
    ? '这次没有读到可用的桌面状态。'
    : 'No usable desktop state was returned this time.';
}

export function formatKnownLoginOpening(userText: string, siteLabel: string): string {
  return usesChinese(userText)
    ? `正在打开${siteLabel}的登录页面。`
    : `Opening the ${siteLabel} login page.`;
}

export function formatKnownLoginResult(
  userText: string,
  siteLabel: string,
  raw: string,
  error?: string,
): string {
  if (error) {
    return usesChinese(userText)
      ? `${siteLabel}登录页面没有打开：${error}`
      : `The ${siteLabel} login page did not open: ${error}`;
  }
  let result: Record<string, unknown> = {};
  try {
    result = JSON.parse(raw || '{}');
  } catch {}
  if (result.status === 'logged_in') {
    return usesChinese(userText)
      ? `${siteLabel}的登录会话已经可用。`
      : `The ${siteLabel} login session is ready.`;
  }
  if (result.browserOpen) {
    return usesChinese(userText)
      ? `${siteLabel}登录页面已经打开；如果有扫码、验证码或二次验证，需要你在页面上完成。`
      : `The ${siteLabel} login page is open. Complete any QR code, captcha, or two-factor check on the page.`;
  }
  return usesChinese(userText)
    ? `${siteLabel}登录页面已经打开。`
    : `The ${siteLabel} login page is open.`;
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

export function buildInternalOpenCommand(userText: string, target: string): string {
  return usesChinese(userText) ? `打开 ${target}` : `open ${target}`;
}
