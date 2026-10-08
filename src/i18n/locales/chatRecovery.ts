export function chatRecoveryCopy(isZh: boolean) {
  return isZh ? {
    waiting: '正在等待后台确认，连接恢复后会核对这条请求。',
    recovering: '正在核对这条请求的后台状态…',
    accepted: '后台已接收，任务正在处理。',
    missing: '暂未找到这条请求的执行记录，请查看当前对话历史后再重试。',
    rejected: '后台未接受这条请求，请检查连接后重试。',
    workingTitle: 'Lumi 正在处理', doneTitle: '任务已完成', errorTitle: '任务未完成', cancelledTitle: '任务已取消',
  } : {
    waiting: 'Waiting for backend acknowledgement. This request will be checked after reconnection.',
    recovering: 'Checking the backend state of this request…',
    accepted: 'The backend has accepted this task and is processing it.',
    missing: 'No execution record was found. Check this conversation history before retrying.',
    rejected: 'The backend did not accept this request. Check the connection and retry.',
    workingTitle: 'Lumi is working', doneTitle: 'Task completed', errorTitle: 'Task not completed', cancelledTitle: 'Task cancelled',
  };
}
