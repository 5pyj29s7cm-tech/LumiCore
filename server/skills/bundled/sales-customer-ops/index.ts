import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  draftFollowUp,
  handleObjection,
  reviewCustomerHealth,
  scoreLead,
  triageSupportTickets,
} from './logic';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: 'sales-customer-ops', version: '1.2.0' }, { capabilities: { tools: {} } });

server.registerTool('lead_score', {
  description: 'Score a sales lead from notes and identify signals, grade, and next best action.',
  inputSchema: {
    leadText: z.string().describe('Lead notes or chat history'),
    product: z.string().optional().describe('Product or service'),
  },
}, async (args: any) => ok(scoreLead(args)));

server.registerTool('sales_followup_draft', {
  description: 'Draft a customer follow-up message from context, goal, and tone.',
  inputSchema: {
    customerName: z.string().optional().describe('Customer name'),
    context: z.string().describe('Conversation or customer context'),
    goal: z.string().optional().describe('Desired next step'),
    tone: z.enum(['warm', 'direct', 'consultative']).optional().describe('Message tone'),
  },
}, async (args: any) => ok(draftFollowUp(args)));

server.registerTool('objection_response_builder', {
  description: 'Classify a customer objection and produce a response frame plus suggested reply.',
  inputSchema: {
    objection: z.string().describe('Customer objection'),
    product: z.string().optional().describe('Product or service'),
    customerContext: z.string().optional().describe('Customer context'),
  },
}, async (args: any) => ok(handleObjection(args)));

server.registerTool('customer_health_review', {
  description: 'Review customer notes into health scores, at-risk accounts, and next actions.',
  inputSchema: {
    customerText: z.string().describe('Customer/account lines, one per customer'),
  },
}, async (args: any) => ok(reviewCustomerHealth(args)));

server.registerTool('support_ticket_triage', {
  description: 'Triage support tickets by severity and category, with suggested first replies and routing summary.',
  inputSchema: {
    ticketText: z.string().describe('Support tickets, one per line'),
  },
}, async (args: any) => ok(triageSupportTickets(args)));

const transport = new StdioServerTransport();
await server.connect(transport);
