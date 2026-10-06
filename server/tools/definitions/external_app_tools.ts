import type { ToolRegistry } from '../registry';
import { registerExternalAppDiscoveryTools } from './external_app_discovery_tools';
import { registerBrowserTaskTools } from './browser_task_tools';
import { registerWechatDraftTools } from './wechat_draft_tools';
import { registerWechatReadTools } from './wechat_read_tools';
import { registerWechatSendTools } from './wechat_send_tools';
import { registerCadDeliveryTools } from './cad_delivery_tools';
export { parseWeChatSendVisionVerification } from './wechat_send_tools';
export { parseWeChatConversationReadyVerification } from './external_app_shared';

export function registerExternalAppTools(registry: ToolRegistry): void {
  registerExternalAppDiscoveryTools(registry);
  registerBrowserTaskTools(registry);
  registerWechatDraftTools(registry);
  registerWechatReadTools(registry);
  registerWechatSendTools(registry);
  registerCadDeliveryTools(registry);
}
