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
  videoSequenceProvider: (index: number, count: number, message: string) => `第 ${index}/${count} 段：${message}`,
  videoSequenceClip: (index: number, count: number) => `正在生成长视频第 ${index}/${count} 段。`,
  videoSequenceClipSaved: (index: number, count: number) => `长视频第 ${index}/${count} 段已保存。`,
  videoSequenceComposing: '所有片段已生成，正在合成并核对完整视频。',
  videoSequenceFailed: (saved: number, count: number) => `长视频未完成，已保留 ${saved}/${count} 个生成片段。`,
  videoSequenceDurationInvalid: '视频时长需为 1 至 120 秒的整数。',
  videoSequenceModelInvalid: '连续长视频需要在图生视频设置中选择 Lumi 官方 Wan2.2 图生视频模型。',
  videoEditUnavailable: '当前视频接口尚未支持传入原视频，无法直接修改已有成片。需要 API 后台开放参考视频输入；本次未提交重生成任务。',
  videoCompleteSaved: '视频生成完成，结果已保存。',
  videoAudioStatus: (hasAudio?: boolean) => hasAudio === true ? '已检测到音轨。' : hasAudio === false ? '文件不含音轨。' : '音轨尚未核实。',
  videoSettingsReview: '视频文件已保存，但实际尺寸或时长尚未满足请求，需要核对。',
  videoCompleteRemote: '视频生成完成，已取得结果链接。',
  videoDownloading: '视频已生成，正在下载结果。',
  videoRetrieving: '视频已生成，正在获取并下载结果。',
  officialVideoSaving: 'Lumi 官方 API 已返回视频结果，正在保存。',
  officialVideoDownloading: 'Lumi 官方 API 已返回视频结果，正在下载。',
  officialProvider: 'Lumi 官方 API',
  videoCatalogUnavailable: '无法核验当前视频模型目录，本次未提交视频生成请求；请检查连接或配置后重试。',
  videoModelUnavailable: (model: string, available: string[]) => `当前模型 ${model} 不适用于本次视频类型或未在官方目录中启用，本次未提交视频生成请求。请明确选择可用模型：${available.join('、') || '当前目录没有可用模型'}。`,
  videoSaving: '视频已生成，正在保存结果。',
  qwenRemoteCancelled: 'DashScope 已确认取消远端排队任务。',
  qwenRemoteCancelUnavailable: 'LumiCore 已停止等待；DashScope 未确认远端取消，已开始运行的任务可能仍会继续并计费。',
  qwenRemoteCancelFailed: 'LumiCore 已停止等待；DashScope 远端取消请求未成功，任务可能仍会继续并计费。',
} as const;
