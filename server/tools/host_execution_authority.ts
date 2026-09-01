import type { ToolContext } from './types';

const AUTONOMOUS_HOST_AUTHORITY = Symbol('lumi.autonomous_host_authority');

interface AutonomousHostAuthority {
  ownerUserId: string;
  taskId: string;
}

type BrandedToolContext = ToolContext & {
  [AUTONOMOUS_HOST_AUTHORITY]?: AutonomousHostAuthority;
};

/**
 * Process-local authority attached only after the host claims an autonomous
 * task. Symbol keys cannot arrive through client JSON and survive the bounded
 * object spreads used by the canonical execution path.
 */
export function attachAutonomousHostAuthority<T extends ToolContext>(
  context: T,
  input: AutonomousHostAuthority,
): T {
  Object.defineProperty(context, AUTONOMOUS_HOST_AUTHORITY, {
    value: Object.freeze({
      ownerUserId: String(input.ownerUserId || ''),
      taskId: String(input.taskId || ''),
    }),
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return context;
}

export function hasAutonomousHostAuthority(
  context: ToolContext | undefined,
  ownerUserId: string,
): boolean {
  const authority = (context as BrandedToolContext | undefined)?.[AUTONOMOUS_HOST_AUTHORITY];
  return Boolean(
    authority
    && authority.ownerUserId === String(ownerUserId || '')
    && authority.taskId
    && authority.taskId === String(context?.taskId || '')
    && context?.autonomous === true
    && context?.domain !== 'work'
    && !String(context?.orgId || '').trim(),
  );
}
