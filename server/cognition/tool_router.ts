import { ToolPolicy } from '../personality/types';
import { ToolRegistry } from '../tools/registry';

type ToolDeclaration = ReturnType<ToolRegistry['getToolDeclarations']>[number];

export interface ToolRoute {
  toolNames: string[];
  categories: string[];
  reasons: string[];
  totalAvailable: number;
  maxTools: number;
  truncated: boolean;
}

interface RouteDefinition {
  category: string;
  reason: string;
  patterns: RegExp[];
  exact?: string[];
  prefixes?: string[];
  namePatterns?: RegExp[];
  groups?: string[];
}

const BASELINE_TOOLS = [
  'work_product_plan',
  'work_product_verify',
];

const TOOL_GROUPS: Record<string, string[]> = {
  files: [
    'desktop_list_files',
    'desktop_path_info',
    'list_directory',
    'search_files',
    'grep_files',
    'read_file',
    'read_files_batch',
    'write_file',
  ],
  documents: [
    'extract_document_text',
    'transcribe_audio_to_text_file',
    'read_docx',
    'read_xlsx',
    'read_pdf',
    'pdf_to_text',
    'ocr_image_file',
    'create_docx',
    'create_xlsx',
    'create_pdf',
    'create_ppt',
  ],
  web: [
    'web_search',
    'url_fetch',
    'browser_open_task',
    'authority_research',
    'capability_research',
  ],
  authenticatedWeb: [
    'web_login_site_presets',
    'web_login_profile_save_from_preset',
    'web_login_profile_save',
    'web_login_learn_site',
    'web_login_profile_list',
    'web_login_run',
    'url_fetch_logged_in',
  ],
  legal: [
    'legal_search_case',
    'legal_search_statute',
    'legal_generate_bid',
    'legal_review_contract',
    'legal_draft_contract',
    'legal_trace_assets',
    'legal_equity_penetration',
    'legal_case_strategy',
    'legal_generate_litigation_packet',
    'legal_prepare_filing_handoff',
    'legal_extract_dispute_focus',
    'legal_generate_argument_or_opinion',
    'legal_analyze_folder_and_draft_argument',
    'legal_import_materials_to_kb',
    'legal_process_notice_link',
    'legal_download_and_extract_document',
    'legal_external_source_status',
    'legal_external_research_plan',
    'legal_verify_citation',
    'legal_import_judgment',
    'authority_research',
    'authority_research_save',
  ],
  music: [
    'browser_open_task',
    'external_app_list_adapters',
  ],
  design: [
    'generate_image',
    'generate_image_dalle',
    'edit_image',
    'cad_generate_dxf',
    'floorplan_extract_geometry',
    'ocr_image_file',
  ],
  code: [
    'read_file',
    'write_file',
    'search_files',
    'grep_files',
    'read_files_batch',
    'git_status',
    'git_diff',
    'git_stage',
    'git_commit',
    'run_tests',
    'type_check',
    'code_execution',
    'python_exec',
    'run_command',
  ],
  system: [
    'client_get_state',
    'client_health_check',
    'client_self_repair',
    'get_system_info',
    'desktop_system_info',
    'get_running_processes',
    'get_active_window_info',
    'capture_screen',
    'adapter_registry_list',
    'adapter_health_check',
  ],
  skills: [
    'client_get_state',
    'list_skills',
    'generate_skill',
    'install_skill',
    'client_repair_skill',
    'self_extension_plan',
    'capability_research',
    'adapter_registry_list',
    'external_app_list_adapters',
  ],
  messaging: [
    'wechat_prepare_reply',
    'wechat_copy_reply_draft',
    'browser_open_task',
    'external_app_list_adapters',
  ],
  calendar: [
    'calendar_today',
    'upcoming_events',
    'calendar_create',
    'calendar_modify',
    'calendar_delete',
    'send_email',
    'recent_emails',
  ],
};

const ROUTES: RouteDefinition[] = [
  {
    category: 'legal',
    reason: 'legal casework or legal research request',
    patterns: [
      /法律|律师|律所|案件|案号|案由|类案|法条|法院|裁判文书|人民法院案例库|法信|法蝉|企查查|国家企业信用|委托书|代理词|证据目录|起诉状|要素式诉状|答辩状|质证|文书包|立案|网上立案|立案网|法院在线服务|外部检索|法律意见书|合同审查|合同模板|标书|投标书|财产线索|被执行人|股权穿透|诉讼|仲裁|争议焦点|庭审笔录|庭审提纲|法律分析|应对策略|焦点提炼|案件文件夹|材料文件夹|文件夹.*代理词|文书链接|发送链接|下载文书|提取文书|提取正文|链接.*下载|链接.*提取|材料入库|导入知识库|知识库导入|外部数据源|数据源接入|开庭通知|法院通知|送达通知|短信链接|通知链接|送达链接/u,
      /\b(legal|lawyer|lawsuit|court|judgment|casework|contract\s+review|power\s+of\s+attorney|complaint|defense|pleading|evidence|filing|bid|tender|qichacha|alpha|fachan|notice\s+link|court\s+notice|document\s+link|extract\s+document)\b/i,
    ],
    exact: ['mcp_legal-casework_legal_case_folder_workflow'],
    prefixes: ['mcp_legal-casework_'],
    namePatterns: [/^legal_/, /^web_login_/, /^url_fetch_logged_in$/],
    groups: ['legal', 'files', 'documents', 'web', 'authenticatedWeb'],
  },
  {
    category: 'music',
    reason: 'music playback or music library request',
    patterns: [
      /音乐|歌曲|歌单|网易云|播放|暂停|继续播放|歌词|旋律|作曲|写歌/u,
      /\b(music|song|playlist|netease|lyrics|melody|compose)\b/i,
    ],
    prefixes: ['mcp_neteasemusic_', 'mcp_locate-and-launch-netease_', 'mcp_play-music_', 'mcp_play-song_'],
    groups: ['music'],
  },
  {
    category: 'cad_design',
    reason: 'CAD, design, image, or visual production request',
    patterns: [
      /CAD|DXF|DWG|图纸|平面图|户型|施工图|装修|室内|水电|草稿图|布置方案|装修方案|设计|视觉|品牌|海报|图片|画图|生成图|抠图|改图/u,
      /\b(cad|dxf|dwg|floor\s*plan|drawing|design|brand|poster|image|render)\b/i,
    ],
    prefixes: ['mcp_cad-drafting_', 'mcp_picture-drawing-assistant_', 'mcp_pikachu-drawing_'],
    groups: ['design', 'files', 'documents'],
  },
  {
    category: 'audio_transcription',
    reason: 'audio recording transcription or speech-to-text file request',
    patterns: [
      /(?:\u5f55\u97f3|\u97f3\u9891|\u8bed\u97f3).*(?:\u8f6c\u5199|\u8f6c\u6587\u5b57|\u6587\u5b57\u7a3f|\u6587\u4ef6)|(?:\u8f6c\u5199|\u8f6c\u6587\u5b57|\u6587\u5b57\u7a3f).*(?:\u5f55\u97f3|\u97f3\u9891|\u8bed\u97f3)/u,
      /\b(audio|voice|recording|memo)\b.*\b(transcri|speech\s*to\s*text|text\s*file)\b/i,
      /\b(transcribe|speech\s*to\s*text)\b.*\b(audio|voice|recording|memo)\b/i,
    ],
    groups: ['files', 'documents'],
  },
  {
    category: 'documents',
    reason: 'document, office, PDF, spreadsheet, or presentation workflow',
    patterns: [
      /文档|文件夹|文件|资料|报告|表格|PPT|幻灯片|PDF|DOCX|Excel|整理|汇总|导出|保存|生成.*文/u,
      /\b(document|file|folder|report|spreadsheet|ppt|presentation|pdf|docx|xlsx|export|save)\b/i,
    ],
    prefixes: ['mcp_demo-ppt-creation_', 'mcp_wps-ppt-creator_', 'mcp_ai-research-ppt-outline_', 'mcp_pdftools_'],
    groups: ['files', 'documents', 'web'],
  },
  {
    category: 'authenticated_web',
    reason: 'website login, saved account, or authenticated browser session request',
    patterns: [
      /网页登录|自动登录|登录|账号|帐号|账户|保存密码|记住密码|已登录|登录会话|浏览器会话|店铺后台|商家后台|创作者中心|平台账号|扫码|验证码|二次验证|2FA/u,
      /\b(login|log\s*in|sign\s*in|account|password|credential|session|authenticated|auth|2fa|otp|captcha|dashboard|seller\s*center|creator\s*center)\b/i,
    ],
    groups: ['web', 'authenticatedWeb'],
  },
  {
    category: 'web_research',
    reason: 'web search, source verification, or current information request',
    patterns: [
      /搜索|查询|查找|联网|浏览|网页|网址|链接|资料来源|出处|引用|官方|验证|调研/u,
      /\b(search|look\s*up|browse|fetch|research|source|citation|official|verify)\b/i,
    ],
    prefixes: ['mcp_fetcher_', 'mcp_web-fetcher-pro_'],
    groups: ['web', 'authenticatedWeb'],
  },
  {
    category: 'code_git',
    reason: 'coding, testing, git, commit, or deployment request',
    patterns: [
      /代码|修复|实现|测试|构建|提交|推送|部署|仓库|git|commit|push|lint|build/u,
      /\b(code|fix|implement|test|lint|build|commit|push|deploy|repo|git)\b/i,
    ],
    prefixes: ['mcp_code-sandbox_', 'mcp_deployment-config-generator_', 'mcp_project-deployment-setup_'],
    groups: ['code'],
  },
  {
    category: 'system',
    reason: 'system, runtime, diagnostics, or repair request',
    patterns: [
      /系统|运行时|日志|报错|错误|卡住|诊断|修复|健康|进程|后台|窗口|桌面|屏幕|空间|磁盘|C盘|D盘/u,
      /\b(system|runtime|log|error|crash|stuck|diagnose|repair|process|desktop|screen|disk|storage)\b/i,
    ],
    prefixes: [
      'mcp_system-diagnostics_',
      'mcp_desktop-env-diagnostics_',
      'mcp_local-system-check_',
      'mcp_os-cross-platform-info_',
      'mcp_system-diagnostic_',
      'mcp_system-overview_',
      'mcp_desktop-aware-system-state_',
    ],
    groups: ['system', 'files'],
  },
  {
    category: 'skills_agents',
    reason: 'skill, MCP, agent, adapter, or external capability request',
    patterns: [
      /技能|技能大厅|MCP|工具|智能体|agent|外部agent|外部应用|连接.*agent|接入|插件|能力/u,
      /\b(skill|mcp|tool|agent|adapter|external\s+app|plugin|capability)\b/i,
    ],
    prefixes: ['mcp_hermes_'],
    groups: ['skills'],
  },
  {
    category: 'messaging',
    reason: 'Feishu, WeChat, WeCom, or remote messaging request',
    patterns: [
      /飞书|微信|企业微信|WeCom|消息|回消息|远程协作|绑定码/u,
      /\b(feishu|lark|wechat|wecom|message|reply)\b/i,
    ],
    prefixes: ['mcp_messaging-ops_', 'mcp_wechat-launcher_'],
    groups: ['messaging', 'files', 'documents'],
  },
  {
    category: 'calendar_email',
    reason: 'calendar or email workflow',
    patterns: [
      /日历|日程|提醒|邮件|邮箱|发邮件/u,
      /\b(calendar|schedule|event|email|mail)\b/i,
    ],
    groups: ['calendar', 'files', 'documents'],
  },
];

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function routeMatches(route: RouteDefinition, text: string): boolean {
  return route.patterns.some(pattern => pattern.test(text));
}

function addIfAvailable(out: Set<string>, available: Set<string>, name: string): void {
  if (available.has(name)) out.add(name);
}

function addGroup(out: Set<string>, available: Set<string>, group: string): void {
  for (const name of TOOL_GROUPS[group] || []) addIfAvailable(out, available, name);
}

function addPrefix(out: Set<string>, names: string[], prefix: string): void {
  for (const name of names) {
    if (name.startsWith(prefix)) out.add(name);
  }
}

function addNamePattern(out: Set<string>, names: string[], pattern: RegExp): void {
  for (const name of names) {
    if (pattern.test(name)) out.add(name);
  }
}

function scoreDeclaration(text: string, declaration: ToolDeclaration): number {
  const needle = `${declaration.function.name} ${declaration.function.description || ''}`.toLowerCase();
  const lower = text.toLowerCase();
  const tokens = unique(lower.match(/[a-z0-9_]{3,}|[\u4e00-\u9fa5]{2,}/gi) || []);
  let score = 0;
  for (const token of tokens) {
    if (needle.includes(token.toLowerCase())) score += token.length > 4 ? 2 : 1;
  }
  if (needle.includes(lower) || lower.includes(declaration.function.name.toLowerCase())) score += 4;
  return score;
}

export function routeToolsForTurn(
  userText: string,
  declarations: ToolDeclaration[],
  options?: { maxTools?: number },
): ToolRoute {
  const maxTools = Math.max(8, Math.min(options?.maxTools ?? 48, 80));
  const text = String(userText || '').trim();
  const availableNames = declarations.map(d => d.function.name);
  const available = new Set(availableNames);
  const selected = new Set<string>();
  const categories: string[] = [];
  const reasons: string[] = [];

  for (const name of BASELINE_TOOLS) addIfAvailable(selected, available, name);

  for (const route of ROUTES) {
    if (!routeMatches(route, text)) continue;
    categories.push(route.category);
    reasons.push(route.reason);

    for (const group of route.groups || []) addGroup(selected, available, group);
    for (const name of route.exact || []) addIfAvailable(selected, available, name);
    for (const prefix of route.prefixes || []) addPrefix(selected, availableNames, prefix);
    for (const pattern of route.namePatterns || []) addNamePattern(selected, availableNames, pattern);
  }

  if (categories.length === 0 && text) {
    const ranked = declarations
      .map(declaration => ({ name: declaration.function.name, score: scoreDeclaration(text, declaration) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 16);
    for (const item of ranked) selected.add(item.name);
    if (ranked.length > 0) {
      categories.push('lexical_match');
      reasons.push('tool names/descriptions matched the user wording');
    }
  }

  const ordered = availableNames.filter(name => selected.has(name));
  const truncated = ordered.length > maxTools;
  return {
    toolNames: ordered.slice(0, maxTools),
    categories: unique(categories),
    reasons: unique(reasons),
    totalAvailable: declarations.length,
    maxTools,
    truncated,
  };
}

export function mergeToolPolicyWithRoute(policy: ToolPolicy, route: ToolRoute): ToolPolicy {
  const routeAllowed = new Set(route.toolNames);
  const baseAllowed = new Set(policy.allowedTools || []);
  const allowedTools = baseAllowed.has('*')
    ? route.toolNames
    : route.toolNames.filter(name => baseAllowed.has(name));

  return {
    ...policy,
    allowedTools,
  };
}

export function formatToolRouteForPrompt(route: ToolRoute): string {
  const categories = route.categories.length ? route.categories.join(', ') : 'none';
  const reasons = route.reasons.length ? route.reasons.join('; ') : 'no specific route matched';
  return [
    '## Skill and Tool Routing',
    `This turn exposes ${route.toolNames.length}/${route.totalAvailable} tools to reduce tool noise.`,
    `Selected categories: ${categories}.`,
    `Routing reason: ${reasons}.`,
    route.toolNames.length > 0
      ? `Use only the exposed tools. Prefer the most specific skill tool when one directly matches the task.`
      : 'No tool matched strongly. Answer naturally or ask one clarification question instead of inventing tool work.',
  ].join('\n');
}
