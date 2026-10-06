

export const PROCESS_IDLE_TIMEOUT_MS = 60_000;

export const PROCESS_CONNECT_TIMEOUT_MS = 15_000;

export const DEFAULT_TOOL_CALL_WALL_TIMEOUT_MS = 120_000;

export class MCPRuntimeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MCPRuntimeTimeoutError';
  }
}

export function withMCPWallTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { onTimeout(); } catch {}
      reject(new MCPRuntimeTimeoutError(message));
    }, timeoutMs);
    operation.then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
