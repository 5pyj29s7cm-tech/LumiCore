import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeDiagnosticValue } from '../server/client/diagnostic_sanitizer';
import { parseDocument } from '../server/legal/parser';
import { extractPdfTextContent } from '../server/utils/pdf_text';
import { ToolRegistry } from '../server/tools/registry';
import { registerDocumentTools } from '../server/tools/definitions/document_tools';
import { registerPdfTools } from '../server/tools/definitions/pdf_tools';

const ENCRYPTED_PDF_BASE64 = 'JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9OYW1lIC9GMSAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDggMCBSIC9NZWRpYUJveCBbIDAgMCA1OTUuMjc1NiA4NDEuODg5OCBdIC9QYXJlbnQgNyAwIFIgL1Jlc291cmNlcyA8PAovRm9udCAxIDAgUiAvUHJvY1NldCBbIC9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9JbWFnZUkgXQo+PiAvUm90YXRlIDAgL1RyYW5zIDw8Cgo+PiAKICAvVHlwZSAvUGFnZQo+PgplbmRvYmoKNCAwIG9iago8PAovUGFnZU1vZGUgL1VzZU5vbmUgL1BhZ2VzIDcgMCBSIC9UeXBlIC9DYXRhbG9nCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9BdXRob3IgKFwwMDdcMzM3XDAxNlwzNjQmXDM1MFwzNDF+XDIzNCkgL0NyZWF0aW9uRGF0ZSAoIlwyMTNTXDI1Mm1cMjYzXDI3NjxcMzM1XDMxNUhcMzM3XDIyMVwzMDdcMzQ1PVwyMTNcMzQ0QVwzNzJcMzI2XDAyN1wyNTMpIC9DcmVhdG9yIChcMDA3XDMzN1wwMTZcMzY0JlwzNTBcMzQxflwyMzQpIC9LZXl3b3JkcyAoKSAvTW9kRGF0ZSAoIlwyMTNTXDI1Mm1cMjYzXDI3NjxcMzM1XDMxNUhcMzM3XDIyMVwzMDdcMzQ1PVwyMTNcMzQ0QVwzNzJcMzI2XDAyN1wyNTMpIC9Qcm9kdWNlciAoNFwzMjRcMDIxXDM2NS1cMzYxXDMwMmpcMjE1XDMzNCpcMjUxXDM0NVwzMjRcMjMwY1wzMDJcMjQ2XDAzMFwyNTdcMjM3XDAwN1wyNDFcMDA3XDM0MHJcMzY1XDI1MElcMzA1ZVwyNTZcMjcwJlwyNDVcMDIwKSAKICAvU3ViamVjdCAoXDAyM1wzMzdcMDIyXDM1MjpcMzQ2XDM0N21cMjA2XDIzMVwwMzYpIC9UaXRsZSAoXDAyM1wzMzdcMDI1XDM2MytcMzUxXDM1M28pIC9UcmFwcGVkIC9GYWxzZQo+PgplbmRvYmoKNiAwIG9iago8PAovRmlsdGVyIC9TdGFuZGFyZCAvTGVuZ3RoIDEyOCAvTyA8RDZGNDJDMEYzODYzN0E3RThFMDA4OTVGMjkyMzQ1NTEyMERBMkM0NjcxMjA5NzBBMTVDQ0MzNDZGNjQ2OUU4ND4gL1AgLTQ0IC9SIDMgL1UgPEY0RUFDNjhCQ0NBRjlBNjMxMjE2NTQ4RUNERDY3NTRDMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA+IAogIC9WIDIKPj4KZW5kb2JqCjcgMCBvYmoKPDwKL0NvdW50IDEgL0tpZHMgWyAzIDAgUiBdIC9UeXBlIC9QYWdlcwo+PgplbmRvYmoKOCAwIG9iago8PAovRmlsdGVyIFsgL0FTQ0lJODVEZWNvZGUgL0ZsYXRlRGVjb2RlIF0gL0xlbmd0aCAxMTYKPj4Kc3RyZWFtCobxjo0ftQ1H2p+Q6tm1Wc2L3F1Jd3BmZOyTpfkXjGyPUgXgd/giYfqbbAbD+SS0upaRQ+UNYWf/s5aORj+inO1Zz1iGpaigjhrt0a/SWW1zI5/AK+cweLcpU6M0a89/F7pscRCqJaKahNDx2Zr96+dLr+XGZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgOQowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwNjEgMDAwMDAgbiAKMDAwMDAwMDA5MiAwMDAwMCBuIAowMDAwMDAwMTk5IDAwMDAwIG4gCjAwMDAwMDA0MDIgMDAwMDAgbiAKMDAwMDAwMDQ3MCAwMDAwMCBuIAowMDAwMDAwOTkzIDAwMDAwIG4gCjAwMDAwMDEyMDQgMDAwMDAgbiAKMDAwMDAwMTI2MyAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9FbmNyeXB0IDYgMCBSCi9JRCAKWzxiZTE0ZmVkNjE0NDU2YTllMzE4YmM5OTJjMjEyN2I4Zj48YmUxNGZlZDYxNDQ1NmE5ZTMxOGJjOTkyYzIxMjdiOGY+XQolIFJlcG9ydExhYiBnZW5lcmF0ZWQgUERGIGRvY3VtZW50IC0tIGRpZ2VzdCAob3BlbnNvdXJjZSkKCi9JbmZvIDUgMCBSCi9Sb290IDQgMCBSCi9TaXplIDkKPj4Kc3RhcnR4cmVmCjE0NjkKJSVFT0YK';

describe('password-protected PDF support', () => {
  let tempDir = '';
  let pdfPath = '';

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-password-pdf-'));
    pdfPath = path.join(tempDir, 'protected.pdf');
    fs.writeFileSync(pdfPath, Buffer.from(ENCRYPTED_PDF_BASE64, 'base64'));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('distinguishes a missing password from an incorrect password without exposing either value', async () => {
    await expect(extractPdfTextContent(pdfPath)).rejects.toMatchObject({
      code: 'PDF_PASSWORD_REQUIRED',
    });

    try {
      await extractPdfTextContent(pdfPath, 'wrong-password-value');
      throw new Error('Expected incorrect password error');
    } catch (error: any) {
      expect(error.code).toBe('PDF_PASSWORD_INCORRECT');
      expect(error.message).not.toContain('wrong-password-value');
    }
  });

  it('reads encrypted content through the native PDF and generic document tools', async () => {
    const registry = new ToolRegistry();
    registerPdfTools(registry);
    registerDocumentTools(registry);

    const pdfResult = await registry.execute('read_pdf', { filePath: pdfPath, password: 'open-sesame' });
    const documentResult = await registry.execute('extract_document_text', { filePath: pdfPath, password: 'open-sesame' });
    const textExportResult = await registry.execute('pdf_to_text', {
      filePath: pdfPath,
      password: 'open-sesame',
    }, {
      allowLocalFileWrites: true,
      localWriteIntentReason: 'The test explicitly requests a plaintext export artifact.',
    });
    const diffResult = await registry.execute('diff_documents', {
      filePath1: pdfPath,
      filePath2: pdfPath,
      password1: 'open-sesame',
      password2: 'open-sesame',
      outputFormat: 'summary',
    });
    const parsed = await parseDocument(pdfPath, { password: 'open-sesame' });

    expect(pdfResult).toContain('Pages: 1');
    expect(pdfResult).toContain('Lumi encrypted PDF test');
    expect(documentResult).toContain('Lumi encrypted PDF test');
    expect(textExportResult).toContain('protected.txt');
    expect(fs.readFileSync(path.join(tempDir, 'protected.txt'), 'utf8')).toContain('Lumi encrypted PDF test');
    expect(diffResult).toContain('Change ratio: ~0%');
    expect(parsed?.text).toContain('Lumi encrypted PDF test');
  });

  it('declares password as optional and redacts it from tool records', () => {
    const registry = new ToolRegistry();
    registerPdfTools(registry);
    registerDocumentTools(registry);
    const declarations = registry.getToolDeclarations();

    for (const toolName of ['read_pdf', 'pdf_to_text', 'extract_document_text', 'ingest_document_to_rag']) {
      const declaration = declarations.find(item => item.function.name === toolName);
      expect(declaration?.function.parameters.properties.password.type).toBe('string');
      expect(declaration?.function.parameters.required || []).not.toContain('password');
    }
    const diffDeclaration = declarations.find(item => item.function.name === 'diff_documents');
    expect(diffDeclaration?.function.parameters.properties.password1.type).toBe('string');
    expect(diffDeclaration?.function.parameters.properties.password2.type).toBe('string');

    expect(sanitizeDiagnosticValue({ filePath: pdfPath, password: 'open-sesame' })).toEqual({
      filePath: pdfPath,
      password: '[redacted]',
    });

    const executionEngineSource = fs.readFileSync(path.join(process.cwd(), 'server/tools/execution_engine.ts'), 'utf8');
    expect(executionEngineSource).toContain('SECRET_ARGUMENT_RE');
    expect(executionEngineSource).toContain('arguments: receiptArguments');
    expect(executionEngineSource).toContain('onToolStart?.({');
  });
});
