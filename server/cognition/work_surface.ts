import { ToolPolicy } from '../personality/types';
import {
  getRecoveredApplicationContinuationTarget,
  isRecoveredCurrentAppEditingContinuation,
} from './action_continuation';
import {
  CURRENT_APP_FORBIDDEN_TOOLS,
  CURRENT_APP_MAX_ITERATIONS,
} from './current_app_execution';

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
  /\bcad_prepare_autocad_operations\b/i,
  /\bmcp_cad-drafting_autocad_playback_file\b/i,
  /\b(use|control|operate|take over|drive)\b.*\b(mouse|keyboard|cursor|desktop|screen|computer|autocad|cad\s*software|sketchup|librecad|zwcad|gstarcad)\b/i,
  /\b(open|launch|start)\b.*\b(autocad|cad\s*software|sketchup|librecad|zwcad|gstarcad)\b/i,
  /\b(?:draw|draft|execute|play\s*back|playback)\b.*\b(?:in|inside|through|with)\s+(?:autocad|cad)\b/i,
  /\b(on|in)\s+the\s+desktop\b.*\b(do|complete|draw|operate|control)\b/i,
  /(?:\u7528|\u901a\u8fc7).*(?:\u5149\u6807|\u9f20\u6807|\u952e\u76d8|\u9f20\u952e|\u7535\u8111\u63a7\u5236|\u684c\u9762\u63a7\u5236|\u89c6\u89c9\u63a7\u5236|computer_use)/u,
  /(?:\u64cd\u4f5c|\u63a5\u7ba1|\u63a7\u5236).*(?:\u7535\u8111|\u684c\u9762|\u9f20\u6807|\u952e\u76d8|\u5149\u6807|CAD\u8f6f\u4ef6|AutoCAD|\u6d69\u8fb0CAD|\u4e2d\u671bCAD)/u,
  /(?:\u6253\u5f00|\u542f\u52a8|\u8fdb\u5165).*(?:CAD\u8f6f\u4ef6|AutoCAD|\u6d69\u8fb0CAD|\u4e2d\u671bCAD|SketchUp|LibreCAD)/u,
  /(?:\u5728\u684c\u9762|\u684c\u9762\u4e0a).*(?:\u5b8c\u6210|\u753b|\u7ed8\u5236|\u5904\u7406|\u64cd\u4f5c)/u,
  /(?:\u4e00\u6b65\u4e00\u6b65|\u4e00\u7b14\u4e00\u7b14).*(?:\u753b|\u64cd\u4f5c|CAD)/u,
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
  const recoveredCurrentAppEdit = isRecoveredCurrentAppEditingContinuation(text);
  const recoveredAppTarget = recoveredCurrentAppEdit
    ? getRecoveredApplicationContinuationTarget(text)
    : '';
  const artifactFirst = recoveredCurrentAppEdit ? false : isArtifactFirstTask(text);
  const directDesktop = recoveredCurrentAppEdit || wantsDirectDesktopControl(text);
  const forbidComputerUse = recoveredCurrentAppEdit || (artifactFirst && !directDesktop);

  const promptOverlay = recoveredCurrentAppEdit
    ? [
        '## Current Application Continuation Routing',
        `- Continue inside the successfully opened application${recoveredAppTarget ? ` (${recoveredAppTarget})` : ''}.`,
        '- Use the auditable UI Automation state machine: active window -> UI tree -> one precise navigation action -> fresh UI tree -> confirmed editor -> focused UIA typing -> fresh verification.',
        '- Never type or paste until a fresh desktop_ui_snapshot exposes an editable Document/editor control. A start page, template gallery, New button, window title, or successful shortcut is not editor evidence.',
        '- Do not repeat the same New/Blank selector. Re-observe after every UI invoke/click/shortcut and stop with the blocker if the state does not change.',
        '- Treat text after write/type/paste as payload for the current app. Do not reinterpret payload words as coding, capability learning, artifact generation, or a different application task.',
        '- computer_use, raw coordinate mouse tools, and untargeted keyboard typing are disabled because they can steal focus and hide state transitions.',
      ].join('\n')
    : artifactFirst
    ? [
        '## Work Surface Routing',
        '- This looks like a file/image/CAD/design/document task. Default to an artifact-first workflow: inspect inputs, extract/OCR/vision as needed, generate structured outputs and files, verify paths, then summarize results.',
        '- For floor plans and CAD reference images: call floorplan_extract_geometry and continue only when geometryReady=true. Pass its compact geometry-receipt handoff directly to the requested CAD tool; never transcribe coordinates from OCR or partial model output. Use ocr_image_file only for descriptive inspection, not executable CAD geometry.',
        '- If scale, dimensions, wall thickness, or room boundaries are inferred, mark the DXF as a calibrated draft/base drawing and ask for one confirmed dimension before claiming precision.',
        '- Do not use mouse/keyboard desktop control for this task unless the user explicitly asked to use the cursor, mouse, keyboard, a CAD desktop app, or to operate the computer directly.',
        '- If the user explicitly asks for visible AutoCAD drawing, derive geometry, call cad_prepare_autocad_operations, then call mcp_cad-drafting_autocad_playback_file. Do not substitute DXF/DWG generation, LISP/SCRIPT, raw mouse/keyboard, or vision computer_use if MCP playback fails.',
        '- Mention generated file paths and unfinished parts. Visible AutoCAD completion requires MCP/COM playback evidence and its completion marker; file generation or an opened window is not completion.',
      ].join('\n')
    : '';

  return {
    artifactFirst,
    directDesktop,
    forbidComputerUse,
    promptOverlay,
    toolPolicy: recoveredCurrentAppEdit
      ? {
          allowedTools: ['*'],
          requireConfirmation: [],
          forbiddenTools: [...CURRENT_APP_FORBIDDEN_TOOLS],
          maxIterations: CURRENT_APP_MAX_ITERATIONS,
        }
      : forbidComputerUse
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
