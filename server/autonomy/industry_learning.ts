import { readDB } from '../../db_layer';
import type { ProfessionProfile } from './professions';

export interface IndustryLearningProfile {
  industry: string;
  confidence: number;
  evidence: string[];
  knowledgeDomains: string[];
  workHabits: string[];
  commonTools: string[];
  researchPriorities: string[];
  deliverableExpectations: string[];
  verificationFocus: string[];
}

const PROFESSION_INDUSTRY_HINTS: Record<string, {
  industry: string;
  priorities: string[];
  deliverables: string[];
  verification: string[];
}> = {
  lawyer: {
    industry: 'legal_casework',
    priorities: [
      '现行有效法律、司法解释、地方立案规则和权威案例更新',
      '法院立案网、裁判文书、法蝉、Alpha、企查查/国家企业信用等授权协作流程',
      '起诉状、答辩状、代理词、证据目录、质证意见的交付 gate',
    ],
    deliverables: ['三段论法律分析', '现行有效法条核验报告', '证据目录/证明目的', '诉讼文书交付包'],
    verification: ['权威法源/法规状态', '类案层级和来源', '证据真实性/关联性/合法性', '正式提交前确认'],
  },
  designer: {
    industry: 'design_delivery',
    priorities: [
      '行业设计工具、素材来源、客户提案格式和审美趋势',
      'CAD/Revit/渲染/方案 PPT/PDF 的交付链路',
      '预算材料清单、空间风格、客户沟通话术和图纸核验方式',
    ],
    deliverables: ['客户方案 PPT/PDF', '预算与材料清单', 'CAD/DXF/Revit 交接文件', '微信交付草稿'],
    verification: ['尺寸/结构专业复核', '文件存在且内容对应客户需求', '图纸/报价/合同发送前确认'],
  },
  engineer: {
    industry: 'software_engineering',
    priorities: [
      '当前技术栈、框架版本、官方文档和安全公告',
      '编码代理、IDE、CI/CD、测试与部署习惯',
      '复用现有工具/适配器/技能，避免一次性脚本',
    ],
    deliverables: ['代码补丁', '测试报告', '架构/迁移方案', '运行和回滚说明'],
    verification: ['官方文档/版本兼容性', '测试/类型检查', '安全和数据迁移风险', '可回滚性'],
  },
  teacher: {
    industry: 'education',
    priorities: [
      '课程标准、教学活动、评估方式和学习者差异化支持',
      '教案、课件、习题、家校沟通模板和教学平台更新',
      '学习目标、过程性评价和可执行课堂流程',
    ],
    deliverables: ['教案', '课件结构', '分层习题', '家校沟通草稿'],
    verification: ['学习目标对齐', '难度分层', '非诊断性学习画像', '隐私和未成年人保护'],
  },
  doctor: {
    industry: 'medical_admin',
    priorities: [
      '指南、药品说明、临床路径和循证资料更新',
      '病历结构化、随访清单、检查/用药待确认项',
      '医学信息只作辅助，不替代执业医师判断',
    ],
    deliverables: ['结构化病历摘要', '随访计划', '患者说明草稿', '文献/指南摘要'],
    verification: ['指南/文献来源', '急症信号', '剂量/禁忌需医生确认', '隐私保护'],
  },
};

const TASK_CATEGORY_HINTS: Record<string, {
  industry: string;
  priorities: string[];
  deliverables: string[];
  verification: string[];
}> = {
  legal_case: PROFESSION_INDUSTRY_HINTS.lawyer,
  design_delivery: PROFESSION_INDUSTRY_HINTS.designer,
  store: {
    industry: 'ecommerce_ops',
    priorities: ['店铺后台规则、订单/售后/库存流程、客服话术和平台风控', '抖店/淘宝/天猫/京东/拼多多等授权会话协作'],
    deliverables: ['订单/售后核对项', '客服回复草稿', '运营动作清单', '风险升级清单'],
    verification: ['退款/改价/库存/发送客服消息前确认', '平台账号和验证码边界', '后台截图或文件证据'],
  },
  account: {
    industry: 'account_ops',
    priorities: ['账号内容矩阵、投放准备、数据核对、创作者平台规则', '小红书/抖音/视频号/巨量等平台工作流'],
    deliverables: ['内容/投放任务清单', '数据核对项', '发布确认清单', '对外回复草稿'],
    verification: ['正式发布/投放/账号切换前确认', '已登录会话核验', '草稿和数据来源'],
  },
  video_publish: {
    industry: 'short_video_ops',
    priorities: ['短视频脚本、分镜、标题封面、剪辑/生成工具和平台发布规则'],
    deliverables: ['脚本/口播稿', '分镜', '标题/封面方向', '发布清单'],
    verification: ['发布/投流/上传敏感素材前确认', '工具输出和平台规则', '版权和素材来源'],
  },
};

function compact(value: unknown, limit = 220): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map(item => compact(item)).filter(Boolean)));
}

function topProfessionProfiles(db: any): ProfessionProfile[] {
  return ((db.professionProfiles || []) as ProfessionProfile[])
    .filter(profile => Number(profile.confidence || 0) >= 0.25)
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
    .slice(0, 3);
}

function recentIndustryTasks(db: any, userId: string): any[] {
  const tasks = Array.isArray(db.workTakeoverTasks) ? db.workTakeoverTasks : [];
  return tasks
    .filter((task: any) => !userId || task.userId === userId)
    .sort((a: any, b: any) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
    .slice(0, 12);
}

function recentHabitMemories(db: any, userId: string): string[] {
  return (db.memories || [])
    .filter((memory: any) => memory.userId === userId && ['habit', 'preference', 'knowledge'].includes(memory.type))
    .sort((a: any, b: any) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
    .slice(0, 12)
    .map((memory: any) => compact(memory.content, 180));
}

function profileFromProfession(profile: ProfessionProfile, habits: string[]): IndustryLearningProfile {
  const hint = PROFESSION_INDUSTRY_HINTS[profile.profession] || {
    industry: profile.profession,
    priorities: [
      '该行业的常用平台、交付物格式、术语、工具链和风险边界',
      '用户近期反复出现的任务类型和可复用流程',
    ],
    deliverables: ['行业任务摘要', '执行清单', '交付物模板', '下一步确认点'],
    verification: ['来源可靠性', '交付物是否贴合用户习惯', '外部提交/发送前确认'],
  };

  return {
    industry: hint.industry,
    confidence: Math.max(0, Math.min(1, Number(profile.confidence || 0))),
    evidence: unique(profile.evidence || []).slice(0, 8),
    knowledgeDomains: unique(profile.knowledgeDomains || []).slice(0, 10),
    workHabits: habits.slice(0, 6),
    commonTools: unique(profile.installedRelevantTools || []).slice(0, 10),
    researchPriorities: hint.priorities,
    deliverableExpectations: hint.deliverables,
    verificationFocus: hint.verification,
  };
}

function profileFromTaskCategory(category: string, tasks: any[], habits: string[]): IndustryLearningProfile | null {
  const hint = TASK_CATEGORY_HINTS[category];
  if (!hint) return null;
  const related = tasks.filter(task => task.category === category);
  const evidence = related.flatMap(task => [
    task.title,
    task.metadata?.industryParameters?.summaryLines?.join(' | '),
  ]);
  const toolHints = related.flatMap(task => task.metadata?.industryParameters?.expectedSurfaces || []);
  return {
    industry: hint.industry,
    confidence: Math.min(0.92, 0.45 + related.length * 0.08),
    evidence: unique(evidence).slice(0, 8),
    knowledgeDomains: [],
    workHabits: habits.slice(0, 6),
    commonTools: unique(toolHints).slice(0, 10),
    researchPriorities: hint.priorities,
    deliverableExpectations: hint.deliverables,
    verificationFocus: hint.verification,
  };
}

export function getIndustryLearningProfiles(userId: string): IndustryLearningProfile[] {
  const db = readDB();
  const habits = recentHabitMemories(db, userId);
  const profiles = topProfessionProfiles(db).map(profile => profileFromProfession(profile, habits));
  const tasks = recentIndustryTasks(db, userId);
  const taskCategories = unique(tasks.map(task => task.category)).slice(0, 4);
  for (const category of taskCategories) {
    const taskProfile = profileFromTaskCategory(category, tasks, habits);
    if (!taskProfile) continue;
    const existing = profiles.findIndex(profile => profile.industry === taskProfile.industry);
    if (existing >= 0) {
      profiles[existing] = {
        ...profiles[existing],
        confidence: Math.max(profiles[existing].confidence, taskProfile.confidence),
        evidence: unique([...profiles[existing].evidence, ...taskProfile.evidence]).slice(0, 10),
        commonTools: unique([...profiles[existing].commonTools, ...taskProfile.commonTools]).slice(0, 12),
        workHabits: unique([...profiles[existing].workHabits, ...taskProfile.workHabits]).slice(0, 8),
      };
    } else {
      profiles.push(taskProfile);
    }
  }

  return profiles
    .filter(profile => profile.confidence >= 0.25 || profile.evidence.length > 0)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);
}

export function formatIndustryLearningContext(userId: string): string | null {
  const profiles = getIndustryLearningProfiles(userId);
  if (profiles.length === 0) return null;

  const lines = ['使用者行业习惯画像：'];
  for (const profile of profiles) {
    lines.push(`- industry=${profile.industry} confidence=${Math.round(profile.confidence * 100)}%`);
    if (profile.evidence.length) lines.push(`  evidence=${profile.evidence.slice(0, 4).join(' | ')}`);
    if (profile.commonTools.length) lines.push(`  commonTools=${profile.commonTools.slice(0, 6).join(', ')}`);
    if (profile.knowledgeDomains.length) lines.push(`  knowledgeDomains=${profile.knowledgeDomains.slice(0, 6).join(', ')}`);
    if (profile.workHabits.length) lines.push(`  habits=${profile.workHabits.slice(0, 3).join(' | ')}`);
    lines.push(`  researchPriorities=${profile.researchPriorities.slice(0, 3).join(' | ')}`);
    lines.push(`  deliverables=${profile.deliverableExpectations.slice(0, 4).join(', ')}`);
    lines.push(`  verification=${profile.verificationFocus.slice(0, 4).join(', ')}`);
  }
  lines.push('行业学习要求：自主联网学习必须优先围绕这些行业习惯、常用平台、交付物格式、术语、合规/确认边界和验收方式；不要泛泛追热点。');
  return lines.join('\n');
}
