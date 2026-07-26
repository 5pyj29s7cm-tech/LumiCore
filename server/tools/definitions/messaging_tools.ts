import type { ToolRegistry } from '../registry';
import {
  listFeishuFileTargets,
  listPersonalWeChatFileTargets,
  sendLocalFileToFeishu,
} from '../../messaging/file_transfer';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';

export function registerMessagingTools(registry: ToolRegistry): void {
  registry.register({
    name: 'messaging_list_file_targets',
    description: 'List the current Lumi member\'s explicitly bound Feishu organization chats and personal WeChat conversations available for file transfer. Use before sending when a destination is not unique. This does not send anything.',
    parameters: {
      type: 'object',
      properties: {
        orgId: { type: 'string', description: 'Optional organization ID to narrow the target list.' },
      },
      required: [],
    },
    handler: async (args, context) => {
      const userId = String(context?.userId || '').trim();
      if (!userId) throw new Error('A bound Lumi user is required');
      const orgId = String(args.orgId || (context?.domain === 'work' ? context.orgId : '') || '').trim();
      return JSON.stringify({
        feishu: listFeishuFileTargets(userId, orgId),
        personalWeChat: listPersonalWeChatFileTargets(userId),
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'feishu_send_file',
    description: 'Send one real local file to an explicitly bound organization Feishu chat. Use only when the user explicitly asks to transfer/send the current attachment, a downloaded court-notice file, or an exact local file path. Personal-to-organization transfer is allowed for the same authorized member and is audit-logged. If several targets exist, call messaging_list_file_targets first and pass bindingId or chatId.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Exact local path of the file to upload and send.' },
        orgId: { type: 'string', description: 'Destination organization ID. Defaults to the active work organization.' },
        bindingId: { type: 'string', description: 'Bound Feishu destination ID when more than one target exists.' },
        chatId: { type: 'string', description: 'Bound Feishu chat ID when more than one target exists.' },
        displayName: { type: 'string', description: 'Optional filename shown in Feishu.' },
        note: { type: 'string', description: 'Optional short text sent immediately before the file.' },
      },
      required: ['filePath'],
    },
    handler: async (args, context) => {
      const userId = String(context?.userId || '').trim();
      if (!userId) throw new Error('A bound Lumi user is required');
      const result = await sendLocalFileToFeishu({
        userId,
        filePath: String(args.filePath || ''),
        orgId: String(args.orgId || (context?.domain === 'work' ? context.orgId : '') || ''),
        bindingId: String(args.bindingId || ''),
        chatId: String(args.chatId || ''),
        displayName: String(args.displayName || ''),
        note: String(args.note || ''),
        sourceDomain: context?.domain === 'work' ? 'work' : 'personal',
      });
      return JSON.stringify({
        sent: true,
        messageId: result.messageId,
        fileName: result.fileName,
        fileSize: result.fileSize,
        destination: result.target,
        sourceDomain: result.sourceDomain,
        audit: 'messaging.file.transfer_to_feishu',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'messaging.feishu.file.send',
      family: 'messaging',
      lane: 'messaging',
      operation: 'communicate',
      risk: 'high',
      sideEffects: [{ type: 'external_communication', scope: 'explicit bound Feishu destination and local file', reversible: false }],
      verification: {
        strategy: 'provider_ack',
        required: true,
        requiredFields: ['sent', 'messageId', 'fileName', 'fileSize', 'destination'],
        requiredValues: { sent: true },
        successStatuses: [],
        successSignals: ['Feishu returned a message id for the exact uploaded file and bound destination'],
        limitations: ['Provider acceptance does not prove the recipient opened the file.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'messaging.feishu.file.send',
      operation: 'communicate',
      subjectArgument: 'filePath',
      limitations: ['The destination must be an explicitly bound organization chat.'],
    }),
  });
}
