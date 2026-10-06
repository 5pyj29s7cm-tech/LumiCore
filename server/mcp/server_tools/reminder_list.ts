import { getDueReminders } from "../../memory";
import type { McpToolRuntime } from './contracts';
import { mcpToolFailure } from './failure';

export function registerLumiReminderListTool({ mcp, memoryScope }: Pick<McpToolRuntime, "mcp" | "memoryScope">) {


  // Tool: list reminders
  mcp.registerTool(
    'lumi_reminder_list',
    {
      description: 'Get all pending reminders that Lumi is tracking.',
      inputSchema: {},
    },
    async () => {
      try {
        const reminders = getDueReminders(memoryScope);
        return {
          content: [{
            type: 'text' as const,
            text: reminders.length === 0
              ? 'No pending reminders.'
              : JSON.stringify(reminders.map(r => ({
                  id: r.id,
                  content: r.content,
                  dueAt: r.dueAt,
                  status: r.status,
                })), null, 2),
          }],
        };
      } catch (err: any) {
        return mcpToolFailure('reminder list', err);
      }
    },
  );
}
