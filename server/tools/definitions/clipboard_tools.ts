import { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';

async function readClipboard(_args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Clipboard tools require the Tauri desktop app');
  }
  return context.desktopRelay('desktop_clipboard_read', {});
}

async function writeClipboard(args: Record<string, any>, context?: any): Promise<string> {
  if (!context?.desktopRelay) {
    throw new Error('Clipboard tools require the Tauri desktop app');
  }
  return context.desktopRelay('desktop_clipboard_write', { text: args.text || '' });
}

export function registerClipboardTools(registry: ToolRegistry): void {
  registry.register({
    name: 'read_clipboard',
    description:
      'Read clipboard text only when the user explicitly asks to inspect copied content or a selected workflow explicitly requires clipboard input. Never use clipboard contents to recover missing context or guess the current task.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: readClipboard,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'write_clipboard',
    description:
      'Write text to the user\'s system clipboard. Use this to provide the user with text they need to paste — code snippets, URLs, generated content.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to write to the clipboard.' },
      },
      required: ['text'],
    },
    handler: writeClipboard,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'desktop.clipboard.write-text',
      family: 'clipboard',
      lane: 'desktop',
      operation: 'mutate',
      risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'system clipboard text', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: [],
        successSignals: ['the native clipboard adapter accepted the exact text payload'],
        limitations: ['The receipt does not prove another application pasted the clipboard text.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'desktop.clipboard.write-text',
      operation: 'mutate',
      assurance: 'observed',
      subjectArgument: 'text',
    }),
  });
}
