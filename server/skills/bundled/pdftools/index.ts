import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs/promises';
let pdfLib: any = null;
async function getPDFLib() {
  if (!pdfLib) pdfLib = await import('pdf-lib');
  return pdfLib;
}

async function handler(args: any) {
  const { action, files, output } = args;
  try {
    const { PDFDocument } = await getPDFLib();
    if (action === 'merge') {
      if (!files || !Array.isArray(files) || files.length < 2) {
        throw new Error('At least 2 PDF file paths required for merge');
      }
      const mergedDoc = await PDFDocument.create();
      for (const filePath of files) {
        const bytes = await fs.readFile(String(filePath));
        const doc = await PDFDocument.load(bytes);
        const copiedPages = await mergedDoc.copyPages(doc, doc.getPageIndices());
        copiedPages.forEach(p => mergedDoc.addPage(p));
      }
      const pdfBytes = await mergedDoc.save();
      const outPath = String(output || 'merged.pdf');
      await fs.writeFile(outPath, pdfBytes);
      const result = JSON.stringify({
        action: 'merge',
        inputFiles: files.length,
        totalPages: mergedDoc.getPageCount(),
        output: outPath,
        sizeBytes: pdfBytes.length,
      }, null, 2);
      return { content: [{ type: 'text' as const, text: result }] };
    }

    if (action === 'info') {
      if (!files || !Array.isArray(files) || files.length === 0) {
        throw new Error('At least 1 PDF file path required');
      }
      const results: any[] = [];
      for (const filePath of files) {
        const bytes = await fs.readFile(String(filePath));
        const doc = await PDFDocument.load(bytes);
        results.push({
          file: String(filePath),
          pages: doc.getPageCount(),
          title: doc.getTitle() || 'Untitled',
          author: doc.getAuthor() || 'Unknown',
          creator: doc.getCreator() || 'Unknown',
          sizeBytes: bytes.length,
        });
      }
      const result = JSON.stringify(results, null, 2);
      return { content: [{ type: 'text' as const, text: result }] };
    }

    throw new Error(`Unknown action: ${action}. Use: merge or info.`);
  } catch (e: any) {
    return { content: [{ type: 'text' as const, text: `PDF processing failed: ${e.message}` }], isError: true };
  }
}

const server = new McpServer({ name: 'pdftools', version: '1.0.1' }, { capabilities: { tools: {} } });
server.registerTool('pdf_tools', {
  description: 'Work with PDF files: merge multiple PDFs or inspect document metadata. Input must be local file paths.',
  inputSchema: {
    action: z.enum(['merge', 'info']).describe('Action: merge PDFs or inspect metadata'),
    files: z.array(z.string()).describe('Array of PDF file paths'),
    output: z.string().optional().describe('Output file path (for merge, default: merged.pdf)'),
  },
}, handler);

const transport = new StdioServerTransport();
await server.connect(transport);
