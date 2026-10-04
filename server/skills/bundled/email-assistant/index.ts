import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
let mailparser: any = null;
async function getMailParser() {
  if (!mailparser) mailparser = await import('mailparser');
  return mailparser;
}

async function handler(args: any) {
  const { action, content, user } = args;
  try {
    if (action === 'parse') {
      if (!content) throw new Error('Email content required for parse');
      const { simpleParser } = await getMailParser();
      const parsed = await simpleParser(Buffer.from(String(content), 'utf-8'));
      const result = JSON.stringify({
        subject: parsed.subject || '(no subject)',
        from: parsed.from?.text || 'Unknown',
        to: parsed.to?.text || 'Unknown',
        date: parsed.date?.toISOString() || 'Unknown',
        textBody: (parsed.text || '').slice(0, 2000),
        htmlLength: parsed.html ? parsed.html.length : 0,
        attachments: (parsed.attachments || []).map(a => ({
          filename: a.filename,
          contentType: a.contentType,
          size: a.size,
        })),
      }, null, 2);
      return { content: [{ type: 'text' as const, text: result }] };
    }

    if (action === 'compose') {
      const to = String(args.to || '');
      const subject = String(args.subject || '');
      const body = String(args.body || '');
      if (!to || !subject) throw new Error('to and subject are required');
      // Build RFC2822 email with mailparser tools
      const headers = [
        `From: ${user || 'user@lumi.local'}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
      ].join('\r\n');
      const rawEmail = `${headers}\r\n\r\n${body}`;
      const result = JSON.stringify({
        action: 'compose',
        rawEmail,
        to,
        subject,
        bodyLength: body.length,
        hint: 'Use this raw email content with an SMTP send tool or mail command to send it.',
      }, null, 2);
      return { content: [{ type: 'text' as const, text: result }] };
    }

    throw new Error(`Unknown action: ${action}. Use: parse or compose.`);
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `Email processing failed: ${e.message}` }], isError: true };
  }
}

const server = new McpServer({ name: 'email-assistant', version: '1.0.0' }, { capabilities: { tools: {} } });
server.registerTool('email_assistant', {
  description: 'Parse raw email content or compose new emails. Parse extracts subject, from, to, body, attachments. Compose builds a RFC2822 email for sending.',
  inputSchema: {
    action: z.enum(['parse', 'compose']).describe('Parse an email or compose a new one'),
    content: z.string().optional().describe('Raw email source to parse (for parse action)'),
    to: z.string().optional().describe('Recipient email address (for compose)'),
    subject: z.string().optional().describe('Email subject (for compose)'),
    body: z.string().optional().describe('Email body text (for compose)'),
    user: z.string().optional().describe('Sender email address (for compose)'),
  },
}, handler);

const transport = new StdioServerTransport();
await server.connect(transport);
