export const CN_DEPENDENCY_SIGNALS = [
  {
    patterns: ['没有你我怎么活', '我不能没有你', '你是我唯一的', '只有你懂我', '别离开我'],
    level: 'high',
  },
  {
    patterns: ['好想你', '想见你', '要是你在就好了', '舍不得'],
    level: 'medium',
  },
  {
    patterns: ['每天都来', '一直陪着我', '不要走'],
    level: 'medium',
  },
] as const;

export const CN_PRODUCT_CATEGORY_ALIASES = {
  coreDevices: '核心设备',
  smartWearables: '智能穿戴',
  aiCompanionToys: 'AI 陪伴',
  partnershipZone: '合作区',
} as const;

export const CN_BROKEN_TEXT_MARKERS = ['锟', '鏂', '涓', '缁', '瀕', '濂', '娴', '浼', '忡', '鐹', '鍙'] as const;

export const CN_FOUNDER_ALIASES = ['创始人'] as const;

export const CN_WECHAT_ALIASES = ['微信'] as const;

export const CN_AUTONOMOUS_CUSTOMER_COPY_RE = /^(?:这项自主任务|刚才|还没有|这一步|桌面控制|我现在没能|检测到你|这个.+操作)/u;
