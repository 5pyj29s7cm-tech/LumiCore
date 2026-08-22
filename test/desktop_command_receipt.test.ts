import { describe, expect, it } from 'vitest';
import { desktopCommandRelayOutput } from '../src/lib/desktopCommandReceipt';
import { verifyCapabilityReceipt } from '../server/tools/capability_verification';

describe('native desktop command relay receipts', () => {
  it('preserves non-empty stdout for backward compatibility', () => {
    expect(desktopCommandRelayOutput({
      success: true,
      output: 'exact command output\r\n',
    }, 'command-output')).toBe('exact command output\r\n');
  });

  it('returns a scoped structured receipt when a successful command is silent', () => {
    const output = desktopCommandRelayOutput({
      success: true,
      output: '',
    }, 'command-silent');

    expect(output).not.toBe('');
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      status: 'adapter_completed',
      receiptType: 'native_command_adapter',
      adapterCompleted: true,
      commandId: 'command-silent',
      stdout: '',
      verificationScope: 'process_exit',
    });
    expect(JSON.parse(output).limitations.join(' ')).toMatch(/side effects are not independently verified/i);
    expect(verifyCapabilityReceipt(undefined, { result: output })).toMatchObject({
      status: 'verified',
      strategy: 'terminal_receipt',
    });
  });

  it('treats whitespace-only and missing native output as silent', () => {
    for (const nativeOutput of ['   \r\n', null, undefined]) {
      const receipt = JSON.parse(desktopCommandRelayOutput({
        success: true,
        output: nativeOutput,
      }, 'command-no-text'));
      expect(receipt).toMatchObject({
        ok: true,
        status: 'adapter_completed',
        stdout: '',
      });
    }
  });
});
