import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { addMember, createOrg } from '../server/org/db';
import * as bindings from '../server/messaging/bindings';
import { captureMessagingBinding } from '../server/messaging/turn_authorization';
import { toolRegistry } from '../server/tools/registry';
import { handleRemoteLegalNoticeIntake } from '../server/messaging/legal_notice_intake';
import type { IncomingMessage } from '../server/messaging/types';

const execution = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../server/tools/execution_engine', async original => ({
  ...(await original<typeof import('../server/tools/execution_engine')>()), executeToolCallOrThrow: execution.call,
}));
let sequence = 0;
function fixture() {
  sequence++;
  const userId = `notice-revoke-user-${sequence}`;
  const orgId = createOrg('Synthetic', `notice-revoke-org-${sequence}`, userId).id;
  addMember(orgId, userId, 'owner');
  const code = bindings.createBindingCode('feishu', userId, orgId, 'work');
  const binding = bindings.consumeBindingCode('feishu', code.code, `platform-${sequence}`, `chat-${sequence}`)!;
  const message: IncomingMessage = { platform: 'feishu', userId: binding.platformUserId, chatId: binding.chatId!,
    userName: 'Synthetic', chatType: 'private', messageId: `notice-${sequence}`, raw: {}, timestamp: new Date().toISOString(),
    text: '请新建案件并归档：人民法院送达通知，张三诉李四合同纠纷。',
    boundUserId: userId, boundOrgId: orgId, bindingAuthorization: captureMessagingBinding(binding) };
  return { message, revoke: () => bindings.deleteBindingForUser(userId, binding.id, orgId, 'work') };
}
beforeAll(() => initDatabase());
afterEach(() => { vi.restoreAllMocks(); execution.call.mockReset(); });

describe('legal notice shortcut authorization', () => {
  it('passes live cancellation and the turn signal to its direct tool and stops post-tool work after revocation', async () => {
    const { message, revoke } = fixture();
    vi.spyOn(toolRegistry, 'get').mockReturnValue({ name: 'legal_message_intake_to_case' } as any);
    let finish!: (value: string) => void;
    execution.call.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const running = handleRemoteLegalNoticeIntake(message, { executionSignal: controller.signal, isCancelled: () => false });
    expect(execution.call).toHaveBeenCalledOnce();
    const context = execution.call.mock.calls[0][0].context;
    expect(context.executionSignal).toBe(controller.signal);
    expect(context.isCancelled()).toBe(false);
    revoke();
    expect(context.isCancelled()).toBe(true);
    finish('Synthetic tool completion');
    await expect(running).rejects.toMatchObject({ name: 'MessagingAuthorizationRevokedError' });
  });

  it('does not enter a legal tool when the binding was revoked before the shortcut starts', async () => {
    const { message, revoke } = fixture();
    revoke();
    await expect(handleRemoteLegalNoticeIntake(message)).rejects.toMatchObject({ name: 'MessagingAuthorizationRevokedError' });
    expect(execution.call).not.toHaveBeenCalled();
  });

  it('honors cancellation from the owning message route before starting legal intake', async () => {
    const { message } = fixture();
    await expect(handleRemoteLegalNoticeIntake(message, { isCancelled: () => true })).rejects.toMatchObject({ name: 'MessagingAuthorizationRevokedError' });
    expect(execution.call).not.toHaveBeenCalled();
  });
});
