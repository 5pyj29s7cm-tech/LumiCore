

export const FILE_EXTENSIONS = '(?:pptx?|docx?|xlsx?|pdf|txt|md|csv|json|png|jpe?g|gif|svg|dwg|dxf|zip)';

export const FILE_NAME_RE = new RegExp("(?:[\"'“‘]|(?=[A-Za-z0-9_@.+~-][^\\\\/\\s，,;；:：()（）\\[\\]{}=\"'“”‘’。！？!?]*\\." + FILE_EXTENSIONS + "(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_.-])))([^\\\\/\\r\\n，,;；:：()（）\\[\\]{}=\"'“”‘’。！？!?]{1,180}?\\." + FILE_EXTENSIONS + ")(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_.-])", 'iu');

export const ABSOLUTE_FILE_RE = new RegExp(`(?:[A-Za-z]:[\\\\/]|\\\\\\\\)[^\\r\\n，,；;。！？!?"'“”‘’]{1,420}\\.${FILE_EXTENSIONS}`, 'iu');

export const POSIX_ABSOLUTE_FILE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_.:/\\\\-])/(?:[^/\\\\\\r\\n，,；;。！？!?"'“”‘’]{1,180}/)*[^/\\\\\\r\\n，,；;。！？!?"'“”‘’]{1,180}\\.${FILE_EXTENSIONS}(?![\\p{L}\\p{N}_/\\\\-])`,
  'iu',
);

export const POSIX_ABSOLUTE_PATH_RE = /(?<![\p{L}\p{N}_.:/\\-])\/(?:[^/\\\s\r\n，,；;。！？!?"'“”‘’]+\/)*[^/\\\s\r\n，,；;。！？!?"'“”‘’]+(?![\p{L}\p{N}_.\/\\-])/gu;

export const POSIX_QUOTED_PATH_RE = /"(\/[^"\\\r\n]{1,498})"|'(\/[^'\\\r\n]{1,498})'|“(\/[^”\\\r\n]{1,498})”|‘(\/[^’\\\r\n]{1,498})’/gu;

// i18n-allow: multilingual file-task intent recognition; not user-visible copy.
export const FILE_TASK_RE = /(?:分析|读取|读一下|查看|检查|总结|提取|处理|资料|文件|文档|PPT|演示文稿|表格|图片|图纸|当前打开|正在打开)|\b(?:analy[sz]e|read|inspect|review|summari[sz]e|extract|file|document|presentation|sheet|image|drawing|currently?\s+open)\b/iu;

// i18n-allow: multilingual file action recognition; not user-visible copy.
export const FILE_ACTION_RE = /(?:分析|读取|读一下|查看|检查|总结|提取|处理|打开|资料)|\b(?:analy[sz]e|read|inspect|review|summari[sz]e|extract|process|open)\b/iu;

// i18n-allow: multilingual current-document reference recognition; not user-visible copy.
export const CURRENT_DOCUMENT_RE = /(?:当前|现在|正在|刚才|刚刚)(?:\s*(?:打开|前台|活动))?(?:\s*的)?(?:\s*(?:这份|这个))?(?:\s*(?:文件|文档|PPT|演示文稿|表格|资料))|(?:当前|活动|前台)窗口|\b(?:current|currently\s+open|active|foreground|opened)\b.{0,24}\b(?:file|document|presentation|sheet|window)\b/iu;

// i18n-allow: deictic current-document input recognition; not user-visible copy.
export const IMPLICIT_CURRENT_DOCUMENT_RE = /(?:(?:(?:当前|现在|正在|刚才|刚刚).{0,12}打开(?:着|的)?|打开(?:着|的)).{0,8}(?:这份|这个|该)?(?:文件|文档|PPT|演示文稿|表格|资料)|\b(?:currently?\s+open|opened|active|foreground)\b.{0,24}\b(?:file|document|presentation|sheet)\b)/iu;

// i18n-allow: WPS product/process recognition; not user-visible copy.
export const WPS_RE = /(?:^|\b)(?:WPS|wps\.exe|wpp\.exe|et\.exe)(?:\b|$)|金山(?:文字|表格|演示|WPS)/iu;

// i18n-allow: Multilingual authoring application and process recognition; not display copy.
export const AUTHORING_APPLICATION_RE = /(?:^|\b)(?:WPS|wps\.exe|wpp\.exe|et\.exe|Microsoft\s+Word|WINWORD\.EXE|Microsoft\s+Excel|EXCEL\.EXE|Microsoft\s+PowerPoint|POWERPNT\.EXE)(?:\b|$)|金山(?:文字|表格|演示|WPS)/iu;

export const ACTIVE_WINDOW_TOOLS = new Set(['desktop_active_window', 'get_active_window_info']);

export const RUNNING_PROCESS_TOOLS = new Set(['desktop_running_processes', 'get_running_processes']);

export const DISCOVERY_TOOLS = new Set(['search_files', 'desktop_list_files', 'list_directory']);

export const DOCUMENT_INTERFACE_RE = /^(?:extract_document_text|read_file|read_files_batch|read_pdf|read_docx|read_xlsx|pdf_to_text|ocr_image_file|(?:desktop_|filesystem_|mcp_[^_]+_)?read_(?:text_)?file|wps_.*(?:read|extract|inspect|analy)|document_.*(?:read|extract|inspect|analy))/i;

export const CURRENT_DOCUMENT_INTERFACE_RE = /^wps_.*(?:read|extract|inspect|analy)/i;

export const UNSTRUCTURED_FILE_ACCESS_TOOL_RE = /^(?:computer_use|(?:.*_)?(?:run_command|code_execution|python_exec|node_exec|shell_exec|terminal_exec|powershell|execute_script|run_script|script_exec))$/i;

export const RUNTIME_BASENAME_RE = /^(?:entry\.cjs|node(?:\.exe)?|electron(?:\.exe)?|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/i;

export const RUNTIME_SEGMENT_RE = /(?:^|[\\/])(?:node_modules|dist-server|\.next|\.vite|src-tauri[\\/]target|target[\\/](?:debug|release)|resources[\\/]app\.asar\.unpacked)(?:[\\/]|$)/i;

export const STANDARD_ROOT_ALIAS_RE = /^~[\\/](?:Desktop|Documents|Downloads)(?:[\\/]|$)/i;

export const TARGET_PATH_KEYS = [
  'path', 'filePath', 'filepath', 'documentPath', 'documentpath', 'targetPath', 'targetpath',
  'sourcePath', 'sourcepath', 'inputPath', 'inputpath', 'outputPath', 'outputpath', 'target', 'file',
];

export const TARGET_NAME_KEYS = ['documentName', 'documentname', 'fileName', 'filename', 'name', 'objectName', 'objectname'];

export const WINDOW_KEYS = ['windowTitle', 'windowtitle', 'title', 'caption', 'window'];

export const APPLICATION_KEYS = ['application', 'applicationName', 'applicationname', 'appName', 'appname', 'processName', 'processname', 'process_name'];

// i18n-allow: negated file-read input recognition, not user-visible copy.
export const EXCLUDED_FILE_CLAUSE_RE = /(?:不要|别|无需|不用|禁止|请勿|勿|不再)\s*(?:再|继续)?\s*(?:读取|读|打开|用|使用|处理|分析|查看|检查)|\b(?:do\s+not|don't|never)\s+(?:read|open|use|process|inspect|analy[sz]e)\b/iu;

// i18n-allow: output destinations are separate from input-file references.
export const OUTPUT_DESTINATION_RE = /(?:并|然后|再)?(?:另存(?:为|到)?|保存(?:为|到)|导出(?:为|到))|\b(?:and\s+)?(?:save\s+as|save\s+to|export\s+to)\b/iu;

// i18n-allow: Value edits retain an input while creating a distinct output.
export const VALUE_CORRECTION_RE = /(?:数量|单价|价格|金额|日期).{0,12}(?:改成|改为|调整为|换成)|\b(?:quantity|price|amount|date)\b.{0,20}\b(?:change|to|replace)\b/iu;
