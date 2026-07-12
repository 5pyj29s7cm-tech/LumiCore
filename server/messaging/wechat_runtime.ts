import type { WeChatClawBotAdapter } from './wechat-clawbot';

let activeAdapter: WeChatClawBotAdapter | null = null;

export function setActiveWeChatAdapter(adapter: WeChatClawBotAdapter | null): void {
  activeAdapter = adapter;
}

export function getActiveWeChatAdapter(): WeChatClawBotAdapter | null {
  return activeAdapter;
}
