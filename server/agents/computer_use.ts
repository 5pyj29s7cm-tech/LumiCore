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
import { getUserPreferredVision, type VisionProvider } from '../llm/vision_preferences';
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

const DEFAULT_COMPUTER_USE_ITERATIONS = 12;
const MAX_COMPUTER_USE_ITERATIONS = 50;

function clampIterations(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_COMPUTER_USE_ITERATIONS;
  return Math.max(1, Math.min(Math.floor(n), MAX_COMPUTER_USE_ITERATIONS));
}

// ── System prompt for vision model ──

const SYSTEM_PROMPT = `You are a computer control AI. You see a screenshot of the user's desktop and need to complete a task step by step.

The screen resolution is typically 1920×1080 pixels. The top-left corner is coordinate (0, 0). The bottom-right is approximately (1920, 1080).

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
): Promise<void> {
  switch (action.action) {
    case 'click':
      await moveVisibleCursor(action, desktopRelay);
      await desktopRelay('desktop_mouse_click_at', { x: action.x!, y: action.y!, button: 'left' });
      desktopRelay('desktop_cursor_glow_click', { x: action.x!, y: action.y! }).catch(() => {});
      break;
    case 'double_click':
      await moveVisibleCursor(action, desktopRelay);
      await desktopRelay('desktop_mouse_double_click_at', { x: action.x!, y: action.y! });
      desktopRelay('desktop_cursor_glow_click', { x: action.x!, y: action.y! }).catch(() => {});
      break;
    case 'right_click':
      await moveVisibleCursor(action, desktopRelay);
      await desktopRelay('desktop_mouse_right_click_at', { x: action.x!, y: action.y! });
      desktopRelay('desktop_cursor_glow_click', { x: action.x!, y: action.y! }).catch(() => {});
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

// ── Vision model call ──

async function callVisionModel(
  screenshotBase64: string,
  screenshotMime: string,
  task: string,
  actionHistory: string[],
  llmGetters: Record<string, () => any>,
  userId?: string,
): Promise<string> {
  const g = llmGetters;
  const vision = getUserPreferredVision(userId || 'anonymous');

  let provider: VisionProvider;
  let model = vision.model;
  provider = vision.provider;
  const getterAvailable = provider === 'openai' ? !!g.getOpenAI?.()
    : provider === 'gemini' ? !!g.getGemini?.()
      : provider === 'ark' ? !!g.getArk?.()
        : provider === 'qwen' ? !!g.getQwen?.()
          : provider === 'ollama' ? !!g.getOllama?.()
            : provider === 'lmstudio' ? !!g.getLmStudio?.()
              : provider === 'relay' ? !!g.getRelay?.()
                : false;
  if (!getterAvailable) {
    throw new Error(`Computer use vision provider "${provider}" is not configured. Add its API key in Settings → LLM Providers → Vision Model, or choose a configured vision model.`);
  }

  const historyContext = actionHistory.length > 0
    ? `Previous actions taken:\n${actionHistory.slice(-8).join('\n')}\n\n`
    : '';

  const userContent: NormalizedMessage['content'] = [
    { type: 'text', text: `${historyContext}Task: ${task}\n\nWhat is the SINGLE next action? Output ONLY the JSON.` },
    { type: 'image_url', image_url: { url: `data:${screenshotMime};base64,${screenshotBase64}`, detail: 'auto' as const } },
  ];

  const messages: NormalizedMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  const result = await makeLLMCall(
    messages, [],
    { provider, model, maxTokens: 400, userId },
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
    recordTokenUsage(userId, provider, model, result.usage, `vision_computer_use_${Date.now()}`, 'vision');
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

function validateAction(action: ComputerUseAction): ComputerUseAction {
  const validActions = ['click', 'double_click', 'right_click', 'type', 'key_press', 'wait', 'done'];
  if (!validActions.includes(action.action)) {
    return { action: 'error', message: `Unknown action type: ${action.action}`, reason: 'Invalid action' };
  }

  // Validate coordinates for mouse actions
  if (['click', 'double_click', 'right_click'].includes(action.action)) {
    if (typeof action.x !== 'number' || typeof action.y !== 'number') {
      return { action: 'error', message: 'Missing x,y coordinates for mouse action', reason: 'Missing coords' };
    }
    // Sanity check: screen coordinates should be within 0..7680 range (supports multi-monitor up to 8K)
    if (action.x < -1000 || action.x > 8000 || action.y < -1000 || action.y > 5000) {
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
  if (action.action === 'done') return `${prefix} 完成`;
  if (action.action === 'wait') return `${prefix} 等待界面响应`;
  if (action.action === 'type') return `${prefix} 输入内容`;
  if (action.action === 'key_press') return `${prefix} 使用键盘`;
  if (['click', 'double_click', 'right_click'].includes(action.action)) return `${prefix} 移动光标并点击目标`;
  return `${prefix} 继续处理`;
}

function historyForAction(action: ComputerUseAction, step: number, total: number): string {
  return action.action === 'done'
    ? `[${step}/${total}] DONE: ${action.message || ''}`
    : `[${step}/${total}] ${action.action} ${action.x !== undefined ? `(${action.x},${action.y})` : action.text || action.key || ''} - ${action.reason || ''}`;
}

// ── Main loop ──

/**
 * Run the computer use loop: screenshot → vision → action → repeat.
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
      return `Task cancelled by user after ${i} step(s). Last actions: ${actionHistory.slice(-3).join('; ') || 'none'}`;
    }

    // ── 1. Capture screenshot ──
    let screenshotBase64: string;
    let screenshotMime = 'image/jpeg';
    try {
      const relayResult = await options.desktopRelay('desktop_capture_screen', { quality: 50 });
      const parsed = parseScreenshotBase64(relayResult);
      screenshotBase64 = parsed.base64;
      screenshotMime = parsed.mime;
    } catch (err: any) {
      options.onProgress?.(`[${i + 1}/${maxIter}] Screenshot failed: ${err.message}`);
      consecutiveErrors++;
      if (consecutiveErrors >= 3) return 'Failed to capture screenshot 3 times in a row. Is the desktop app running?';
      await sleep(1000);
      continue;
    }

    // ── 2. Vision analysis ──
    if (isCancelled(options)) {
      return `Task cancelled after screenshot capture. Last actions: ${actionHistory.slice(-3).join('; ') || 'none'}`;
    }

    let responseText: string;
    try {
      responseText = await callVisionModel(screenshotBase64, screenshotMime, task, actionHistory, options.llmGetters, options.userId);
    } catch (err: any) {
      options.onProgress?.(`[${i + 1}/${maxIter}] Vision call failed: ${err.message}`);
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        return `Vision model failed 3 times: ${err.message}`;
      }
      await sleep(2000);
      continue;
    }

    // ── 3. Parse action ──
    if (isCancelled(options)) {
      return `Task cancelled after vision analysis. Last actions: ${actionHistory.slice(-3).join('; ') || 'none'}`;
    }

    let action = extractActionJSON(responseText);
    if (!action) {
      options.onProgress?.(`[${i + 1}/${maxIter}] Could not parse action from: ${responseText.slice(0, 80)}`);
      consecutiveErrors++;
      if (consecutiveErrors >= 5) return 'Too many parse failures. The vision model is not returning valid JSON actions.';
      continue;
    }

    action = validateAction(action);
    consecutiveErrors = 0; // Reset on successful parse

    // ── 4. Report progress ──
    options.onProgress?.(progressForAction(action, i + 1, maxIter));
    actionHistory.push(historyForAction(action, i + 1, maxIter));

    // ── 5. Execute ──
    if (action.action === 'done') {
      return action.message ? `完成：${action.message}` : '完成：桌面任务已处理。';
    }

    if (action.action === 'error') {
      // Vision model returned invalid action — treat as non-fatal, let it retry
      await sleep(500);
      continue;
    }

    try {
      if (isCancelled(options)) {
        return `Task cancelled before desktop action. Last actions: ${actionHistory.slice(-3).join('; ') || 'none'}`;
      }
      await executeAction(action, options.desktopRelay);
      // Brief pause to let UI respond before next screenshot
      await sleep(400);
    } catch (err: any) {
      options.onProgress?.(`[${i + 1}/${maxIter}] Action failed: ${err.message}`);
      // Continue — vision model will see the unchanged screen and adapt
      await sleep(500);
    }
  }

  return `需要复核：已执行 ${maxIter} 步，还没有稳定完成。最后动作：${actionHistory.slice(-2).join('；') || '无'}`;
  } finally {
    options.desktopRelay('desktop_cursor_glow_hide', {}).catch(() => {});
    if (wallpaperModeEnabled) {
      options.desktopRelay('desktop_set_wallpaper_mode', {
        enabled: false,
        source: 'computer_use',
      }).catch(() => {});
    }
    options.onProgress?.('光标光效已关闭');
  }
}
