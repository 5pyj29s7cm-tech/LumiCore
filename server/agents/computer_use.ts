/**
 * Computer Use Agent — autonomous desktop interaction loop
 *
 * Architecture:
 *   1. Screenshot (PNG → JPEG via Canvas in WebView2)
 *   2. Vision model analysis (GPT-4o / Gemini Flash)
 *   3. Parse structured action JSON
 *   4. Execute via desktopRelay (enigo mouse/keyboard from Rust)
 *   5. Brief pause for UI to settle
 *   6. Repeat until DONE or the active tool-policy iteration limit
 *
 * Safety:
 *   - Each action is a single mouse/keyboard operation (not arbitrary code)
 *   - Coordinates are validated to be within reasonable screen bounds
 *   - Cancellable between any iteration via isCancelled callback
 *   - Iteration limit is provided by the active chat/assistant/autonomy policy
 */

import { NormalizedMessage, makeLLMCall } from '../llm/providers';
import { parseScreenshotBase64 } from '../llm/adapter';
import type { VisionProvider } from '../llm/vision_preferences';
import { getUserPreferredWorldModel } from '../llm/world_preferences';
import { recordTokenUsage } from '../llm/token_tracker';

interface ComputerUseAction {
  action: 'click' | 'double_click' | 'right_click' | 'type' | 'key_press' | 'wait' | 'done' | 'error';
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  message?: string;
  reason?: string;
}

export interface ComputerUseOptions {
  userId?: string;
  desktopRelay: (toolName: string, args: Record<string, any>) => Promise<string>;
  llmGetters: Record<string, () => any>;
  maxIterations?: number;
  onProgress?: (step: string) => void;
  isCancelled?: () => boolean;
}

export type DesktopWindowFingerprint = {
  windowId: string;
  title: string;
  processName: string;
  pid: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DesktopScreenGeometry = {
  screenX: number;
  screenY: number;
  width: number;
  height: number;
  inputWidth: number;
  inputHeight: number;
};

const DEFAULT_COMPUTER_USE_ITERATIONS = 12;
const MAX_COMPUTER_USE_ITERATIONS = 50;

function clampIterations(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_COMPUTER_USE_ITERATIONS;
  return Math.max(1, Math.min(Math.floor(n), MAX_COMPUTER_USE_ITERATIONS));
}

// ── System prompt for vision model ──

const SYSTEM_PROMPT = `You are a computer control AI. You see a screenshot of the user's desktop and need to complete a task step by step.

Use screenshot-local pixel coordinates. The screenshot's top-left corner is (0, 0); its exact width and height are supplied with each image. The runtime translates those local pixels to the operating system's virtual-desktop coordinates.

For EACH step, output EXACTLY ONE action as a JSON object:

Available actions:
  {"action":"click","x":500,"y":300,"reason":"Clicking the Start button"}
  {"action":"double_click","x":200,"y":150,"reason":"Opening the folder"}
  {"action":"right_click","x":400,"y":300,"reason":"Context menu on the file"}
  {"action":"type","text":"Hello World","reason":"Typing the message"}
  {"action":"key_press","key":"enter","reason":"Submitting the form"}
  {"action":"key_press","key":"ctrl+v","reason":"Pasting clipboard content"}
  {"action":"wait","reason":"Waiting for the page to load"}
  {"action":"done","message":"Opened Chrome and navigated to GitHub. The page is loaded.","reason":"Task complete"}

CRITICAL RULES:
1. Output ONLY the JSON object — no markdown, no backticks, no explanation outside the JSON.
2. Use ABSOLUTE screen coordinates. Look at the screenshot carefully to estimate pixel positions of UI elements. Click the CENTER of buttons, icons, and input fields.
3. For typing text: FIRST click the input field (separate action), THEN type the text.
4. After clicking buttons/links that cause navigation or UI changes, add a {"action":"wait"} action next to let the UI settle.
5. If the screen doesn't show what you expected after an action, try a different approach.
6. If you encounter an error dialog, close it before continuing (click OK or press escape).
7. If the task is impossible or you're stuck after several attempts, use {"action":"done","message":"Could not complete: <reason>"} and explain what went wrong.
8. Be precise with coordinates. Look at where elements actually are in the screenshot, not where they "should" be.
9. Treat the screenshot as ground truth. Do not click a place unless the target is visible in the current screenshot.
10. Move the mouse BEFORE clicking. The runtime will visibly move the cursor to your x,y, so pick the real UI target, not an approximate scripted position.
11. Keep final messages short: say what is done, what is blocked, or what needs confirmation. Do not narrate every internal step.`;

// ── Action execution ──

async function executeAction(
  action: ComputerUseAction,
  desktopRelay: ComputerUseOptions['desktopRelay'],
  screen: DesktopScreenGeometry,
): Promise<void> {
  const scaleX = screen.width > 0 && screen.inputWidth > 0 ? screen.inputWidth / screen.width : 1;
  const scaleY = screen.height > 0 && screen.inputHeight > 0 ? screen.inputHeight / screen.height : 1;
  const screenAction = action.x === undefined || action.y === undefined
    ? action
    : {
      ...action,
      x: Math.round(action.x * scaleX + screen.screenX),
      y: Math.round(action.y * scaleY + screen.screenY),
    };
  switch (action.action) {
    case 'click':
      await moveVisibleCursor(screenAction, desktopRelay);
      await desktopRelay('desktop_mouse_click_at', { x: screenAction.x!, y: screenAction.y!, button: 'left' });
      desktopRelay('desktop_cursor_glow_click', { x: screenAction.x!, y: screenAction.y! }).catch(() => {});
      break;
    case 'double_click':
      await moveVisibleCursor(screenAction, desktopRelay);
      await desktopRelay('desktop_mouse_double_click_at', { x: screenAction.x!, y: screenAction.y! });
      desktopRelay('desktop_cursor_glow_click', { x: screenAction.x!, y: screenAction.y! }).catch(() => {});
      break;
    case 'right_click':
      await moveVisibleCursor(screenAction, desktopRelay);
      await desktopRelay('desktop_mouse_right_click_at', { x: screenAction.x!, y: screenAction.y! });
      desktopRelay('desktop_cursor_glow_click', { x: screenAction.x!, y: screenAction.y! }).catch(() => {});
      break;
    case 'type':
      await desktopRelay('desktop_keyboard_type', { text: action.text! });
      break;
    case 'key_press':
      await desktopRelay('desktop_keyboard_press', { key: action.key! });
      break;
    case 'wait':
      await sleep(2000);
      break;
  }
}

async function moveVisibleCursor(
  action: Pick<ComputerUseAction, 'x' | 'y'>,
  desktopRelay: ComputerUseOptions['desktopRelay'],
): Promise<void> {
  const x = action.x!;
  const y = action.y!;
  await desktopRelay('desktop_cursor_glow_update', { x, y }).catch(() => {});
  await desktopRelay('desktop_mouse_move', { x, y }).catch(() => {});
  await sleep(220);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function isCancelled(options: Pick<ComputerUseOptions, 'isCancelled'>): boolean {
  return options.isCancelled?.() === true;
}

function terminalComputerUseReceipt(
  status: 'blocked' | 'cancelled' | 'unverified',
  message: string,
  steps: number,
  actionHistory: string[],
): string {
  return JSON.stringify({
    ok: false,
    status,
    completionVerified: false,
    steps,
    message,
    lastActions: actionHistory.slice(-3),
  });
}

export function parseDesktopWindowFingerprint(raw: string): DesktopWindowFingerprint | null {
  try {
    const parsed = JSON.parse(raw);
    const fingerprint = {
      windowId: String(parsed.window_id || parsed.windowId || ''),
      title: String(parsed.title || '').trim(),
      processName: String(parsed.process_name || parsed.processName || '').trim().toLowerCase(),
      pid: Number(parsed.pid) || 0,
      x: Number(parsed.x) || 0,
      y: Number(parsed.y) || 0,
      width: Number(parsed.width) || 0,
      height: Number(parsed.height) || 0,
    };
    if (!fingerprint.windowId && !fingerprint.title && !fingerprint.processName && !fingerprint.pid) return null;
    return fingerprint;
  } catch {
    return null;
  }
}

export function sameDesktopWindow(
  observed: DesktopWindowFingerprint,
  current: DesktopWindowFingerprint,
): boolean {
  if (observed.windowId && current.windowId) return observed.windowId === current.windowId;
  if (observed.pid > 0 && current.pid > 0) {
    if (observed.pid !== current.pid) return false;
    const hasGeometry = observed.width > 0 && observed.height > 0 && current.width > 0 && current.height > 0;
    return !hasGeometry || (
      observed.x === current.x
      && observed.y === current.y
      && observed.width === current.width
      && observed.height === current.height
    );
  }
  return Boolean(observed.processName && observed.title)
    && observed.processName === current.processName
    && observed.title === current.title;
}

async function readDesktopWindowFingerprint(
  desktopRelay: ComputerUseOptions['desktopRelay'],
): Promise<DesktopWindowFingerprint | null> {
  try {
    return parseDesktopWindowFingerprint(await desktopRelay('desktop_active_window', {}));
  } catch {
    return null;
  }
}

function actionRequiresStableForeground(action: ComputerUseAction): boolean {
  return ['click', 'double_click', 'right_click', 'type', 'key_press'].includes(action.action);
}

export function parseDesktopScreenGeometry(raw: string): DesktopScreenGeometry {
  try {
    const parsed = JSON.parse(raw);
    return {
      screenX: Number(parsed.screen_x ?? parsed.screenX) || 0,
      screenY: Number(parsed.screen_y ?? parsed.screenY) || 0,
      width: Math.max(0, Number(parsed.width) || 0),
      height: Math.max(0, Number(parsed.height) || 0),
      inputWidth: Math.max(0, Number(parsed.input_width ?? parsed.inputWidth) || Number(parsed.width) || 0),
      inputHeight: Math.max(0, Number(parsed.input_height ?? parsed.inputHeight) || Number(parsed.height) || 0),
    };
  } catch {
    return { screenX: 0, screenY: 0, width: 0, height: 0, inputWidth: 0, inputHeight: 0 };
  }
}

// World-model action planning

async function callWorldModel(
  screenshotBase64: string,
  screenshotMime: string,
  screen: DesktopScreenGeometry,
  task: string,
  actionHistory: string[],
  llmGetters: Record<string, () => any>,
  userId?: string,
): Promise<string> {
  const g = llmGetters;
  const world = getUserPreferredWorldModel(userId || 'anonymous');

  let provider: VisionProvider;
  let model = world.model;
  provider = world.provider;
  const getterAvailable = provider === 'openai' ? !!g.getOpenAI?.()
    : provider === 'gemini' ? !!g.getGemini?.()
      : provider === 'ark' ? !!g.getArk?.()
        : provider === 'qwen' ? !!g.getQwen?.()
          : provider === 'ollama' ? !!g.getOllama?.()
            : provider === 'lmstudio' ? !!g.getLmStudio?.()
              : provider === 'relay' ? !!g.getRelay?.()
                : false;
  if (!getterAvailable) {
    throw new Error(`Desktop action provider "${provider}" is not configured. Configure it in Settings > World Model, or inherit a configured visual-perception model.`);
  }

  const historyContext = actionHistory.length > 0
    ? `Previous actions taken:\n${actionHistory.slice(-8).join('\n')}\n\n`
    : '';
  const geometryContext = screen.width > 0 && screen.height > 0
    ? `Screenshot size: ${screen.width}x${screen.height} pixels. Return screenshot-local x/y coordinates within that image. Virtual desktop origin: (${screen.screenX}, ${screen.screenY}); do not add this origin yourself.\n\n`
    : '';

  const userContent: NormalizedMessage['content'] = [
    { type: 'text', text: `${historyContext}${geometryContext}Task: ${task}\n\nWhat is the SINGLE next action? Output ONLY the JSON.` },
    { type: 'image_url', image_url: { url: `data:${screenshotMime};base64,${screenshotBase64}`, detail: 'auto' as const } },
  ];

  const messages: NormalizedMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  const result = await makeLLMCall(
    messages, [],
    { provider, model, maxTokens: 400, userId, role: 'world' },
    g.getDeepSeek?.() || (() => null),
    g.getGemini?.() || (() => null),
    g.getOpenAI,
    g.getAnthropic,
    g.getQwen,
    g.getOllama,
    g.getLmStudio,
    g.getArk,
    g.getXiaomi,
    g.getKimi,
    g.getGlm,
    g.getRelay,
  );
  if (userId) {
    recordTokenUsage(userId, provider, model, result.usage, `world_computer_use_${Date.now()}`, 'world');
  }

  return result.text || '';
}

// ── JSON extraction ──

function extractActionJSON(text: string): ComputerUseAction | null {
  // Remove markdown code fences
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim();
  }

  // Try direct parse
  try {
    return JSON.parse(cleaned);
  } catch {}

  // Fix common vision-model JSON errors:
  // "x": <num>, <num>  →  "x": <num>, "y": <num>  (model collapsed x,y into x value)
  cleaned = cleaned.replace(/"x"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,/g, '"x": $1, "y": $2,');

  // Try parsing again after fix
  try {
    return JSON.parse(cleaned);
  } catch {}

  // Extract first JSON object
  const match = cleaned.match(/\{[\s\S]*?\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }

  return null;
}

function validateAction(action: ComputerUseAction, screen?: DesktopScreenGeometry): ComputerUseAction {
  const validActions = ['click', 'double_click', 'right_click', 'type', 'key_press', 'wait', 'done'];
  if (!validActions.includes(action.action)) {
    return { action: 'error', message: `Unknown action type: ${action.action}`, reason: 'Invalid action' };
  }

  // Validate coordinates for mouse actions
  if (['click', 'double_click', 'right_click'].includes(action.action)) {
    if (typeof action.x !== 'number' || typeof action.y !== 'number') {
      return { action: 'error', message: 'Missing x,y coordinates for mouse action', reason: 'Missing coords' };
    }
    const outsideCapturedScreen = Boolean(screen?.width && screen?.height)
      && (action.x < 0 || action.x >= screen!.width || action.y < 0 || action.y >= screen!.height);
    // The model returns screenshot-local pixels. Keep a generous legacy bound
    // when older clients cannot report screenshot dimensions.
    if (outsideCapturedScreen || action.x < 0 || action.x > 8000 || action.y < 0 || action.y > 5000) {
      return { action: 'error', message: `Coordinates (${action.x}, ${action.y}) out of reasonable bounds`, reason: 'Out of bounds' };
    }
  }

  if (action.action === 'type' && typeof action.text !== 'string') {
    return { action: 'error', message: 'Missing text for type action', reason: 'Missing text' };
  }

  if (action.action === 'key_press' && typeof action.key !== 'string') {
    return { action: 'error', message: 'Missing key for key_press action', reason: 'Missing key' };
  }

  return action;
}

function progressForAction(action: ComputerUseAction, step: number, total: number): string {
  const prefix = `[${step}/${total}]`;
  if (action.action === 'done') {
    return `${prefix} \u89c6\u89c9\u6a21\u578b\u7ed9\u51fa\u5b8c\u6210\u5019\u9009\uff0c\u6b63\u5728\u7528\u65b0\u622a\u56fe\u590d\u6838`; // i18n-allow: reviewed Chinese computer-control progress copy.
  }
  if (action.action === 'wait') return `${prefix} 等待界面响应`;
  if (action.action === 'type') return `${prefix} 输入内容`;
  if (action.action === 'key_press') return `${prefix} 使用键盘`;
  if (['click', 'double_click', 'right_click'].includes(action.action)) return `${prefix} 移动光标并点击目标`;
  return `${prefix} 继续处理`;
}

function historyForAction(action: ComputerUseAction, step: number, total: number): string {
  return action.action === 'done'
    ? `[${step}/${total}] DONE_CANDIDATE: ${action.message || ''}`
    : `[${step}/${total}] ${action.action} ${action.x !== undefined ? `(${action.x},${action.y})` : action.text || action.key || ''} - ${action.reason || ''}`;
}

function doneMessageDescribesBlocker(message: string): boolean {
  return /(?:could not|couldn't|cannot|can't|unable|failed|failure|blocked|stuck|impossible|not complete|incomplete|\u65e0\u6cd5|\u4e0d\u80fd|\u5931\u8d25|\u672a\u5b8c\u6210|\u6ca1\u6709\u5b8c\u6210|\u53d7\u963b|\u5361\u4f4f)/iu
    .test(String(message || ''));
}

// ── Main loop ──

/**
 * Run the computer use loop: screenshot -> world model -> action -> repeat.
 *
 * @param task Natural-language description of what to do on the desktop.
 * @param options desktopRelay, llmGetters, and optional callbacks.
 * @returns A summary message describing what was accomplished.
 */
export async function computerUseLoop(
  task: string,
  options: ComputerUseOptions,
): Promise<string> {
  const maxIter = clampIterations(options.maxIterations);
  const actionHistory: string[] = [];
  let consecutiveErrors = 0;
  let wallpaperModeEnabled = false;
  let doneCandidate: { iteration: number; message: string } | null = null;

  // ── Enter desktop control: show cursor glow so user sees where Lumi is clicking ──
  try {
    await options.desktopRelay('desktop_set_wallpaper_mode', {
      enabled: true,
      source: 'computer_use',
      timeoutMs: 190_000,
    });
    wallpaperModeEnabled = true;
    options.onProgress?.('Wallpaper mode enabled for desktop control');
  } catch (e: any) {
    options.onProgress?.(`Wallpaper mode unavailable: ${e.message}`);
  }

  try {
    await options.desktopRelay('desktop_cursor_glow_show', {});
    options.onProgress?.('光标光效已开启');
  } catch (e: any) {
    options.onProgress?.(`光标光效失败: ${e.message}`);
  }

  try {
    for (let i = 0; i < maxIter; i++) {
    if (isCancelled(options)) {
      return terminalComputerUseReceipt('cancelled', 'The user cancelled desktop control.', i, actionHistory);
    }

    // ── 1. Capture screenshot ──
    let screenshotBase64: string;
    let screenshotMime = 'image/jpeg';
    let screenGeometry: DesktopScreenGeometry = { screenX: 0, screenY: 0, width: 0, height: 0, inputWidth: 0, inputHeight: 0 };
    const windowBeforeCapture = await readDesktopWindowFingerprint(options.desktopRelay);
    let observedWindow: DesktopWindowFingerprint | null = null;
    try {
      const relayResult = await options.desktopRelay('desktop_capture_screen', { quality: 50 });
      const parsed = parseScreenshotBase64(relayResult);
      screenshotBase64 = parsed.base64;
      screenshotMime = parsed.mime;
      screenGeometry = parseDesktopScreenGeometry(relayResult);
      observedWindow = await readDesktopWindowFingerprint(options.desktopRelay);
      if (windowBeforeCapture && observedWindow && !sameDesktopWindow(windowBeforeCapture, observedWindow)) {
        options.onProgress?.(`[${i + 1}/${maxIter}] Foreground changed during screenshot capture; refreshing before planning an action.`);
        await sleep(200);
        continue;
      }
      observedWindow ||= windowBeforeCapture;
    } catch (err: any) {
      options.onProgress?.(`[${i + 1}/${maxIter}] Screenshot failed: ${err.message}`);
      consecutiveErrors++;
      if (consecutiveErrors >= 3) return terminalComputerUseReceipt('blocked', 'Desktop capture failed three times.', i + 1, actionHistory);
      await sleep(1000);
      continue;
    }

    // 2. World-model action planning
    if (isCancelled(options)) {
      return terminalComputerUseReceipt('cancelled', 'The user cancelled after desktop capture.', i + 1, actionHistory);
    }

    let responseText: string;
    try {
      responseText = await callWorldModel(screenshotBase64, screenshotMime, screenGeometry, task, actionHistory, options.llmGetters, options.userId);
    } catch (err: any) {
      options.onProgress?.(`[${i + 1}/${maxIter}] World model call failed: ${err.message}`);
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        return terminalComputerUseReceipt('blocked', `The desktop-action model failed three times: ${err.message}`, i + 1, actionHistory);
      }
      await sleep(2000);
      continue;
    }

    // ── 3. Parse action ──
    if (isCancelled(options)) {
      return terminalComputerUseReceipt('cancelled', 'The user cancelled after desktop-action analysis.', i + 1, actionHistory);
    }

    let action = extractActionJSON(responseText);
    if (!action) {
      options.onProgress?.(`[${i + 1}/${maxIter}] Could not parse action from: ${responseText.slice(0, 80)}`);
      consecutiveErrors++;
      if (consecutiveErrors >= 5) return terminalComputerUseReceipt('blocked', 'The desktop-action model returned five invalid action plans.', i + 1, actionHistory);
      continue;
    }

    action = validateAction(action, screenGeometry);
    consecutiveErrors = 0; // Reset on successful parse

    // ── 4. Report progress ──
    options.onProgress?.(progressForAction(action, i + 1, maxIter));
    actionHistory.push(historyForAction(action, i + 1, maxIter));

    // ── 5. Execute ──
    if (action.action === 'done') {
      if (doneCandidate && doneCandidate.iteration < i) {
        options.onProgress?.(
          `[${i + 1}/${maxIter}] \u65b0\u622a\u56fe\u590d\u6838\u5b8c\u6210\uff0c\u6b63\u5728\u751f\u6210\u53ef\u9a8c\u8bc1\u7ed3\u679c`, // i18n-allow: reviewed Chinese computer-control progress copy.
        );
        const message = action.message || doneCandidate.message || 'The requested desktop state is visible.';
        const blocked = doneMessageDescribesBlocker(message);
        return JSON.stringify({
          ok: !blocked,
          status: blocked ? 'blocked' : 'verified',
          completionVerified: !blocked,
          observations: 2,
          message,
        });
      }
      doneCandidate = {
        iteration: i,
        message: action.message || '',
      };
      await sleep(600);
      continue;
    }

    // A fresh screenshot contradicted the earlier completion candidate. Keep
    // operating and require a new two-observation candidate before accepting it.
    doneCandidate = null;

    if (action.action === 'error') {
      // Vision model returned invalid action — treat as non-fatal, let it retry
      await sleep(500);
      continue;
    }

    try {
      if (isCancelled(options)) {
        return terminalComputerUseReceipt('cancelled', 'The user cancelled before the next desktop action.', i + 1, actionHistory);
      }
      if (actionRequiresStableForeground(action)) {
        const currentWindow = await readDesktopWindowFingerprint(options.desktopRelay);
        if (!observedWindow || !currentWindow || !sameDesktopWindow(observedWindow, currentWindow)) {
          options.onProgress?.(`[${i + 1}/${maxIter}] Foreground changed while Lumi was planning; skipped the stale action and refreshed the screen.`);
          actionHistory.push(`[${i + 1}/${maxIter}] SKIPPED_STALE_FOREGROUND`);
          await sleep(200);
          continue;
        }
      }
      await executeAction(action, options.desktopRelay, screenGeometry);
      // Brief pause to let UI respond before next screenshot
      await sleep(400);
    } catch (err: any) {
      options.onProgress?.(`[${i + 1}/${maxIter}] Action failed: ${err.message}`);
      // Continue — vision model will see the unchanged screen and adapt
      await sleep(500);
    }
  }

  return terminalComputerUseReceipt('unverified', 'The iteration limit was reached without stable completion evidence.', maxIter, actionHistory);
  } finally {
    await options.desktopRelay('desktop_cursor_glow_hide', {}).catch(() => undefined);
    if (wallpaperModeEnabled) {
      await options.desktopRelay('desktop_set_wallpaper_mode', {
        enabled: false,
        source: 'computer_use',
      }).catch(() => undefined);
    }
    options.onProgress?.('光标光效已关闭');
  }
}
