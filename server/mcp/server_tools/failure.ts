import { logger } from "../../../logger";
import { publicMcpToolFailure, sanitizeMcpLogValue } from "../public_security";

export function mcpToolFailure(operation: string, error: unknown) {
  logger.error(`[MCP Tool] ${operation} failed: ${sanitizeMcpLogValue((error as any)?.message || error)}`);
  return {
    content: [{ type: 'text' as const, text: publicMcpToolFailure() }],
    isError: true,
  };
}
