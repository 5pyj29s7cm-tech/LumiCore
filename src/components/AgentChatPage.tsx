import { useChatIdentityAndState } from './agent_chat/state/use_chat_identity_and_state';
import { useChatAttachmentsAndPresentation } from './agent_chat/state/use_chat_attachments_and_presentation';
import { useChatHistoryAndRequests } from './agent_chat/state/use_chat_history_and_requests';
import { useChatScopeInitialization } from './agent_chat/state/use_chat_scope_initialization';
import { useChatSocketEvents } from './agent_chat/state/use_chat_socket_events';
import { useChatRequestControls } from './agent_chat/state/use_chat_request_controls';
import { useChatMediaControls } from './agent_chat/state/use_chat_media_controls';
import { useChatUploadsAndView } from './agent_chat/state/use_chat_uploads_and_view';

export { type AgentChatVoiceSession } from "./agent_chat/contracts";
export { buildChatHistoryPayload } from "./agent_chat/history";
export type { ChatStreamReceiverInput } from './agent_chat/state/shared';

export function AgentChatPage(props: Parameters<typeof useChatIdentityAndState>[0]) {
  const state0 = useChatIdentityAndState(props);
  const state1 = useChatAttachmentsAndPresentation(state0);
  const state2 = useChatHistoryAndRequests(state1);
  const state3 = useChatScopeInitialization(state2);
  const state4 = useChatSocketEvents(state3);
  const state5 = useChatRequestControls(state4);
  const state6 = useChatMediaControls(state5);
  return useChatUploadsAndView(state6);
}
