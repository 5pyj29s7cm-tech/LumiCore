/**
 * Chinese progress copy for long-running media tools.
 *
 * Tool progress currently has no locale field, so the CN runtime pack owns the
 * user-visible strings instead of scattering them through provider adapters.
 */
export const CN_MEDIA_PROGRESS = {
  imageRequestSubmitted: '图片生成请求已提交。',
  imageTaskSubmitted: '图片生成任务已提交。',
  imageGenerating: '图片正在生成中。',
  imageSaving: '图片已生成，正在保存结果。',
  imageComplete: '图片生成完成。',
  imageEditSubmitted: '图片编辑请求已提交。',
  imageEditing: '图片正在编辑中。',
  imageEditSaving: '图片已编辑，正在保存结果。',
  imageEditComplete: '图片编辑完成。',
  providerVideoSubmitted: (provider: string) => `${provider} 视频生成任务已提交。`,
  providerVideoRunning: (provider: string) => `${provider} 视频任务正在排队或生成中。`,
  videoCompleteSaved: '视频生成完成，结果已保存。',
  videoCompleteRemote: '视频生成完成，已取得结果链接。',
  videoDownloading: '视频已生成，正在下载结果。',
  videoRetrieving: '视频已生成，正在获取并下载结果。',
  officialVideoSaving: 'Lumi 官方 API 已返回视频结果，正在保存。',
  officialVideoDownloading: 'Lumi 官方 API 已返回视频结果，正在下载。',
  officialProvider: 'Lumi 官方 API',
  videoSaving: '视频已生成，正在保存结果。',
  qwenRemoteCancelled: 'DashScope 已确认取消远端排队任务。',
  qwenRemoteCancelUnavailable: 'LumiCore 已停止等待；DashScope 未确认远端取消，已开始运行的任务可能仍会继续并计费。',
  qwenRemoteCancelFailed: 'LumiCore 已停止等待；DashScope 远端取消请求未成功，任务可能仍会继续并计费。',
} as const;
