import { ToolRegistry } from '../registry';

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
  });
}
