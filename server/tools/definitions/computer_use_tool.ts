import { ToolRegistry } from '../registry';
import { computerUseLoop } from '../../agents/computer_use';

const DEFAULT_COMPUTER_USE_STEPS = 12;
const MAX_COMPUTER_USE_STEPS = 50;

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function resolveComputerUseSteps(args: Record<string, any>, context?: any): number {
  const requested =
    positiveInt(args.max_steps)
    ?? positiveInt(args.maxIterations)
    ?? positiveInt(context?.toolPolicy?.maxIterations)
    ?? DEFAULT_COMPUTER_USE_STEPS;
  const policyLimit = positiveInt(context?.toolPolicy?.maxIterations) ?? MAX_COMPUTER_USE_STEPS;
  return Math.max(1, Math.min(requested, policyLimit, MAX_COMPUTER_USE_STEPS));
}

async function computerUse(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Computer use requires the Tauri desktop app.');
  }

  if (!context?.llmGetters) {
    throw new Error('Computer use requires a configured Vision Model. Set one in Settings -> LLM Providers -> Vision Model.');
  }

  const task = args.task || args.prompt || '';
  if (!task.trim()) {
    throw new Error('The "task" parameter is required. Describe what you want Lumi to do on the desktop.');
  }

  const maxIterations = resolveComputerUseSteps(args, context);

  return computerUseLoop(task, {
    userId: context.userId,
    desktopRelay: context.desktopRelay,
    llmGetters: context.llmGetters,
    maxIterations,
    onProgress: context.onProgress || ((step: string) => {
      console.log(`[ComputerUse] ${step}`);
    }),
    isCancelled: context.isCancelled,
  });
}

export function registerComputerUseTool(registry: ToolRegistry): void {
  registry.register({
    name: 'computer_use',
    description:
      'Take control of the user desktop to complete a task after foreground confirmation or inside an approved autonomous workflow. This tool uses screenshot capture and the configured Vision Model to understand what is on screen, enters wallpaper mode when available, shows/moves the visible cursor before clicks, then controls the mouse and keyboard step by step. Supports configured vision providers such as Qwen-VL/DashScope, GPT-4o, Gemini, Doubao Vision, Ollama, LM Studio, or relay models. Use this for opening applications, navigating websites, filling forms, closing dialogs, moving files, managing windows, or other visible desktop interactions. Each iteration takes a screenshot, analyzes it, executes one mouse/keyboard action, verifies through the next screenshot, and repeats. Default 12 iterations; capped by the active desktop/autonomy tool policy up to 50; wallpaper/cursor overlay is cleaned up when finished.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'Natural language description of what to do on the desktop. Be specific and sequential. Examples: "Open Chrome, go to github.com, and search for react hooks", "Close all error dialogs on screen", "Open Notepad and type Hello World".',
        },
        max_steps: {
          type: 'number',
          description: 'Maximum number of screenshot/action iterations. Default 12; capped by the active tool policy up to 50.',
        },
      },
      required: ['task'],
    },
    handler: computerUse,
    permission: 'user',
    securityLevel: 'safe',
  });
}
