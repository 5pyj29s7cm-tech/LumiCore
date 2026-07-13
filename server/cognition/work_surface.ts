import { ToolPolicy } from '../personality/types';

export interface WorkSurfaceRoute {
  artifactFirst: boolean;
  directDesktop: boolean;
  forbidComputerUse: boolean;
  promptOverlay: string;
  toolPolicy?: ToolPolicy;
}

const ARTIFACT_TASK_PATTERNS: RegExp[] = [
  /\b(cad|dxf|dwg|floor\s*plan|draft(?:ing)?|drawing|blueprint|construction\s*drawing|interior\s*design|renovation|design\s*scheme|proposal|report|document|deck|ppt|pdf)\b/i,
  /(?:CAD|cad|DXF|DWG|\u56fe\u7eb8|\u8349\u7a3f\u56fe|\u6237\u578b|\u5e73\u9762\u56fe|\u65bd\u5de5\u56fe|\u8bbe\u8ba1\u56fe|\u88c5\u4fee|\u5ba4\u5185|\u65b9\u6848|\u62a5\u544a|\u6587\u6863|\u6750\u6599|\u9884\u7b97|\u6587\u4ef6\u5939|\u56fe\u7247|\u7167\u7247)/u,
];

const ARTIFACT_ACTION_PATTERNS: RegExp[] = [
  /\b(create|make|generate|draft|draw|design|analy[sz]e|extract|convert|export|save|prepare|write|produce|build)\b/i,
  /(?:\u505a|\u751f\u6210|\u521b\u5efa|\u65b0\u5efa|\u753b|\u7ed8\u5236|\u51fa|\u5206\u6790|\u63d0\u53d6|\u8f6c|\u5bfc\u51fa|\u4fdd\u5b58|\u5199|\u5236\u4f5c|\u6574\u7406|\u5904\u7406)/u,
];

const DIRECT_DESKTOP_PATTERNS: RegExp[] = [
  /\bdesktop_ai_(?:ask|roundtable|collect_answer)\b/i,
  /\bcad_(?:generate_autocad_draw_script|run_autocad_draw_script)\b/i,
  /\bmcp_cad-drafting_autocad_playback_file\b/i,
  /\b(?:ask|send|collect|compare|summari[sz]e|use)\b.*\b(?:desktop\s+AI|work\s*buddy|codex|chatgpt|claude|gemini|deep\s*seek|kimi|doubao|qwen|lm\s*studio)\b/i,
  /\b(use|control|operate|take over|drive)\b.*\b(mouse|keyboard|cursor|desktop|screen|computer|autocad|cad\s*software|sketchup|librecad|zwcad|gstarcad)\b/i,
  /\b(open|launch|start)\b.*\b(autocad|cad\s*software|sketchup|librecad|zwcad|gstarcad)\b/i,
  /\b(on|in)\s+the\s+desktop\b.*\b(do|complete|draw|operate|control)\b/i,
  /(?:\u7528|\u901a\u8fc7).*(?:\u5149\u6807|\u9f20\u6807|\u952e\u76d8|\u9f20\u952e|\u7535\u8111\u63a7\u5236|\u684c\u9762\u63a7\u5236|\u89c6\u89c9\u63a7\u5236|computer_use)/u,
  /(?:\u64cd\u4f5c|\u63a5\u7ba1|\u63a7\u5236).*(?:\u7535\u8111|\u684c\u9762|\u9f20\u6807|\u952e\u76d8|\u5149\u6807|CAD\u8f6f\u4ef6|AutoCAD|\u6d69\u8fb0CAD|\u4e2d\u671bCAD)/u,
  /(?:\u6253\u5f00|\u542f\u52a8|\u8fdb\u5165).*(?:CAD\u8f6f\u4ef6|AutoCAD|\u6d69\u8fb0CAD|\u4e2d\u671bCAD|SketchUp|LibreCAD)/u,
  /(?:\u5728\u684c\u9762|\u684c\u9762\u4e0a).*(?:\u5b8c\u6210|\u753b|\u7ed8\u5236|\u5904\u7406|\u64cd\u4f5c)/u,
  /(?:\u4e00\u6b65\u4e00\u6b65).*(?:\u753b|\u64cd\u4f5c|CAD)/u,
  /(?:\u8be2\u95ee|\u53d1\u7ed9|\u6536\u96c6|\u62ff\u56de|\u6c47\u603b|\u603b\u7ed3|\u534f\u540c).*(?:\u684c\u9762\s*AI|WorkBuddy|Codex|ChatGPT|Claude|Gemini|DeepSeek|Kimi|\u8c46\u5305|\u901a\u4e49|Qwen|LM\s*Studio)/iu,
];

const DESKTOP_LOCATION_ONLY_PATTERNS: RegExp[] = [
  /(?:\u684c\u9762\u4e0a|\u684c\u9762).*(?:\u6709|\u53eb|\u6587\u4ef6\u5939|\u6587\u4ef6|\u56fe\u7247|\u7167\u7247)/u,
];

export function isArtifactFirstTask(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  const hasDomain = ARTIFACT_TASK_PATTERNS.some(pattern => pattern.test(normalized));
  const hasAction = ARTIFACT_ACTION_PATTERNS.some(pattern => pattern.test(normalized));
  return hasDomain && hasAction;
}

export function wantsDirectDesktopControl(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  const direct = DIRECT_DESKTOP_PATTERNS.some(pattern => pattern.test(normalized));
  if (!direct) return false;
  const locationOnly = DESKTOP_LOCATION_ONLY_PATTERNS.some(pattern => pattern.test(normalized));
  if (locationOnly && !/(?:\u5149\u6807|\u9f20\u6807|\u952e\u76d8|\u9f20\u952e|CAD\u8f6f\u4ef6|AutoCAD|SketchUp|LibreCAD|computer_use|\u63a7\u5236|\u64cd\u4f5c|\u63a5\u7ba1)/i.test(normalized)) {
    return false;
  }
  return true;
}

export function resolveWorkSurfaceRoute(text: string): WorkSurfaceRoute {
  const artifactFirst = isArtifactFirstTask(text);
  const directDesktop = wantsDirectDesktopControl(text);
  const forbidComputerUse = artifactFirst && !directDesktop;

  const promptOverlay = artifactFirst
    ? [
        '## Work Surface Routing',
        '- This looks like a file/image/CAD/design/document task. Default to an artifact-first workflow: inspect inputs, extract/OCR/vision as needed, generate structured outputs and files, verify paths, then summarize results.',
        '- For floor plans, renovation sketches, CAD reference images, or folders containing plan images: locate the source file, call floorplan_extract_geometry first when available, then call cad_generate_dxf with the extracted rooms/walls/doors/windows/dimensions. Use ocr_image_file only as a fallback or for non-floor-plan images.',
        '- If scale, dimensions, wall thickness, or room boundaries are inferred, mark the DXF as a calibrated draft/base drawing and ask for one confirmed dimension before claiming precision.',
        '- Do not use mouse/keyboard desktop control for this task unless the user explicitly asked to use the cursor, mouse, keyboard, a CAD desktop app, or to operate the computer directly.',
        '- If the user explicitly asks for desktop/CAD-app operation, first prepare draft files and an action guide, then operate the visible app through UIA/browser controls, clipboard, raw mouse/keyboard, or vision computer_use according to the active desktop mode and confirmation/autonomy boundary.',
        '- Mention generated file paths and unfinished parts. Do not claim production CAD completion unless a verified CAD app workflow produced it.',
      ].join('\n')
    : '';

  return {
    artifactFirst,
    directDesktop,
    forbidComputerUse,
    promptOverlay,
    toolPolicy: forbidComputerUse
      ? {
          allowedTools: ['*'],
          requireConfirmation: [
            'write_file',
            'web_search',
            'url_fetch',
            'read_file',
            'read_files_batch',
            'search_files',
            'grep_files',
          ],
          forbiddenTools: ['computer_use', 'desktop_run_command', 'run_command'],
          maxIterations: 12,
        }
      : undefined,
  };
}
