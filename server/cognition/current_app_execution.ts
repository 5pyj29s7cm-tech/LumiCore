import type { ToolExecutionRecord } from '../tools/types';
import {
  extractRequestedCurrentAppText,
  extractCurrentAppTarget,
  requiresCurrentAppUiMutation,
} from './action_contract';
import {
  getRecoveredApplicationContinuationTarget,
  isRecoveredCurrentAppEditingContinuation,
} from './action_continuation';
import { WPS_CREATE_DOCUMENT_TOOL } from '../external_control/wps_automation';

export const CURRENT_APP_MAX_ITERATIONS = 10;
export const WPS_CURRENT_APP_MAX_ITERATIONS = 4;

export const CURRENT_APP_FORBIDDEN_TOOLS = [
  'computer_use',
  'mouse_move',
  'mouse_click',
  'mouse_drag',
  'desktop_mouse_click_at',
  'keyboard_type',
  'desktop_keyboard_type',
] as const;

const CREATE_INTENT_RE = /(?:\u65b0\u5efa|\u521b\u5efa)|\b(?:new|create)\b/iu;
const WRITE_INTENT_RE =
  /(?:\u5199\u5165|\u8f93\u5165|\u7c98\u8d34|\u5199|\u7f16\u8f91)|\b(?:write|type|paste|insert|edit)\b/iu;
const CREATE_CONTROL_RE =
  /(?:\u65b0\u5efa|\u7a7a\u767d\u6587\u6863|\u7a7a\u767d|\bnew\b|\bblank\s+(?:document|file|page|presentation|workbook)\b)/iu;
const EDITOR_NODE_HINT_RE =
  /(?:\u6b63\u6587|\u7f16\u8f91\u533a|\u6587\u6863\u533a|\u5185\u5bb9\u533a|\bbody\b|\beditor\b|\bdocument\b|\bcanvas\b|\bcontent\b)/iu;
const EDITOR_CLASS_HINT_RE =
  /(?:richedit|document(?:view|editor|host)?|editor|writer|text(?:area|editor)|canvas)/iu;

function primaryTurnText(text: string): string {
  return String(text || '').split(/\n## Recent action continuation context\b/i, 1)[0].trim();
}

function isWpsTarget(value: string): boolean {
  return /(?:^|\b)wps(?:\s+office|\s+writer)?(?:\b|$)|\u91d1\u5c71\u6587\u5b57|\u91d1\u5c71\s*wps/iu
    .test(String(value || '').trim());
}

export function isRecoveredWpsCreateTask(text: string): boolean {
  const primary = primaryTurnText(text);
  const target = isRecoveredCurrentAppEditingContinuation(text)
    ? getRecoveredApplicationContinuationTarget(text)
    : requiresCurrentAppUiMutation(text)
      ? extractCurrentAppTarget(text)
      : '';
  return isWpsTarget(target)
    && CREATE_INTENT_RE.test(primary);
}

export function isRecoveredWpsCreateAndTypeTask(text: string): boolean {
  return isRecoveredWpsCreateTask(text) && WRITE_INTENT_RE.test(primaryTurnText(text));
}

function parseNestedJson(value: unknown): unknown {
  let parsed = value;
  for (let depth = 0; depth < 3 && typeof parsed === 'string'; depth += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      break;
    }
  }
  return parsed;
}

function recordFailed(record: ToolExecutionRecord): boolean {
  if (record.error || !String(record.result || '').trim()) return true;
  const payload = parseNestedJson(record.result) as any;
  const status = String(payload?.status || payload?.verification?.status || '').trim().toLowerCase();
  return payload?.ok === false
    || payload?.success === false
    || /^(?:failed|error|blocked|denied|forbidden|timeout|timed_out|cancelled|canceled|not_found|pending)$/.test(status)
    || /(?:^|\b)(?:failed|error|blocked|not found|timed out|permission denied)(?:\b|:)/i.test(String(record.result || ''));
}

function recordEvidence(record: ToolExecutionRecord): string {
  return `${JSON.stringify(record.arguments || {})}\n${String(record.result || '')}`;
}

function nodeLooksLikeEditor(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const value = node as Record<string, unknown>;
  const controlType = String(value.controlType || value.role || value.type || '').trim();
  const name = String(value.name || '').trim();
  const automationId = String(value.automationId || '').trim();
  const className = String(value.className || '').trim();
  const localizedControlType = String(value.localizedControlType || '').trim();

  if (/^document$/i.test(controlType)) return true;
  if (
    /^(?:edit|text|textarea)$/i.test(controlType)
    && EDITOR_NODE_HINT_RE.test(`${name} ${automationId} ${className}`)
  ) return true;
  if (EDITOR_CLASS_HINT_RE.test(className)) return true;
  if (
    /(?:document|editor|\u6587\u6863|\u7f16\u8f91)/iu.test(localizedControlType)
    && EDITOR_NODE_HINT_RE.test(`${name} ${automationId} ${className}`)
  ) return true;
  return Object.values(value).some(child => (
    Array.isArray(child)
      ? child.some(nodeLooksLikeEditor)
      : child && typeof child === 'object' && nodeLooksLikeEditor(child)
  ));
}

function snapshotShowsEditor(record: ToolExecutionRecord): boolean {
  if (record.name !== 'desktop_ui_snapshot' || recordFailed(record)) return false;
  const parsed = parseNestedJson(record.result);
  if (nodeLooksLikeEditor(parsed)) return true;
  const text = String(record.result || '');
  return /"(?:controlType|role|type)"\s*:\s*"Document"/i.test(text)
    || /"(?:className|automationId)"\s*:\s*"[^"]*(?:RichEdit|DocumentView|DocumentEditor|TextEditor)[^"]*"/i.test(text);
}

function isCreateAction(record: ToolExecutionRecord): boolean {
  if (recordFailed(record)) return false;
  if (record.name === WPS_CREATE_DOCUMENT_TOOL) {
    const payload = parseNestedJson(record.result) as any;
    return payload?.status === 'verified'
      && payload?.documentCreated === true
      && payload?.exactTextMatch === true;
  }
  if (/^(?:keyboard_press|desktop_keyboard_press)$/i.test(record.name)) {
    return /^ctrl\+n$/i.test(String(record.arguments?.key || '').trim());
  }
  return /^(?:desktop_ui_invoke|desktop_ui_click)$/i.test(record.name)
    && CREATE_CONTROL_RE.test(recordEvidence(record));
}

function hasVerifiedWpsAutomation(records: ToolExecutionRecord[]): boolean {
  return records.some(record => {
    if (record.name !== WPS_CREATE_DOCUMENT_TOOL || recordFailed(record)) return false;
    const payload = parseNestedJson(record.result) as any;
    return payload?.ok === true
      && payload?.status === 'verified'
      && payload?.automation === 'KWPS.Application'
      && payload?.visible === true
      && payload?.documentCreated === true
      && payload?.exactTextMatch === true
      && payload?.saved === false
      && /^(?:attachedExisting|newVisibleInstance)$/.test(String(payload?.attachmentMode || ''))
      && (
        payload?.attachmentMode === 'attachedExisting'
          ? payload?.attachedExisting === true && payload?.newVisibleInstance === false
          : payload?.attachedExisting === false && payload?.newVisibleInstance === true
      )
      && Number(payload?.processId) > 0
      && Boolean(String(payload?.documentName || '').trim())
      && Boolean(String(payload?.windowTitle || '').trim());
  });
}

function latestIndex(records: ToolExecutionRecord[], predicate: (record: ToolExecutionRecord) => boolean): number {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (predicate(records[index])) return index;
  }
  return -1;
}

export function isCurrentAppExecutionTask(text: string): boolean {
  return isRecoveredCurrentAppEditingContinuation(text) || requiresCurrentAppUiMutation(text);
}

export function getConfirmedCurrentAppEditorSnapshotIndex(
  records: ToolExecutionRecord[],
  taskText: string,
): number {
  if (!isCurrentAppExecutionTask(taskText)) return -1;
  const wantsCreate = CREATE_INTENT_RE.test(primaryTurnText(taskText));
  const createIndex = latestIndex(records, isCreateAction);
  if (wantsCreate && createIndex < 0) return -1;
  for (let index = records.length - 1; index > createIndex; index -= 1) {
    if (snapshotShowsEditor(records[index])) return index;
  }
  return -1;
}

export function hasConfirmedCurrentAppEditor(
  records: ToolExecutionRecord[],
  taskText: string,
): boolean {
  return getConfirmedCurrentAppEditorSnapshotIndex(records, taskText) >= 0;
}

function selectorSignature(toolName: string, args: Record<string, unknown>): string {
  const selected = {
    name: args.name,
    nameContains: args.nameContains,
    automationId: args.automationId,
    controlType: args.controlType,
    className: args.className,
    index: args.index,
    key: args.key,
  };
  return `${toolName}:${JSON.stringify(selected)}`.toLowerCase();
}

function successfulFocusedEditorAfter(
  records: ToolExecutionRecord[],
  snapshotIndex: number,
): boolean {
  return records.slice(snapshotIndex + 1).some(record => (
    record.name === 'desktop_ui_focus'
    && !recordFailed(record)
    && (
      /^(?:document|edit|text|textarea)$/i.test(String(record.arguments?.controlType || '').trim())
      || EDITOR_NODE_HINT_RE.test(recordEvidence(record))
      || EDITOR_CLASS_HINT_RE.test(recordEvidence(record))
    )
  ));
}

export interface CurrentAppToolCallGuardResult {
  allowed: boolean;
  reason: string;
  normalizedArguments?: Record<string, unknown>;
}

export function guardCurrentAppToolCall(input: {
  taskText: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  toolRecords?: ToolExecutionRecord[];
}): CurrentAppToolCallGuardResult {
  if (!isCurrentAppExecutionTask(input.taskText)) return { allowed: true, reason: '' };

  const toolName = String(input.toolName || '');
  const args = input.arguments || {};
  const records = input.toolRecords || [];
  const verifiedWpsAutomation = hasVerifiedWpsAutomation(records);

  if (toolName === WPS_CREATE_DOCUMENT_TOOL) {
    if (!isRecoveredWpsCreateTask(input.taskText)) {
      return {
        allowed: false,
        reason: `${WPS_CREATE_DOCUMENT_TOOL} requires an explicit WPS request or a recovered WPS continuation that creates a document.`,
      };
    }
    const requestedText = extractRequestedCurrentAppText(primaryTurnText(input.taskText));
    if (WRITE_INTENT_RE.test(primaryTurnText(input.taskText)) && !requestedText) {
      return {
        allowed: false,
        reason: `${WPS_CREATE_DOCUMENT_TOOL} requires an exact text payload recoverable from the user's write/type instruction.`,
      };
    }
    if (verifiedWpsAutomation) {
      return {
        allowed: false,
        reason: 'The real WPS document was already created and its body text was verified. Stop instead of creating a duplicate document.',
      };
    }
    return {
      allowed: true,
      reason: '',
      // The dedicated WPS tool must receive the trusted payload from the user
      // turn, not a model reconstruction that may omit punctuation or alter
      // wording. It has no other supported arguments.
      normalizedArguments: { text: requestedText },
    };
  }

  if ((CURRENT_APP_FORBIDDEN_TOOLS as readonly string[]).includes(toolName)) {
    return {
      allowed: false,
      reason: `${toolName} is disabled for current-app editing. Use active-window and UI Automation controls so focus and state changes remain auditable.`,
    };
  }

  const editorSnapshotIndex = getConfirmedCurrentAppEditorSnapshotIndex(records, input.taskText);
  const editorReady = editorSnapshotIndex >= 0;
  const key = String(args.key || '').trim().toLowerCase();
  const isTyping = toolName === 'desktop_ui_type';
  const isEditorShortcut = /^(?:keyboard_press|desktop_keyboard_press)$/i.test(toolName)
    && /^(?:ctrl\+a|ctrl\+v|ctrl\+s)$/.test(key);
  const isNavigationAction = /^(?:desktop_ui_invoke|desktop_ui_click)$/i.test(toolName)
    || (/^(?:keyboard_press|desktop_keyboard_press)$/i.test(toolName) && key === 'ctrl+n');

  if (verifiedWpsAutomation && (isTyping || isEditorShortcut || isNavigationAction)) {
    return {
      allowed: false,
      reason: 'The WPS COM receipt already proves one visible document and exact body-text readback. Do not mutate or navigate again after verified completion.',
    };
  }

  if (isTyping || isEditorShortcut) {
    if (!editorReady) {
      return {
        allowed: false,
        reason: 'Editor-ready gate is not satisfied. Invoke one precise New/Blank control, then take a fresh desktop_ui_snapshot that exposes an editable Document/editor control before typing, pasting, selecting all, or saving.',
      };
    }
    const hasTargetSelector = Boolean(
      args.name
      || args.nameContains
      || args.automationId
      || args.controlType
      || args.className,
    );
    if (
      (toolName === 'desktop_ui_type' && !hasTargetSelector)
      || /^(?:ctrl\+a|ctrl\+v)$/i.test(key)
    ) {
      if (!successfulFocusedEditorAfter(records, editorSnapshotIndex)) {
        return {
          allowed: false,
          reason: 'The editor is visible but not explicitly focused. Focus the editable Document/Edit control from the latest UIA snapshot before untargeted typing or clipboard shortcuts.',
        };
      }
    }
  }

  if (isNavigationAction) {
    const lastNavigationIndex = latestIndex(records, record => (
      !recordFailed(record)
      && (
        /^(?:desktop_ui_invoke|desktop_ui_click)$/i.test(record.name)
        || (/^(?:keyboard_press|desktop_keyboard_press)$/i.test(record.name)
          && /^ctrl\+n$/i.test(String(record.arguments?.key || '').trim()))
      )
    ));
    const lastSnapshotIndex = latestIndex(records, record => (
      record.name === 'desktop_ui_snapshot' && !recordFailed(record)
    ));
    if (lastSnapshotIndex < 0) {
      return {
        allowed: false,
        reason: 'Take a fresh desktop_ui_snapshot before the first navigation action so the selected control and starting state are auditable.',
      };
    }
    if (lastNavigationIndex > lastSnapshotIndex) {
      return {
        allowed: false,
        reason: 'A navigation action already ran without a fresh UIA snapshot. Observe the new active-window/UI state before invoking or clicking another control.',
      };
    }

    const signature = selectorSignature(toolName, args);
    const priorMatchingAction = records.find(record => (
      !recordFailed(record)
      && selectorSignature(record.name, record.arguments || {}) === signature
    ));
    if (priorMatchingAction) {
      return {
        allowed: false,
        reason: 'The same UIA navigation selector already succeeded once. Do not repeat it; inspect the fresh UIA tree and advance to a distinct next control.',
      };
    }
  }

  return { allowed: true, reason: '' };
}

export function buildCurrentAppUiStateMachinePrompt(appTarget = ''): string {
  const wpsAutomation = isWpsTarget(appTarget)
    ? [
        `WPS deterministic path: for a create request, call ${WPS_CREATE_DOCUMENT_TOOL} exactly once with the requested text, or an empty text for a blank document, before trying UIA navigation.`,
        'Its verified receipt must say attachedExisting or newVisibleInstance, Visible=true, include a real wps.exe PID/document/window, and exact body-text readback. It does not save.',
        'A verified WPS automation receipt is terminal evidence. Do not create another document, navigate, type, paste, or save after it.',
        'Use the generic UIA path only if that tool is unavailable or returns an explicit failure.',
      ]
    : [];
  return [
    '## Current-App UIA State Machine',
    `Target application: ${appTarget || 'the application recovered from the successful desktop_open receipt'}.`,
    `Iteration budget: at most ${isWpsTarget(appTarget) ? WPS_CURRENT_APP_MAX_ITERATIONS : CURRENT_APP_MAX_ITERATIONS}. Stop with the exact blocker instead of looping.`,
    ...wpsAutomation,
    '1. Observe: call desktop_active_window, then desktop_ui_snapshot. Confirm the recovered target is foreground.',
    '2. Navigate: if a start/template/gallery surface is visible, invoke or UIA-click one precise New/Blank control. A title such as "New Document" alone is not editor evidence.',
    '3. Re-observe after every invoke, click, or Ctrl+N. Never repeat the same New/Blank selector. If state did not change, choose one distinct accessible control or stop.',
    '4. Editor-ready gate: a fresh desktop_ui_snapshot must expose an enabled editable Document/editor control. A home page, template gallery, New button, app title, OCR guess, or successful shortcut is insufficient.',
    '5. Input only after the editor-ready gate. Focus the editable control, then use desktop_ui_type with that UIA selector. Clipboard/keyboard shortcuts are fallback only after the same editor focus is verified.',
    '6. Verify: take a fresh UIA snapshot and OCR/screen observation after input. The requested text must be visibly present before reporting success.',
    'computer_use, raw coordinate mouse actions, and untargeted keyboard_type are unavailable for this lane because they can steal focus or hide state transitions.',
  ].join('\n');
}
