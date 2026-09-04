export interface RouteDefinition {
  category: string;
  reason: string;
  patterns: RegExp[];
  exact?: string[];
  prefixes?: string[];
  namePatterns?: RegExp[];
  groups?: string[];
}

export const BASELINE_TOOLS = [
  'work_product_plan',
  'work_product_verify',
];

export const ROUTES: RouteDefinition[] = [
  {
    category: 'knowledge',
    reason: 'knowledge-base inventory or indexing-status request',
    patterns: [
      // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
      /知识库.{0,24}(?:多少|几个|文件|内容|索引|状态)|(?:多少|几个|文件|内容|索引|状态).{0,24}知识库/u,
      /\bknowledge\s+base\b.{0,32}\b(?:count|files?|content|index|status)\b/i,
    ],
    groups: ['knowledge'],
  },
  {
    category: 'legal',
    reason: 'legal casework or legal research request',
    patterns: [
      /法律|律师|律所|案件|案号|案由|类案|法条|法源|现行有效|法律版本|司法解释版本|法院|裁判文书|人民法院案例库|法信|法蝉|企查查|天眼查|北大法宝|法睿|通义法睿|法律数据库|权威库|国家企业信用|委托书|代理词|证据目录|起诉状|要素式诉状|答辩状|质证|文书包|正式文书|交付包|引用核验|核验报告|校验报告|来源登记|浏览器工作区|网页登录工作区|立案|网上立案|立案网|法院在线服务|外部检索|法律意见书|合同审查|合同模板|标书|投标书|财产线索|被执行人|股权穿透|诉讼|仲裁|争议焦点|庭审笔录|庭审提纲|三段论|大前提|小前提|涵摄|法律会议|律师会议|办案会议|案件会议|会议纪要.*案件|沟通记录.*案件|法律分析|应对策略|焦点提炼|案件文件夹|材料文件夹|文件夹.*代理词|文书链接|发送链接|下载文书|提取文书|提取正文|链接.*下载|链接.*提取|材料入库|导入知识库|知识库导入|入案|自动入案|远程消息.*案件|Lumi bot.*案件|机器人.*案件|外部数据源|数据源接入|开庭通知|法院通知|送达通知|短信链接|通知链接|送达链接/u,
      /\b(legal|lawyer|lawsuit|court|judgment|casework|contract\s+review|power\s+of\s+attorney|complaint|defense|pleading|filing|bid|tender|qichacha|tianyancha|pkulaw|pku\s*law|beida\s*fabo|farui|tongyi\s*farui|legal\s+database|authority\s+database|external\s+authority|alpha|fachan|notice\s+link|court\s+notice|document\s+link|extract\s+document|delivery\s+package|citation\s+verification|source\s+register|browser\s+workspace)\b/i,
    ],
    exact: ['mcp_legal-casework_legal_case_folder_workflow'],
    prefixes: ['mcp_legal-casework_'],
    namePatterns: [/^legal_/, /^web_login_/, /^url_fetch_logged_in$/, /^mcp_playwright_/],
    groups: ['legal', 'files', 'documents', 'web', 'authenticatedWeb'],
  },
  {
    category: 'music',
    reason: 'desktop music-player launch or playback control request',
    patterns: [
      // i18n-allow: Chinese desktop media-control intent recognition; not user-visible copy.
      /(?:音乐|歌曲|歌单|网易云|QQ音乐|酷狗|Spotify).{0,32}(?:打开|启动|播放|暂停|继续|切歌|上一首|下一首|搜索|音量)|(?:打开|启动|播放|放|听|暂停|继续播放|切歌|上一首|下一首|搜索).{0,32}(?:音乐|歌曲|歌单|网易云|QQ音乐|酷狗|Spotify)/u,
      /\b(?:open|launch|play|pause|resume|skip|next|previous|search)\b.{0,40}\b(?:music|song|playlist|netease|spotify|music player)\b|\b(?:music|song|playlist|netease|spotify|music player)\b.{0,40}\b(?:open|launch|play|pause|resume|skip|next|previous|search)\b/i,
    ],
    groups: ['music'],
  },
  {
    category: 'image_generation',
    reason: 'direct image-generation request',
    patterns: [
      // Keep ordinary media creation separate from CAD/desktop production.
      /^(?:生成|创建|制作)图片\s*(?:\r?\n|$)/u,
      /^(?:generate|create|make) (?:an? |some )?images?\s*(?:\r?\n|$)/iu,
      /^(?![\s\S]*(?:CAD|DXF|DWG|AutoCAD|平面图|户型|施工图|水电|布置图|工程图|图纸|蓝图|立面图|剖面图|零件图|电气原理图|结构详图|管线图))(?:(?:请|麻烦)(?:你)?|可以|能否|能不能|能|我想|我需要)?(?:帮我|给我|替我|为我)?(?:生成|创建|制作|产出|画|绘制)[\s\S]{0,72}(?:视频|短视频)[\s\S]{0,28}(?:封面(?:图|图片)?|主图|缩略图|海报图片?)/iu,
      /^(?![\s\S]*(?:CAD|DXF|DWG|AutoCAD|平面图|户型|施工图|水电|布置图|工程图|图纸|蓝图|立面图|剖面图|零件图|电气原理图|结构详图|管线图))(?:(?:请|麻烦)(?:你)?|可以|能否|能不能|能|我想|我需要)?(?:帮我|给我|替我|为我)?(?:为|根据|用|把|将)[\s\S]{0,36}(?:视频|短视频)[\s\S]{0,36}(?:生成|创建|制作|产出)[\s\S]{0,28}(?:图片|图像|封面(?:图|图片)?|主图|缩略图|海报)/iu,
      /^(?![\s\S]*(?:CAD|DXF|DWG|AutoCAD|平面图|户型|施工图|水电|布置图|工程图|图纸|蓝图|立面图|剖面图|零件图|电气原理图|结构详图|管线图))(?:(?:请|麻烦)(?:你)?|可以|能否|能不能|能|我想|我需要)?(?:帮我|给我|替我|为我)?(?:生成|创建|制作|产出|画|绘制)(?:一张|一个|一些|几张)?[\s\S]{0,80}(?:图片|图像|插画|海报|封面|壁纸|主图|效果图|缩略图|图)(?:吗)?(?:[，。！？,.!?\s]|$)/iu,
      /^(?![\s\S]*\b(?:cad|dxf|dwg|autocad|floor\s*plan|blueprint|construction\s+drawing|elevation\s+drawing|section\s+drawing|mechanical\s+(?:part\s+)?drawing|electrical\s+schematic|structural\s+detail|piping\s+diagram)\b)(?:please\s+)?(?:(?:could|can|would|will)\s+you\s+)?(?:please\s+)?(?:generate|create|make|produce|draw|illustrate)\b.{0,72}\b(?:video|clip|movie|short\s+film|reel)\b.{0,24}\b(?:cover|thumbnail|poster)\s*(?:image|picture)?\b/iu,
      /^(?![\s\S]*\b(?:cad|dxf|dwg|autocad|floor\s*plan|blueprint|construction\s+drawing|elevation\s+drawing|section\s+drawing|mechanical\s+(?:part\s+)?drawing|electrical\s+schematic|structural\s+detail|piping\s+diagram)\b)(?:please\s+)?(?:(?:could|can|would|will)\s+you\s+)?(?:please\s+)?(?:generate|create|make|produce|draw|illustrate)\b.{0,48}\b(?:cover|thumbnail|poster)\s*(?:image|picture)?\b.{0,28}\b(?:for|from)\b.{0,16}\b(?:video|clip|movie|short\s+film|reel)\b/iu,
      /^(?![\s\S]*\b(?:cad|dxf|dwg|autocad|floor\s*plan|blueprint|construction\s+drawing|elevation\s+drawing|section\s+drawing|mechanical\s+(?:part\s+)?drawing|electrical\s+schematic|structural\s+detail|piping\s+diagram)\b)(?:please\s+)?(?:(?:could|can|would|will)\s+you\s+)?(?:please\s+)?(?:generate|create|make|produce|draw|illustrate)\b.{0,56}\b(?:image|picture|illustration|poster|cover|wallpaper|thumbnail|artwork)\b.{0,36}\bfrom\b.{0,20}\b(?:video|clip|movie|short\s+film|reel)\b/iu,
      /^(?![\s\S]*\b(?:cad|dxf|dwg|autocad|floor\s*plan|blueprint|construction\s+drawing|elevation\s+drawing|section\s+drawing|mechanical\s+(?:part\s+)?drawing|electrical\s+schematic|structural\s+detail|piping\s+diagram|video|clip|movie|short\s+film|reel)\b)(?:please\s+)?(?:(?:could|can|would|will)\s+you\s+)?(?:please\s+)?(?:generate|create|make|produce|draw|illustrate)\b.{0,80}\b(?:image|picture|illustration|poster|cover|wallpaper|thumbnail|artwork)\b/iu,
    ],
    exact: ['generate_image'],
  },
  {
    category: 'video_generation',
    reason: 'direct video-generation request',
    patterns: [
      /^(?:生成|创建|制作)视频\s*(?:\r?\n|$)/u,
      /^(?:generate|create|make) (?:a )?video\s*(?:\r?\n|$)/iu,
      /^(?:根据|用)[\s\S]{0,36}(?:视频|短视频)脚本[\s\S]{0,36}(?:生成|创建|制作|产出)[\s\S]{0,24}(?:视频|短视频|短片|动画|成片)/u,
      /^先[\s\S]{0,48}(?:视频|短视频)脚本[\s\S]{0,40}(?:再|然后)[\s\S]{0,24}(?:生成|创建|制作|产出)[\s\S]{0,24}(?:视频|短视频|短片|动画|成片)/u,
      /^(?:生成|创建|制作|产出)[\s\S]{0,16}(?:视频|短视频)脚本[\s\S]{0,16}(?:和|并|以及|同时)[\s\S]{0,16}(?:视频|短视频|成片)/u,
      /^(?:(?:请|麻烦)(?:你)?|可以|能否|能不能|能|我想|我需要)?(?:帮我|给我|替我|为我)?(?:把|将|用|根据)[\s\S]{0,32}(?:图片|图像|照片|首帧)[\s\S]{0,32}(?:生成|制作|变成|转成|转换为)[\s\S]{0,20}(?:视频|短视频|短片|动画|成片)/iu,
      /^(?![\s\S]*(?:视频|短视频).{0,8}(?:脚本|文案|大纲|方案|提示词|字幕|标题|旁白|分镜))(?![\s\S]*(?:怎么|如何|为什么|是否|能否|可用吗|多少钱|费用|价格|前端容器|模型配置))(?:(?:请|麻烦)(?:你)?|可以|能否|能不能|能|我想|我需要)?(?:帮我|给我|替我|为我)?(?:生成|创建|制作|产出|做)(?:一段|一个|一条)?[\s\S]{0,72}(?:视频|短视频|短片|动画|成片)(?:吗)?(?:[，。！？,.!?\s]|$)/iu,
      /^(?:using|from)\b.{0,32}\b(?:video|clip)\s+script\b.{0,36}\b(?:generate|create|make|produce|render)\b.{0,24}\b(?:video|clip|animation|movie)\b/iu,
      /^first\b.{0,40}\b(?:video|clip)\s+script\b.{0,40}\bthen\b.{0,24}\b(?:generate|create|make|produce|render)\b.{0,24}\b(?:video|clip|animation|movie)\b/iu,
      /^(?:create|write|make|generate)\b.{0,32}\b(?:video|clip)\s+script\b.{0,36}\b(?:and\s+then|then|and)\b.{0,24}\b(?:generate|create|make|produce|render)\b.{0,24}\b(?:video|clip|animation|movie)\b/iu,
      /^(?:please\s+)?(?:(?:could|can|would|will)\s+you\s+)?(?:please\s+)?(?:turn|convert|transform|animate)\b.{0,40}\b(?:image|picture|photo|frame)\b.{0,24}\b(?:into|as|to)?\s*(?:a\s+)?(?:video|clip|animation|movie|short\s+film|reel)\b/iu,
      /^(?:image|picture|photo|frame)[-\s]+to[-\s]+video\b/iu,
      /^(?![\s\S]*\b(?:video|clip|animation|movie|short\s+film|reel)\s+(?:script|copy|outline|plan|prompt|subtitles?|titles?|caption|text|narration|storyboard)\b)(?![\s\S]*\b(?:why|how|whether|available|cost|price|pricing|configure|configuration|frontend|container)\b)(?:please\s+)?(?:(?:could|can|would|will)\s+you\s+)?(?:please\s+)?(?:generate|create|make|produce|render)\b.{0,72}\b(?:video|clip|animation|movie|short\s+film|reel)\b/iu,
    ],
    exact: ['generate_video'],
  },
  {
    category: 'cad_design',
    reason: 'CAD, design, image, or visual production request',
    patterns: [
      /CAD|DXF|DWG|图纸|平面图|户型|施工图|装修|室内|水电|草稿图|布置方案|装修方案|设计|视觉|品牌|海报|图片|画图|生成图|抠图|改图/u,
      /\b(cad|dxf|dwg|floor\s*plan|drawing|design|brand|poster|image|render)\b/i,
    ],
    exact: ['desktop_list_apps'],
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
    groups: ['files', 'documents', 'audioTranscription'],
  },
  {
    category: 'documents',
    reason: 'document, office, PDF, spreadsheet, or presentation workflow',
    patterns: [
      /文档|文件夹|文件|资料|报告|表格|PPT|幻灯片|PDF|DOCX|Excel|整理|汇总|导出|保存|生成.*文/u,
      /(?:^|[\s\\/])[^\s，。！？!?\n]{1,160}\.(?:txt|md|docx?|xlsx?|pptx?|pdf|csv)\b/iu,
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
      /代码|修复|实现|构建|提交|推送|部署|仓库|git|commit|push|lint|build/u,
      /(?:单元|集成|回归|端到端|自动化)测试|测试(?:代码|程序|接口|API|构建)/u,
      /\b(code|fix|implement|lint|build|commit|push|deploy|repo|git)\b/i,
      /\b(?:unit|integration|regression|end-to-end|e2e|automated)\s+tests?\b|\btests?(?:ing)?\b.{0,24}\b(?:code|program|software|api|build|repository|repo)\b/i,
    ],
    prefixes: ['mcp_code-sandbox_', 'mcp_deployment-config-generator_', 'mcp_project-deployment-setup_'],
    groups: ['code'],
  },
  {
    category: 'external_control',
    reason: 'external software, browser DOM, or native UI control request',
    patterns: [
      /外部软件|桌面控制|控件树|结构化浏览器|原生控件|窗口控件|按钮|输入框|Playwright|UIA|pywinauto|Windows UI Automation|外部AI|外部 AI|桌面AI|桌面 AI|其它AI|其他AI|问.*AI|AI.*回答|发给.*AI|WorkBuddy|Codex|ChatGPT|Claude|Gemini|DeepSeek|Kimi|豆包|通义|文心|Perplexity|Cursor|Copilot|Ollama|LM Studio|Cherry Studio|AnythingLLM/u,
      /\b(external\s+software|desktop\s+control|control\s+tree|native\s+control|playwright|uia|pywinauto|windows\s+ui\s+automation|external\s+ai|desktop\s+ai|workbuddy|codex|chatgpt|claude|gemini|deepseek|kimi|doubao|tongyi|wenxin|perplexity|cursor|copilot|ollama|lm\s*studio|cherry\s*studio|anythingllm|ask\s+.*ai|send\s+.*ai)\b/i,
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
    category: 'customer_operations',
    reason: 'customer sales, service, lead, or account operations request',
    patterns: [
      /(?:\u5ba2\u6237|\u9500\u552e|\u7ebf\u7d22|\u552e\u540e|\u5ba2\u670d|\u5de5\u5355|\u5546\u673a).{0,32}(?:\u63a5\u7ba1|\u8ddf\u8fdb|\u63a8\u8fdb|\u5904\u7406|\u5206\u6790|\u8bc4\u5206|\u62a5\u4ef7|\u56de\u8bbf|\u5f02\u8bae|\u5206\u7c7b|\u7ef4\u62a4|\u8fd0\u8425)/u,
      /\b(?:customer|sales|lead|after[-\s]?sales|support\s+ticket|crm)\b.{0,48}\b(?:take\s*over|follow\s*up|advance|handle|triage|score|quote|operate|manage)\b/i,
      /\b(?:take\s*over|follow\s*up|advance|handle|triage|score|quote|operate|manage|analy[sz]e|prepare)\b.{0,48}\b(?:customer|sales|lead|after[-\s]?sales|support\s+ticket|crm)\b/i,
    ],
    prefixes: ['mcp_sales-customer-ops_'],
    groups: ['workTakeover', 'messaging', 'documents'],
  },
  {
    category: 'ecommerce_operations',
    reason: 'ecommerce store, listing, order, inventory, campaign, or content operations request',
    patterns: [
      /(?:\u7535\u5546|\u5e97\u94fa|\u5546\u54c1|\u5546\u5bb6\u540e\u53f0|\u8ba2\u5355|\u5e93\u5b58|\u8865\u8d27|\u6295\u653e|\u5e7f\u544a|\u6296\u5e97|\u6dd8\u5b9d|\u5929\u732b|\u4eac\u4e1c|\u62fc\u591a\u591a|\u5c0f\u7ea2\u4e66).{0,40}(?:\u63a5\u7ba1|\u8fd0\u8425|\u4f18\u5316|\u5206\u6790|\u4f53\u68c0|\u6838\u7b97|\u5bf9\u8d26|\u8865\u8d27|\u589e\u957f|\u5185\u5bb9|\u77ed\u89c6\u9891|\u4e0a\u67b6|\u53d1\u5e03)/u,
      /\b(?:e-?commerce|marketplace|seller|shopify|store|inventory|campaign|listing|sku)\b.{0,48}\b(?:take\s*over|operate|optim|analy|audit|reconcile|restock|growth|content|publish|manage)\b/i,
      /\b(?:take\s*over|operate|optim|analy|audit|reconcile|restock|growth|create|publish|manage)\w*\b.{0,48}\b(?:e-?commerce|marketplace|seller|shopify|store|inventory|campaign|listing|sku)\b/i,
    ],
    prefixes: ['mcp_ecommerce-ops_', 'mcp_content-ops_'],
    groups: ['files', 'documents', 'web', 'authenticatedWeb', 'publicPost', 'design', 'workTakeover'],
  },
  {
    category: 'work_takeover',
    reason: 'work takeover coordination or capability reuse pressure test',
    patterns: [
      // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
      /工作接管|接管.*微信|接管.*客户|闭环执行|先跑一遍|跑出结果|能力复用|压测|重复能力|会不会重复|稳不稳定|稳定性|任务中心/u,
      /(?:创建|新建|建立).{0,28}(?:持久任务|长期任务|工作接管任务|可跨重启继续的任务)/u,
      /(?:\u7ee7\u7eed|\u63a5\u7740|\u5f80\u4e0b).*(?:\u4efb\u52a1|\u5ba2\u6237|\u4ea4\u4ed8|\u63a5\u7ba1|\u5de5\u4f5c|\u9879\u76ee)/u,
      /\b(work\s*takeover|closed\s*loop|capability\s*reuse|pressure\s*test|task\s*center|take\s*over)\b/i,
    ],
    exact: [
      'work_takeover_task_create',
      'work_takeover_task_list',
      'work_takeover_task_get',
      'work_takeover_task_continue',
      'work_takeover_task_advance',
      'work_takeover_task_verify_result',
    ],
    groups: ['workTakeover', 'skills'],
  },
  {
    category: 'sleep_dream',
    reason: 'sleep, dream, or internal memory consolidation request',
    patterns: [
      /(?:做梦|睡觉|睡眠|休息|入睡|梦境|梦一下|消化一下|整理记忆|整理一下记忆|记忆整理|记忆巩固|内在整理|人格消化|人格整理|降低混乱|减少混乱|醒来|睡醒)/u,
      /\b(?:sleep|dream|rest|nap|memory\s*consolidation|consolidate\s+(?:memory|memories)|process\s+(?:memory|memories)|dream\s*cycle|sleep\s*cycle)\b/i,
    ],
    groups: ['sleepDream'],
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
