import { ToolPolicy } from '../personality/types';
import { ToolRegistry } from '../tools/registry';
import { mcpManager } from '../mcp/client';
import { requiresVisibleAutoCadExecution } from './action_contract';

type ToolDeclaration = ReturnType<ToolRegistry['getToolDeclarations']>[number];

export interface ToolRoute {
  toolNames: string[];
  categories: string[];
  reasons: string[];
  totalAvailable: number;
  maxTools: number;
  truncated: boolean;
  unavailableMcpServers?: string[];
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
    'external_control_candidates',
    'mcp_playwright_browser_snapshot',
    'mcp_playwright_browser_navigate',
    'mcp_playwright_browser_click',
    'mcp_playwright_browser_fill_form',
    'mcp_playwright_browser_type',
    'mcp_playwright_browser_take_screenshot',
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
  publicPost: [
    'browser_open_task',
    'mcp_playwright_browser_snapshot',
    'mcp_playwright_browser_navigate',
    'mcp_playwright_browser_click',
    'mcp_playwright_browser_fill_form',
    'mcp_playwright_browser_type',
    'mcp_playwright_browser_take_screenshot',
    'desktop_active_window',
    'desktop_ui_snapshot',
    'desktop_capture_screen',
    'desktop_ui_focus',
    'desktop_ui_click',
    'desktop_ui_type',
    'write_clipboard',
    'computer_use',
    'web_login_run',
    'web_login_profile_list',
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
    'legal_case_workspace',
    'legal_case_workflow_status',
    'legal_message_intake_to_case',
    'legal_meeting_minutes_to_case',
    'legal_case_reasoning_matrix',
    'legal_generate_litigation_packet',
    'legal_prepare_filing_handoff',
    'legal_extract_dispute_focus',
    'legal_generate_argument_or_opinion',
    'legal_analyze_folder_and_draft_argument',
    'legal_import_materials_to_kb',
    'legal_process_notice_link',
    'legal_download_and_extract_document',
    'legal_external_source_status',
    'legal_search_external_authorities',
    'legal_company_database_lookup',
    'legal_external_research_plan',
    'legal_generate_citation_verification_report',
    'legal_finalize_delivery_package',
    'legal_prepare_external_browser_workspace',
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
    'cad_generate_autocad_draw_script',
    'cad_run_autocad_draw_script',
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
    'desktop_show_lumi_window',
    'desktop_idle_time',
    'desktop_poll_activity',
    'desktop_ui_snapshot',
    'get_running_processes',
    'desktop_running_processes',
    'get_active_window_info',
    'desktop_active_window',
    'capture_screen',
    'desktop_capture_screen',
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
    'capability_gap_autofix',
    'capability_learning_list',
    'capability_research',
    'external_control_candidates',
    'external_control_configure_candidate',
    'adapter_registry_list',
    'external_app_list_adapters',
  ],
  externalControl: [
    'external_control_candidates',
    'external_control_configure_candidate',
    'desktop_ui_snapshot',
    'desktop_ui_focus',
    'desktop_ui_click',
    'desktop_ui_invoke',
    'desktop_ui_type',
    'read_clipboard',
    'write_clipboard',
    'mouse_move',
    'mouse_click',
    'mouse_drag',
    'keyboard_type',
    'keyboard_press',
    'computer_use',
    'mcp_playwright_browser_snapshot',
    'mcp_playwright_browser_navigate',
    'mcp_playwright_browser_click',
    'mcp_playwright_browser_fill_form',
  ],
  messaging: [
    'desktop_list_apps',
    'desktop_open',
    'desktop_active_window',
    'desktop_ui_focus',
    'desktop_ui_snapshot',
    'desktop_capture_screen',
    'ocr_screen',
    'wechat_read_recent_chat',
    'wechat_prepare_reply',
    'wechat_copy_reply_draft',
    'wechat_send_message',
    'desktop_mouse_click_at',
    'desktop_cursor_glow_show',
    'desktop_cursor_glow_update',
    'desktop_cursor_glow_click',
    'desktop_cursor_glow_hide',
    'desktop_keyboard_press',
    'browser_open_task',
    'external_app_list_adapters',
  ],
  workTakeover: [
    'work_takeover_task_create',
    'work_takeover_task_from_wechat',
    'work_takeover_task_from_clipboard',
    'work_takeover_task_list',
    'work_takeover_task_get',
    'work_takeover_task_update',
    'work_takeover_task_continue',
    'work_takeover_task_orchestrate',
    'work_takeover_task_execute_step',
    'work_takeover_task_advance',
    'work_takeover_task_autorun',
    'work_takeover_capability_reuse_probe',
    'work_takeover_real_smoke_run',
    'work_takeover_task_prepare_industry_package',
    'work_takeover_task_verify_result',
    'work_takeover_task_export_packet',
    'work_takeover_task_run_suggested_tool',
  ],
  autonomy: [
    'autonomy_get_policy',
    'autonomy_list_workflows',
    'autonomy_register_workflow',
    'autonomy_set_workflow_enabled',
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
      /法律|律师|律所|案件|案号|案由|类案|法条|法院|裁判文书|人民法院案例库|法信|法蝉|企查查|天眼查|北大法宝|法睿|通义法睿|法律数据库|权威库|国家企业信用|委托书|代理词|证据目录|起诉状|要素式诉状|答辩状|质证|文书包|正式文书|交付包|引用核验|核验报告|校验报告|来源登记|浏览器工作区|网页登录工作区|立案|网上立案|立案网|法院在线服务|外部检索|法律意见书|合同审查|合同模板|标书|投标书|财产线索|被执行人|股权穿透|诉讼|仲裁|争议焦点|庭审笔录|庭审提纲|三段论|大前提|小前提|涵摄|法律会议|律师会议|办案会议|案件会议|会议纪要.*案件|沟通记录.*案件|法律分析|应对策略|焦点提炼|案件文件夹|材料文件夹|文件夹.*代理词|文书链接|发送链接|下载文书|提取文书|提取正文|链接.*下载|链接.*提取|材料入库|导入知识库|知识库导入|入案|自动入案|远程消息.*案件|Lumi bot.*案件|机器人.*案件|外部数据源|数据源接入|开庭通知|法院通知|送达通知|短信链接|通知链接|送达链接/u,
      /\b(legal|lawyer|lawsuit|court|judgment|casework|contract\s+review|power\s+of\s+attorney|complaint|defense|pleading|evidence|filing|bid|tender|qichacha|tianyancha|pkulaw|pku\s*law|beida\s*fabo|farui|tongyi\s*farui|legal\s+database|authority\s+database|external\s+authority|alpha|fachan|notice\s+link|court\s+notice|document\s+link|extract\s+document|delivery\s+package|citation\s+verification|source\s+register|browser\s+workspace)\b/i,
    ],
    exact: ['mcp_legal-casework_legal_case_folder_workflow'],
    prefixes: ['mcp_legal-casework_'],
    namePatterns: [/^legal_/, /^web_login_/, /^url_fetch_logged_in$/, /^mcp_playwright_/],
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
      /(?:\u5f55\u97f3|\u97f3\u9891|\u8bed\u97f3).*(?:\u7b14\u5f55|\u8c08\u8bdd\u7b14\u5f55|\u8be2\u95ee\u7b14\u5f55|\u7eaa\u8981|\u6750\u6599|\u6574\u7406|\u8bb0\u5f55)|(?:\u7b14\u5f55|\u8c08\u8bdd\u7b14\u5f55|\u8be2\u95ee\u7b14\u5f55|\u7eaa\u8981|\u6750\u6599).*(?:\u5f55\u97f3|\u97f3\u9891|\u8bed\u97f3)/u,
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
      /(?:\u603b\u7ed3|\u6458\u8981|\u5f52\u7eb3|\u63d0\u70bc|\u5206\u6790).*(?:\u6587\u4ef6|\u6587\u6863|\u8d44\u6599|\u8fd9\u4efd|\u8fd9\u4e2a)|(?:\u6587\u4ef6|\u6587\u6863|\u8d44\u6599|\u8fd9\u4efd|\u8fd9\u4e2a).*(?:\u603b\u7ed3|\u6458\u8981|\u5f52\u7eb3|\u63d0\u70bc|\u5206\u6790)/u,
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
      /(?:淘宝|天猫|京东|抖店|拼多多|小红书|抖音|快手|视频号).*(?:后台|商家|店铺|账号|登录|登陆)/u,
      /\b(login|log\s*in|sign\s*in|account|password|credential|session|authenticated|auth|2fa|otp|captcha|dashboard|seller\s*center|creator\s*center)\b/i,
    ],
    prefixes: ['mcp_playwright_'],
    groups: ['web', 'authenticatedWeb'],
  },
  {
    category: 'public_post',
    reason: 'public website comment, post, like, or creator-platform publishing request',
    patterns: [
      /(?:\u89c6\u9891\u7f51\u7ad9|\u77ed\u89c6\u9891|\u521b\u4f5c\u8005\u5e73\u53f0|\u8d26\u53f7|\u7f51\u7ad9|\u7f51\u9875).*(?:\u8bc4\u8bba|\u53d1\u5e03|\u70b9\u8d5e|\u6295\u7a3f|\u56de\u590d)|(?:\u8bc4\u8bba|\u53d1\u5e03|\u70b9\u8d5e|\u6295\u7a3f|\u56de\u590d).*(?:\u89c6\u9891\u7f51\u7ad9|\u77ed\u89c6\u9891|\u521b\u4f5c\u8005\u5e73\u53f0|\u8d26\u53f7|\u7f51\u7ad9|\u7f51\u9875|\u89c6\u9891)/u,
      /\b(?:video\s*site|creator\s*platform|social|website|web\s*page|account)\b.*\b(?:comment|post|publish|like|reply)\b/i,
      /\b(?:comment|post|publish|like|reply)\b.*\b(?:video\s*site|creator\s*platform|social|website|web\s*page|account|video)\b/i,
    ],
    namePatterns: [/^mcp_playwright_/],
    groups: ['publicPost', 'web', 'authenticatedWeb'],
  },
  {
    category: 'web_research',
    reason: 'web search, source verification, or current information request',
    patterns: [
      /搜索|查询|查一下|查一查|查找|联网|浏览|网页|网址|链接|资料来源|出处|引用|官方|验证|调研/u,
      /(?:\u641c\u4e00\u4e0b|\u641c\u4e00\u641c|\u5e2e(?:\u6211)?.*\u641c)/u,
      /\b(search|look\s*up|browse|fetch|research|source|citation|official|verify)\b/i,
    ],
    prefixes: ['mcp_fetcher_', 'mcp_web-fetcher-pro_'],
    namePatterns: [/^mcp_playwright_/],
    groups: ['web', 'authenticatedWeb'],
  },
  {
    category: 'market_finance',
    reason: 'stock market quote, trading plan, or paper trading request',
    patterns: [
      /股票|A股|美股|港股|财经|财报|行情|股价|K线|大盘|板块|涨停|跌停|上证|深证|创业板|沪深|换手率|市盈率|PE|PB|市值|炒股|买入|卖出|仓位|止损|止盈|交易计划|模拟盘|纸上交易|持仓|股票池|投资组合|证券/u,
      /(?:\u770b\u76d8|\u76ef\u76d8|\u76d8\u4e2d|\u76d8\u540e|\u80a1\u5e02\u8f85\u52a9|\u884c\u60c5\u8f85\u52a9|\u770b\u76d8\u8f85\u52a9|\u81ea\u9009\u80a1|\u80a1\u7968\u6c60|\u76d8\u4e2d\u63d0\u9192|\u4ef7\u683c\u9884\u8b66|\u5f02\u52a8\u76d1\u63a7)/u,
      /\b(stock|share|equity|quote|kline|candlestick|market\s*index|sector|portfolio|watchlist|market\s*watch|stock\s*watch|price\s*alert|market\s*alert|paper\s*trade|trading\s*plan|stop\s*loss|take\s*profit|position\s*sizing|A-share|A\s*stock)\b/i,
    ],
    prefixes: ['mcp_stockbot_'],
    groups: ['web', 'autonomy'],
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
    category: 'external_control',
    reason: 'external software, browser DOM, or native UI control request',
    patterns: [
      /外部软件|桌面控制|控件树|结构化浏览器|原生控件|窗口控件|按钮|输入框|Playwright|UIA|pywinauto|Windows UI Automation/u,
      /\b(external\s+software|desktop\s+control|control\s+tree|native\s+control|playwright|uia|pywinauto|windows\s+ui\s+automation)\b/i,
    ],
    groups: ['externalControl'],
  },
  {
    category: 'system',
    reason: 'system, runtime, diagnostics, or repair request',
    patterns: [
      /系统|运行时|日志|报错|错误|卡住|诊断|修复|健康|进程|后台|窗口|桌面|屏幕|空间|磁盘|C盘|D盘/u,
      /\b(system|runtime|log|error|crash|stuck|diagnose|repair|process|desktop|screen|window|uia|automation|accessibility|disk|storage)\b/i,
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
      /技能|技能大厅|MCP|工具|智能体|agent|外部agent|外部应用|外部软件|连接.*agent|接入|插件|能力|补能力|学会|自学习|沉淀能力|能力缺口|Playwright|UIA|控件树|结构化浏览器|桌面控制/u,
      /\b(skill|mcp|tool|agent|adapter|external\s+app|external\s+software|plugin|capability|autofix|learned\s+route|capability\s+gap|playwright|uia|pywinauto|control\s+tree)\b/i,
    ],
    prefixes: ['mcp_hermes_'],
    namePatterns: [/^mcp_playwright_/],
    groups: ['skills'],
  },
  {
    category: 'work_takeover',
    reason: 'work takeover, real closed-loop task run, or capability reuse pressure test',
    patterns: [
      /工作接管|接管.*微信|接管.*客户|真实闭环|先跑一遍|跑出结果|能力复用|压测|重复能力|会不会重复|稳不稳定|稳定性|任务中心/u,
      /(?:\u7ee7\u7eed|\u63a5\u7740|\u5f80\u4e0b).*(?:\u4efb\u52a1|\u5ba2\u6237|\u4ea4\u4ed8|\u63a5\u7ba1|\u5de5\u4f5c|\u9879\u76ee)/u,
      /\b(work\s*takeover|real\s*smoke|closed\s*loop|capability\s*reuse|pressure\s*test|task\s*center|take\s*over)\b/i,
    ],
    groups: ['workTakeover', 'skills'],
  },
  {
    category: 'messaging',
    reason: 'Feishu, WeChat, WeCom, or remote messaging request',
    patterns: [
      /飞书|微信|企业微信|WeCom|消息|回消息|远程协作|绑定码/u,
      /(?:\u56de\u4e00\u4e0b|\u56de\u590d|\u56de|\u8349\u7a3f).*(?:\u5fae\u4fe1|\u4f01\u4e1a\u5fae\u4fe1|\u98de\u4e66|\u6d88\u606f|\u5ba2\u6237)|(?:\u5fae\u4fe1|\u4f01\u4e1a\u5fae\u4fe1|\u98de\u4e66|\u6d88\u606f|\u5ba2\u6237).*(?:\u56de\u590d|\u56de\u4e00\u4e0b|\u56de|\u8349\u7a3f)/u,
      /(?:\u770b\u770b|\u67e5\u770b|\u770b\u4e00\u4e0b|\u8bfb\u53d6|\u8bfb|\u6700\u8fd1|\u603b\u7ed3).*(?:\u5fae\u4fe1|\u804a\u5929|\u804a\u5929\u8bb0\u5f55|\u804a\u5929\u5185\u5bb9|\u6d88\u606f)|(?:\u5fae\u4fe1|\u804a\u5929|\u804a\u5929\u8bb0\u5f55|\u804a\u5929\u5185\u5bb9|\u6d88\u606f).*(?:\u770b\u770b|\u67e5\u770b|\u770b\u4e00\u4e0b|\u8bfb\u53d6|\u8bfb|\u6700\u8fd1|\u603b\u7ed3)/u,
      /(?:\u53d1\u4e00\u4e0b|\u53d1\u4e00\u6761|\u53d1\u9001|\u53d1\u7ed9|\u8f6c\u53d1|\u7c98\u8d34|\u8d34\u5230|\u53d1).*(?:\u95ee\u5019\u8bed|\u95ee\u5019|\u5bd2\u6684|\u62db\u547c|\u5fae\u4fe1|\u4f01\u4e1a\u5fae\u4fe1|\u6d88\u606f|\u5ba2\u6237|\u8054\u7cfb\u4eba|\u7fa4)|(?:\u95ee\u5019\u8bed|\u95ee\u5019|\u5bd2\u6684|\u62db\u547c|\u5fae\u4fe1|\u4f01\u4e1a\u5fae\u4fe1|\u6d88\u606f|\u5ba2\u6237|\u8054\u7cfb\u4eba|\u7fa4).*(?:\u53d1\u4e00\u4e0b|\u53d1\u4e00\u6761|\u53d1\u9001|\u53d1\u7ed9|\u8f6c\u53d1|\u7c98\u8d34|\u8d34\u5230|\u53d1)/u,
      /(?:\u53d1\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})|(?:\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32}\s*(?:\u53d1\u9001|\u53d1|\u56de\u590d|\u8bf4|\u544a\u8bc9))|(?:(?:\u53d1\u9001|\u53d1)\s*[\s\S]{1,200}?\s*\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32})/u,
      /\b(feishu|lark|wechat|wecom|message|reply)\b/i,
    ],
    prefixes: ['mcp_messaging-ops_'],
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

function isDirectMessagingSend(text: string): boolean {
  return /(?:\u76f4\u63a5\u53d1|\u4f60\u6765\u53d1|\u5e2e\u6211\u53d1|\u53d1\u9001|\u53d1\u7ed9|\u53d1\u4e00\u4e0b|\u53d1\u4e00\u6761|\b(?:send|message)\b|(?:\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32}\s*(?:\u53d1\u9001|\u53d1|\u56de\u590d|\u8bf4|\u544a\u8bc9))|(?:(?:\u53d1\u9001|\u53d1)\s*[\s\S]{1,200}?\s*\u7ed9\s*[^\s,\uFF0C\u3002\uFF01\uFF1F!?:\uFF1A;\uFF1B\u3001]{1,32}))/iu.test(text)
    && !/(?:\u8349\u7a3f|\u7f16\u8f91\u4e00\u4e0b|\u5148\u5199|\u4e0d\u8981\u53d1|\bdraft\b)/iu.test(text);
}

function isMessagingRead(text: string): boolean {
  if (isDirectMessagingSend(text)) return false;
  return /(?:wechat|weixin|\u5fae\u4fe1|\u804a\u5929|\u804a\u5929\u8bb0\u5f55|\u804a\u5929\u5185\u5bb9|\u6d88\u606f).*(?:\u770b\u770b|\u67e5\u770b|\u770b\u4e00\u4e0b|\u8bfb\u53d6|\u8bfb|\u6700\u8fd1|\u804a\u5929\u5185\u5bb9|\u804a\u5929\u8bb0\u5f55|\u603b\u7ed3)|(?:\u770b\u770b|\u67e5\u770b|\u770b\u4e00\u4e0b|\u8bfb\u53d6|\u8bfb|\u6700\u8fd1|\u603b\u7ed3).*(?:wechat|weixin|\u5fae\u4fe1|\u804a\u5929|\u804a\u5929\u8bb0\u5f55|\u804a\u5929\u5185\u5bb9|\u6d88\u606f)/iu.test(text);
}

function isLocalCadSourceRequest(text: string): boolean {
  const raw = String(text || '');
  const hasLocalSource =
    /\b(?:desktop|local|folder|directory|path|files?)\b/i.test(raw)
    || /(?:\u684c\u9762|\u672c\u5730|\u6587\u4ef6\u5939|\u76ee\u5f55|\u8def\u5f84|\u91cc\u9762|\u5185\u5bb9|\u8d44\u6599)/u.test(raw);
  const hasSourceReading =
    /\b(?:read|scan|inspect|according\s+to|based\s+on|from)\b/i.test(raw)
    || /(?:\u8bfb\u53d6|\u8bfb|\u626b\u63cf|\u67e5\u770b|\u6574\u7406|\u6309\u7167|\u6839\u636e|\u4f9d\u636e|\u91cc\u9762\u7684|\u5185\u5bb9)/u.test(raw);
  const hasCadTarget =
    /\b(?:cad|dxf|dwg|autocad|draw|draft|floor\s*plan)\b/i.test(raw)
    || /(?:\u56fe\u7eb8|\u753b\u56fe|\u753b\u51fa\u6765|\u7ed8\u5236|\u5b9e\u64cd|\u5b9e\u9645\u753b|\u5e73\u9762\u56fe|\u65bd\u5de5\u56fe)/u.test(raw);
  return hasLocalSource && hasSourceReading && hasCadTarget;
}

function priorityToolsForRoute(categories: string[], text: string): string[] {
  const priorities: string[] = [];
  if (categories.includes('messaging')) {
    if (isMessagingRead(text)) {
      priorities.push(
        'wechat_read_recent_chat',
        'desktop_open',
        'desktop_active_window',
        'desktop_ui_snapshot',
        'desktop_capture_screen',
        'ocr_screen',
      );
    } else if (isDirectMessagingSend(text)) {
      priorities.push(
        'wechat_send_message',
        'desktop_open',
        'desktop_active_window',
        'desktop_mouse_click_at',
        'desktop_cursor_glow_show',
        'desktop_cursor_glow_update',
        'desktop_cursor_glow_click',
        'desktop_cursor_glow_hide',
        'desktop_keyboard_press',
      );
    } else {
      priorities.push(
        'wechat_prepare_reply',
        'wechat_copy_reply_draft',
        'desktop_open',
        'desktop_active_window',
        'desktop_ui_snapshot',
      );
    }
  }
  if (categories.includes('public_post')) {
    priorities.push(
      'browser_open_task',
      'mcp_playwright_browser_snapshot',
      'mcp_playwright_browser_navigate',
      'mcp_playwright_browser_click',
      'mcp_playwright_browser_fill_form',
      'desktop_active_window',
      'desktop_ui_snapshot',
      'desktop_capture_screen',
      'write_clipboard',
    );
  }
  if (categories.includes('authenticated_web')) {
    priorities.push(
      'web_login_profile_list',
      'web_login_profile_save_from_preset',
      'web_login_run',
      'url_fetch_logged_in',
      'browser_open_task',
      'mcp_playwright_browser_snapshot',
      'mcp_playwright_browser_navigate',
      'mcp_playwright_browser_click',
      'mcp_playwright_browser_fill_form',
      'desktop_active_window',
      'desktop_ui_snapshot',
      'desktop_capture_screen',
    );
  }
  if (categories.includes('market_finance')) {
    priorities.push(
      'mcp_stockbot_stock_quote',
      'mcp_stockbot_stock_kline',
      'mcp_stockbot_market_index',
      'mcp_stockbot_hot_sectors',
      'mcp_stockbot_stock_news',
      'autonomy_get_policy',
      'autonomy_list_workflows',
      'autonomy_register_workflow',
      'mcp_stockbot_stock_trade_plan',
      'mcp_stockbot_paper_portfolio',
      'browser_open_task',
      'mcp_playwright_browser_snapshot',
    );
  }
  if (categories.includes('cad_design')) {
    if (isLocalCadSourceRequest(text)) {
      const localCadSourceTools = requiresVisibleAutoCadExecution(text)
        ? [
            'desktop_path_info',
            'desktop_list_files',
            'floorplan_extract_geometry',
            'ocr_image_file',
            'cad_generate_dxf',
            'cad_generate_autocad_draw_script',
            'cad_run_autocad_draw_script',
            'mcp_cad-drafting_cad_renovation_folder_workflow',
            'desktop_capture_screen',
          ]
        : [
            'desktop_path_info',
            'desktop_list_files',
            'floorplan_extract_geometry',
            'ocr_image_file',
            'mcp_cad-drafting_cad_renovation_folder_workflow',
            'cad_generate_dxf',
            'cad_generate_autocad_draw_script',
            'cad_run_autocad_draw_script',
            'desktop_capture_screen',
          ];
      priorities.push(...localCadSourceTools);
    } else {
      priorities.push(
        'cad_generate_dxf',
        'cad_generate_autocad_draw_script',
        'cad_run_autocad_draw_script',
        'mcp_cad-drafting_cad_space_program',
        'mcp_cad-drafting_cad_renovation_folder_workflow',
        'desktop_capture_screen',
      );
    }
  }
  if (categories.includes('legal')) {
    if (/案件文件夹|材料文件夹|文件夹.*(?:代理词|证据目录|委托书|起诉状|答辩状)|读取.*(?:案件|材料).*文件夹|case\s*folder|legal\s*folder/i.test(text)) {
      priorities.push(
        'mcp_legal-casework_legal_case_folder_workflow',
        'legal_analyze_folder_and_draft_argument',
        'read_file',
        'extract_document_text',
        'web_login_run',
        'url_fetch_logged_in',
      );
    }
    if (/(?:飞书|微信|企业微信|企微|短信|远程消息|Lumi\s*bot|机器人).*(?:入案|归档|保存|案件|案号|材料|法院|通知|短信链接|通知链接|链接)|(?:入案|归档|保存).*(?:飞书|微信|企业微信|企微|短信|远程消息|案件材料|法院通知|短信链接|通知链接)|(?:court\s+notice|notice\s+link|sms\s+link|message\s+intake)/i.test(text)) {
      priorities.push(
        'legal_message_intake_to_case',
        'legal_process_notice_link',
        'legal_case_workflow_status',
        'legal_case_workspace',
        'legal_import_materials_to_kb',
      );
    }
    if (/合同审查|合同模板|合同起草|审查合同|起草合同|标书|投标|招标|bid|tender|contract\s+(review|draft)/i.test(text)) {
      priorities.push(
        'legal_review_contract',
        'legal_draft_contract',
        'legal_generate_bid',
      );
    }
    if (/财产线索|被执行人|执行线索|财产保全|诉前保全|股权穿透|实际控制人|关联企业|失信|限制消费|asset|enforcement|equity|shareholder/i.test(text)) {
      priorities.push(
        'legal_trace_assets',
        'legal_equity_penetration',
        'legal_company_database_lookup',
      );
    }
    if (/下一步|下.?一步|缺什么|还缺|完成度|闭环|状态|进度|能不能.*(交付|立案|起草)|case\s*(status|progress|next)|what.*next/i.test(text)) {
      priorities.push(
        'legal_case_workflow_status',
        'legal_case_workspace',
      );
    }
    if (/\u4ee3\u7406\u8bcd|\u8d77\u8bc9\u72b6|\u7b54\u8fa9\u72b6|\u8d28\u8bc1|\u6cd5\u5f8b\u610f\u89c1|\u8bc9\u72b6|\u6587\u4e66|\u8bc9\u8bbc\u6750\u6599|argument|opinion|complaint|defense|pleading/i.test(text)) {
      priorities.push(
        'legal_analyze_folder_and_draft_argument',
        'legal_generate_argument_or_opinion',
        'legal_case_reasoning_matrix',
        'legal_generate_citation_verification_report',
        'read_docx',
        'read_pdf',
        'create_docx',
      );
    }
    priorities.push(
      'legal_case_workspace',
      'legal_case_workflow_status',
      'legal_message_intake_to_case',
      'legal_process_notice_link',
      'legal_import_materials_to_kb',
      'legal_meeting_minutes_to_case',
      'legal_case_reasoning_matrix',
      'legal_external_research_plan',
      'legal_search_external_authorities',
      'legal_company_database_lookup',
      'legal_analyze_folder_and_draft_argument',
      'legal_generate_argument_or_opinion',
      'legal_extract_dispute_focus',
      'legal_generate_litigation_packet',
      'legal_case_strategy',
      'legal_search_case',
      'legal_search_statute',
      'read_docx',
      'read_pdf',
      'create_docx',
    );
  }
  return unique(priorities);
}

function applyRoutePriority(ordered: string[], priorities: string[]): string[] {
  if (!priorities.length) return ordered;
  const available = new Set(ordered);
  const prioritySet = new Set(priorities);
  return [
    ...priorities.filter(name => available.has(name)),
    ...ordered.filter(name => !prioritySet.has(name)),
  ];
}

function getMcpServerName(toolName: string): string | null {
  const match = toolName.match(/^mcp_(.+?)_/);
  return match?.[1] || null;
}

function getConnectedMcpGate(options?: {
  connectedMcpServers?: string[];
  enableMcpHealthGate?: boolean;
}): Set<string> | null {
  if (options?.enableMcpHealthGate === false) return null;
  if (options?.connectedMcpServers) return new Set(options.connectedMcpServers);
  try {
    const connected = mcpManager.getConnectedServers();
    // In isolated tests or before MCP startup, no runtime signal exists. Do not
    // hide synthetic MCP declarations unless the caller provided an explicit gate.
    return connected.length ? new Set(connected) : null;
  } catch {
    return null;
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
  options?: {
    maxTools?: number;
    connectedMcpServers?: string[];
    enableMcpHealthGate?: boolean;
  },
): ToolRoute {
  const maxTools = Math.max(8, Math.min(options?.maxTools ?? 64, 80));
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

  const orderedBeforeHealthGate = applyRoutePriority(
    availableNames.filter(name => selected.has(name)),
    priorityToolsForRoute(categories, text),
  );
  const connectedMcpGate = getConnectedMcpGate(options);
  const unavailableMcpServers: string[] = [];
  const ordered = connectedMcpGate
    ? orderedBeforeHealthGate.filter(name => {
        const serverName = getMcpServerName(name);
        if (!serverName) return true;
        if (connectedMcpGate.has(serverName)) return true;
        unavailableMcpServers.push(serverName);
        return false;
      })
    : orderedBeforeHealthGate;

  if (unavailableMcpServers.length) {
    reasons.push(`MCP health gate skipped unavailable servers: ${unique(unavailableMcpServers).join(', ')}`);
  }

  const truncated = ordered.length > maxTools;
  return {
    toolNames: ordered.slice(0, maxTools),
    categories: unique(categories),
    reasons: unique(reasons),
    totalAvailable: declarations.length,
    maxTools,
    truncated,
    unavailableMcpServers: unique(unavailableMcpServers),
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
    route.unavailableMcpServers?.length
      ? `MCP health gate skipped unavailable servers: ${route.unavailableMcpServers.join(', ')}. Use a connected fallback or repair/configure the skill before relying on it.`
      : '',
    route.toolNames.length > 0
      ? `Use only the exposed tools. Prefer the most specific skill tool when one directly matches the task.`
      : 'No tool matched strongly. Answer naturally or ask one clarification question instead of inventing tool work.',
  ].filter(Boolean).join('\n');
}
