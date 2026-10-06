/** Chinese CLI status, progress and capability copy. */
export const CN_EXTERNAL_CLI_MESSAGES = {
  ready: (name: string, version: string) => `${name} 已安装，登录和配置检查通过${version ? `（${version}）` : ''}。`,
  notInstalled: (name: string) => `本机尚未检测到 ${name}。`,
  unavailable: (name: string) => `${name} 已安装，但登录或配置检查未通过，目前还不能确认可用。`,
  canDelegate: '可以通过本机的 CLI 接口委派任务。',
  statusScope: '这次只检查了本机状态，没有执行任务，也没有验证模型额度。具体任务需要项目目录和要做的事。',
  unverified: '这次没能确认本机 CLI 的状态，暂时不能判断它是否可用。',
  progress: (item: string, completed = false) => `${completed ? '完成' : '正在执行'}：${item}`,
  started: (name: string, resumed: boolean) => `${name} 已开始${resumed ? '继续' : '处理'}任务。`,
  delegationIntents: ['外部编程助手', '委派任务', '继续外部任务'],
};
