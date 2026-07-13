export interface SkillRecommendationRule {
  skillIds: string[];
  zh: string;
  en: string;
  pattern: RegExp;
}

export const WORK_RECOMMENDATION_RULES: SkillRecommendationRule[] = [
  { skillIds: ['skill-executive-ops'], zh: '经营/管理', en: 'management work', pattern: /企业负责人|老板|创始人|CEO|总经理|管理|经营|KPI|OKR|会议纪要|决策|现金跑道|runway|executive|founder|manager|decision/i },
  { skillIds: ['skill-ecommerce-ops', 'skill-finance-office'], zh: '电商/平台经营', en: 'e-commerce work', pattern: /电商|店铺|SKU|库存|平台结算|淘宝|抖店|小红书|shopify|ecommerce|marketplace|listing|settlement/i },
  { skillIds: ['skill-cross-border-trade', 'skill-ecommerce-ops', 'skill-translator'], zh: '外贸/跨境', en: 'foreign trade or cross-border commerce', pattern: /外贸|跨境|询盘|报价单|报关|清关|海关|关税|货代|提单|信用证|FOB|CIF|DDP|incoterm|customs|tariff|freight|forwarder|export|import|cross.?border|foreign trade/i },
  { skillIds: ['skill-manufacturing-qa'], zh: '制造/工厂/质检', en: 'manufacturing or quality work', pattern: /制造|工厂|生产|产线|质检|品控|BOM|物料|供应商|交期|8D|不良|返工|报废|work order|production|factory|quality|supplier|defect|inspection/i },
  { skillIds: ['skill-property-ops', 'skill-cad-drafting'], zh: '房产/物业/装修', en: 'property or renovation work', pattern: /房产|房源|中介|物业|租赁|看房|业主|租客|工单|装修|施工进度|预算|材料清单|real estate|property|leasing|tenant|landlord|renovation/i },
  { skillIds: ['skill-insurance-advisor', 'skill-sales-customer-ops'], zh: '保险/顾问', en: 'insurance advisory work', pattern: /保险|保单|投保|续保|理赔|保障|重疾|寿险|车险|年金|客户画像|insurance|policy|claim|renewal|premium|coverage/i },
  { skillIds: ['skill-content-ops', 'skill-design-studio-pack', 'skill-video-editor'], zh: '新媒体/内容运营', en: 'content or creator operations', pattern: /新媒体|内容运营|短视频|选题|脚本|账号复盘|评论分析|小红书|抖音|视频号|公众号|直播脚本|content|creator|tiktok|youtube|script|calendar/i },
  { skillIds: ['skill-product-project-ops', 'skill-executive-ops'], zh: '产品/项目管理', en: 'product or project management', pattern: /产品经理|项目经理|PRD|需求池|需求文档|用户故事|验收标准|路线图|排期|里程碑|迭代|sprint|roadmap|backlog|user story|acceptance criteria|project manager|product manager/i },
  { skillIds: ['skill-admin-assistant', 'skill-pdftools', 'skill-email-assistant'], zh: '行政/助理', en: 'administration or assistant work', pattern: /行政|助理|老板助理|总助|日程|会议安排|报销|采购申请|通知|资料归档|档案|admin|assistant|schedule|reimbursement|filing/i },
  { skillIds: ['skill-procurement-supply-chain', 'skill-finance-office'], zh: '采购/供应链', en: 'procurement or supply chain work', pattern: /采购|供应链|供应商|询价|比价|采购计划|交期风险|库存预警|对账|采购合同|procurement|supply chain|vendor|supplier|purchase order|PO/i },
  { skillIds: ['skill-data-bi', 'skill-finance-office'], zh: '数据分析/BI', en: 'data analysis or BI work', pattern: /数据分析|BI|报表|看板|指标口径|数据清洗|CSV|Excel|异常解释|周报|月报|dashboard|metric|analytics|anomaly|reporting/i },
  { skillIds: ['skill-logistics-warehouse', 'skill-ecommerce-ops'], zh: '物流/仓储', en: 'logistics or warehouse work', pattern: /物流|仓储|仓库|入库|出库|拣货|盘点|配送|运费|库存差异|快递|carrier|warehouse|logistics|inbound|outbound|picking|freight/i },
  { skillIds: ['skill-live-commerce', 'skill-content-ops', 'skill-ecommerce-ops'], zh: '直播运营/带货', en: 'live commerce work', pattern: /直播|主播|带货|直播间|货盘|场控|直播脚本|转化复盘|GMV|直播售后|live commerce|livestream|host script|rundown/i },
  { skillIds: ['skill-construction-tender-cost', 'skill-cad-drafting', 'skill-legal-casework'], zh: '建筑/造价/招投标', en: 'construction tendering or cost work', pattern: /建筑|工程|造价|招投标|投标|清单|工程量|标书|施工节点|风险条款|BOQ|tender|bid|quantity survey|construction|cost estimate/i },
  { skillIds: ['skill-finance-office'], zh: '财务/税务', en: 'finance or tax work', pattern: /财务|财税|税务|发票|现金流|预算|应收|应付|账龄|invoice|cashflow|tax|vat|receivable|payable/i },
  { skillIds: ['skill-education-teacher'], zh: '教学/教培', en: 'teaching work', pattern: /老师|教师|教培|教学|教案|备课|作业|评分|学生|家长|teacher|lesson|student|rubric/i },
  { skillIds: ['skill-medical-admin'], zh: '医疗文书/随访', en: 'medical documentation work', pattern: /医生|医疗|病历|问诊|随访|患者|检查报告|clinical|medical|patient|follow.?up/i },
  { skillIds: ['skill-hr-recruiting'], zh: '招聘/人事', en: 'HR or recruiting work', pattern: /HR|人事|招聘|简历|面试|候选人|入职|recruit|resume|candidate|interview|onboarding/i },
  { skillIds: ['skill-sales-customer-ops'], zh: '销售/客服', en: 'sales or support work', pattern: /销售|客服|客户|线索|跟进|异议|工单|续费|lead|sales|customer|support|objection/i },
  { skillIds: ['skill-restaurant-store-ops'], zh: '餐饮/门店', en: 'restaurant or store work', pattern: /餐饮|门店|咖啡店|菜单|毛利|报损|排班|点评|促销|restaurant|cafe|store|menu|waste|shift/i },
  { skillIds: ['skill-legal-casework'], zh: '法律/案件', en: 'legal work', pattern: /法律|律师|案件|合同|起诉|答辩|court|legal|lawsuit|contract/i },
  { skillIds: ['skill-design-studio-pack'], zh: '设计/品牌', en: 'design work', pattern: /设计|品牌|logo|海报|视觉|UI|UX|design|brand|poster/i },
  { skillIds: ['skill-cad-drafting'], zh: 'CAD/装修图纸', en: 'CAD or drafting work', pattern: /CAD|DXF|图纸|平面图|施工图|装修|floor plan|drafting/i },
];
