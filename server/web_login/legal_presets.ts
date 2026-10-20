export type WebLoginSitePreset = {
  id: string;
  label: string;
  category: 'legal';
  loginUrl: string;
  matchHosts: string[];
  loginFrameSelector?: string;
  notes: string;
  sourceUrl: string;
};

export const LEGAL_WEB_LOGIN_PRESETS: WebLoginSitePreset[] = [
  {
    id: 'faxin',
    label: '法信',
    category: 'legal',
    loginUrl: 'https://www.faxin.cn/login.aspx',
    matchHosts: ['faxin.cn', 'www.faxin.cn', 'sfb-vip.faxin.cn', 'm.faxin.cn'],
    sourceUrl: 'https://www.faxin.cn/',
    notes: [
      '法信内容通常受账号授权和服务协议限制。',
      'Lumi 只保存用户授权的本机登录会话，不批量抓取、不共享账号、不绕过验证码或机构访问限制。',
      '如遇单位公网密码、SSO、扫码或验证码，请使用可见浏览器手动完成一次，之后复用会话。',
    ].join(' '),
  },
  {
    id: 'china-judgments-online',
    label: '中国裁判文书网',
    category: 'legal',
    loginUrl: 'https://wenshu.court.gov.cn/website/wenshu/181010CARHS5BS3C/index.html?open=login',
    matchHosts: ['wenshu.court.gov.cn'],
    sourceUrl: 'https://wenshu.court.gov.cn/',
    notes: [
      '中国裁判文书网是最高人民法院裁判文书公开平台，访问通常需要注册/登录。',
      '登录方式、验证码、支付宝/钉钉等第三方验证需要用户本人在可见浏览器中完成。',
      'Lumi 复用已授权会话做检索阅读，不绕过反爬、验证码、访问频控或下载限制。',
    ].join(' '),
  },
  {
    id: 'people-court-case-library',
    label: '人民法院案例库',
    category: 'legal',
    loginUrl: 'https://rmfyalk.court.gov.cn/',
    matchHosts: ['rmfyalk.court.gov.cn'],
    sourceUrl: 'https://rmfyalk.court.gov.cn/',
    notes: [
      '人民法院案例库用于检索权威案例、参考案例和裁判规则。',
      'Lumi 只负责打开页面、复用用户授权会话、辅助形成检索词和来源登记。',
      '案例是否可用于正式文书以及引用方式需由律师复核。',
    ].join(' '),
  },
  {
    id: 'court-online-service',
    label: '人民法院在线服务',
    category: 'legal',
    loginUrl: 'https://zxfw.court.gov.cn/',
    matchHosts: ['zxfw.court.gov.cn'],
    sourceUrl: 'https://zxfw.court.gov.cn/',
    notes: [
      '人民法院在线服务涉及身份认证、网上立案、材料提交等高风险操作。',
      'Lumi 可以辅助打开页面、准备填写清单和材料组卷，但提交、签名、缴费、撤回等动作必须由律师或当事人亲自确认。',
      '不保存或代用未授权身份凭证，不绕过人脸核验、验证码、短信验证或平台频控。',
    ].join(' '),
  },
  {
    id: 'qichacha',
    label: '企查查',
    category: 'legal',
    loginUrl: 'https://www.qcc.com/',
    matchHosts: ['qcc.com', 'www.qcc.com'],
    sourceUrl: 'https://www.qcc.com/',
    notes: [
      '企查查内容通常受账号权限、套餐和服务协议限制。',
      'Lumi 可以复用用户授权网页会话，辅助查询公司基本信息、股东信息和风险线索。',
      '企业信息、涉诉信息和被执行人线索进入正式文书前应登记查询时间、页面来源并人工复核。',
    ].join(' '),
  },
  {
    id: 'national-enterprise-credit',
    label: '国家企业信用信息公示系统',
    category: 'legal',
    loginUrl: 'https://www.gsxt.gov.cn/',
    matchHosts: ['gsxt.gov.cn', 'www.gsxt.gov.cn'],
    sourceUrl: 'https://www.gsxt.gov.cn/',
    notes: [
      '国家企业信用信息公示系统用于核验企业登记、公示和经营异常等信息。',
      '该站点可能存在地区跳转、验证码或访问频控，Lumi 只做授权会话复用和检索辅助。',
      '正式尽调结论需保留查询时间、主体名称、统一社会信用代码和页面来源。',
    ].join(' '),
  },
  {
    id: 'fachan',
    label: '法蝉',
    category: 'legal',
    loginUrl: 'https://www.fachans.com/',
    matchHosts: ['fachans.com', 'www.fachans.com'],
    sourceUrl: 'https://www.fachans.com/',
    notes: [
      '法蝉属于第三方法律检索/办案平台，内容和接口能力取决于律所账号授权。',
      'Lumi 不复制平台数据，只打开授权页面、辅助检索、整理来源登记和律师确认后的摘录。',
      '请遵守平台服务协议、下载限制和账号使用规则。',
    ].join(' '),
  },
  {
    id: 'alpha-lawyer',
    label: 'Alpha',
    category: 'legal',
    loginUrl: 'https://alphalawyer.cn/',
    matchHosts: ['alphalawyer.cn', 'www.alphalawyer.cn', 'icourt.cc', 'www.icourt.cc'],
    sourceUrl: 'https://alphalawyer.cn/',
    notes: [
      'Alpha 属于第三方法律工作平台，具体入口、账号体系和权限以律所购买版本为准。',
      'Lumi 只保存本机授权会话并辅助打开检索页面，不批量抓取、不共享账号、不绕过平台限制。',
      '律师需要复核从平台摘录的案例、法条、图表和风险提示。',
    ].join(' '),
  },
];

export function listWebLoginSitePresets(category?: string): WebLoginSitePreset[] {
  const normalized = String(category || '').trim().toLowerCase();
  if (!normalized) return LEGAL_WEB_LOGIN_PRESETS;
  return LEGAL_WEB_LOGIN_PRESETS.filter(preset => preset.category === normalized);
}

export function getWebLoginSitePreset(id: string): WebLoginSitePreset | undefined {
  const normalized = String(id || '').trim().toLowerCase();
  return LEGAL_WEB_LOGIN_PRESETS.find(preset => preset.id === normalized);
}
