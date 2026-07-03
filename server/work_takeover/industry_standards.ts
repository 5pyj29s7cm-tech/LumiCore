import type { WechatWorkCategory } from './wechat_intake';

export interface IndustryWorkStandard {
  category: WechatWorkCategory;
  label: string;
  objective: string;
  externalSurfaces: string[];
  deliverables: string[];
  safeLoop: string[];
  confirmationBoundaries: string[];
  verificationFocus: string[];
}

const COMMON_SAFE_LOOP = [
  '识别原始消息或自然语言任务',
  '结构化目标、上下文、交付物和确认边界',
  '优先复用已登录外部系统或已运行桌面窗口',
  '在安全边界内准备文件、草稿、清单或交付包',
  '验证文件、窗口、草稿和阻塞点',
  '回写任务中心并汇报下一步需要确认什么',
];

export const INDUSTRY_WORK_STANDARDS: Record<WechatWorkCategory, IndustryWorkStandard> = {
  customer: {
    category: 'customer',
    label: '客户推进接管',
    objective: '把客户消息变成报价、方案、合同风险、跟进草稿和下一步推进动作。',
    externalSurfaces: ['WPS/Office', '个人微信/企业微信', '浏览器资料页', '任务中心'],
    deliverables: ['客户需求摘要', '报价/方案草稿', '合同风险点', '微信回复草稿', '下一步推进清单'],
    safeLoop: COMMON_SAFE_LOOP,
    confirmationBoundaries: ['发送消息', '最终报价', '合同条款', '交付周期承诺', '收款或签约'],
    verificationFocus: ['方案/报价文件存在且内容对应客户需求', '微信草稿已准备但未自动发送', '任务中心记录阻塞点和下一步'],
  },
  store: {
    category: 'store',
    label: '店铺运营接管',
    objective: '把店铺问题变成订单/库存/售后核对、客服话术、风险升级和运营动作。',
    externalSurfaces: ['店铺后台', '个人微信/客服窗口', 'WPS/表格', '浏览器平台页'],
    deliverables: ['订单/售后记录', '库存或发货核对项', '客服回复草稿', '风险升级清单'],
    safeLoop: COMMON_SAFE_LOOP,
    confirmationBoundaries: ['退款/赔付', '公开回复', '改价改库存', '发货状态变更', '发送客服消息'],
    verificationFocus: ['店铺后台或交付文件已打开/生成', '风险项已列出', '客服草稿停在确认前'],
  },
  account: {
    category: 'account',
    label: '账号运营接管',
    objective: '把账号目标变成内容矩阵、投放/发布准备、数据核对和账号工作清单。',
    externalSurfaces: ['抖店/小红书/视频号/创作者中心', '浏览器登录会话', '剪映/内容工具', 'WPS/表格'],
    deliverables: ['账号现状摘要', '内容/投放任务清单', '数据核对项', '对外回复草稿'],
    safeLoop: COMMON_SAFE_LOOP,
    confirmationBoundaries: ['首次登录', '扫码/验证码/人脸或短信验证', '切换账号', '正式发布', '投放预算', '授权第三方'],
    verificationFocus: ['已复用已登录账号窗口或浏览器会话', '内容/投放清单已生成', '发布/投放停在确认边界'],
  },
  video_publish: {
    category: 'video_publish',
    label: '短视频生成发布接管',
    objective: '把短视频需求变成脚本、分镜、标题、封面方向、剪辑/生成工具提示词和发布清单。',
    externalSurfaces: ['剪映', '即梦/可灵/Canva', '抖音/小红书/视频号创作者平台', 'WPS/文档'],
    deliverables: ['视频发布清单', '标题/封面方向', '脚本或口播摘要', '平台发布确认项'],
    safeLoop: COMMON_SAFE_LOOP,
    confirmationBoundaries: ['首次登录', '切换账号', '正式发布', '投流扣费', '上传敏感素材', '授权外部平台'],
    verificationFocus: ['脚本/标题/封面方向已产出', '外部视频或图片工具已打开或提示词已准备', '发布动作未越过确认边界'],
  },
  design_delivery: {
    category: 'design_delivery',
    label: '装修/CAD/Revit交付接管',
    objective: '把装修需求变成客户方案、预算材料清单、CAD草稿、Revit/Dynamo交接数据和微信交付草稿。',
    externalSurfaces: ['WPS/Office', 'CAD/AutoCAD/FreeCAD', 'Revit/Dynamo', '个人微信/企业微信'],
    deliverables: ['需求摘要', '客户可看的装修方案PPT/PDF', '预算与材料清单', 'CAD DXF初稿', 'Revit/Dynamo交接数据', '客户回复草稿'],
    safeLoop: COMMON_SAFE_LOOP,
    confirmationBoundaries: ['现场尺寸', '结构/水电/燃气改动', '生产图纸', '最终报价', '合同', '发送客户'],
    verificationFocus: ['PPT/PDF含真实装修内容和配图/结构', 'CAD/Revit交接文件存在', '微信交付草稿未自动发送'],
  },
  legal_case: {
    category: 'legal_case',
    label: '自动立案/法律材料接管',
    objective: '把法律消息变成事实时间线、证据目录、立案材料清单、风险提示和网页登录交接动作。',
    externalSurfaces: ['法院/法律平台网页登录会话', 'WPS/文档', 'PDF/证据文件夹', '任务中心'],
    deliverables: ['立案材料清单', '证据目录', '事实时间线', '风险提示', '待确认事项'],
    safeLoop: COMMON_SAFE_LOOP,
    confirmationBoundaries: ['正式法律意见', '提交立案', '签名', '缴费', '确认送达', '撤回或变更诉求'],
    verificationFocus: ['材料清单和证据目录已生成', '网页登录动作停在授权/提交前', '风险提示已记录'],
  },
  general_work: {
    category: 'general_work',
    label: '通用工作接管',
    objective: '把模糊工作变成任务摘要、执行清单、草稿、交付物和下一步确认点。',
    externalSurfaces: ['WPS/Office', '浏览器', '任务中心', '消息窗口'],
    deliverables: ['任务摘要', '执行清单', '回复草稿', '待确认事项'],
    safeLoop: COMMON_SAFE_LOOP,
    confirmationBoundaries: ['发送消息', '提交表单', '付款/签约', '删除或覆盖重要资料', '对外承诺'],
    verificationFocus: ['任务已拆解', '草稿/文件已准备', '下一步确认点清楚'],
  },
  personal: {
    category: 'personal',
    label: '个人事务接管',
    objective: '把个人消息变成事项摘要、提醒、回复草稿和待确认动作。',
    externalSurfaces: ['个人微信', '日历/提醒', '任务中心'],
    deliverables: ['事项摘要', '回复草稿', '提醒项'],
    safeLoop: COMMON_SAFE_LOOP,
    confirmationBoundaries: ['发送消息', '创建外部预约', '付款', '共享个人信息'],
    verificationFocus: ['事项和提醒已记录', '回复草稿未自动发送'],
  },
  unknown: {
    category: 'unknown',
    label: '待分类接管',
    objective: '先判断任务类型，再进入对应行业接管标准。',
    externalSurfaces: ['任务中心', '消息窗口'],
    deliverables: ['消息摘要', '分类建议', '回复草稿'],
    safeLoop: ['识别消息', '询问或推断任务归属', '停在可确认的下一步'],
    confirmationBoundaries: ['任务类型未确认前不执行外部副作用'],
    verificationFocus: ['已记录分类建议和缺口', '未越过外部动作边界'],
  },
};

export function getIndustryWorkStandard(category: WechatWorkCategory): IndustryWorkStandard {
  return INDUSTRY_WORK_STANDARDS[category] || INDUSTRY_WORK_STANDARDS.unknown;
}
