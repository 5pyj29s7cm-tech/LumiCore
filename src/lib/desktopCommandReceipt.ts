export type NativeCommandResult = {
  success: boolean;
  output?: string | null;
};

/**
 * Preserve real command output. When a successful native command is silent,
 * return evidence only for adapter/process completion; this is deliberately
 * not evidence that the command's filesystem, application, or network effects
 * satisfied the user's task.
 */
export function desktopCommandRelayOutput(
  result: NativeCommandResult,
  commandId: string,
): string {
  const stdout = typeof result.output === 'string' ? result.output : '';
  if (stdout.trim()) return stdout;

  return JSON.stringify({
    ok: true,
    status: 'adapter_completed',
    receiptType: 'native_command_adapter',
    adapterCompleted: true,
    commandId,
    stdout: '',
    verificationScope: 'process_exit',
    limitations: [
      'The native command adapter completed without a non-zero or transport error.',
      'Filesystem, application, network, and task-level side effects are not independently verified by this receipt.',
    ],
  });
}
