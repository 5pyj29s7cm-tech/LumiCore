import { makeApp, JWT_SECRET } from './helpers';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { collectChatArtifacts } from '../server/conversation/chat_artifacts';
import { projectConversationMessageForCustomer } from '../server/routes/conversations';
import { readDocumentPreview } from '../server/files/document_preview';
import { startIsolatedConversation, addMessage } from '../server/conversation/manager';
import { createXlsxWorkbook, writeXlsxWorkbook } from '../server/utils/spreadsheet';
import type { ToolExecutionRecord } from '../server/tools/types';

let app: Awaited<ReturnType<typeof makeApp>>;
let conversationId: string;
const userId = 'chat-preview-owner';
const root = process.env.LUMI_DATA_DIR!;
const output = path.join(root, 'Documents', '中文 sales report.csv');
const auth = { Cookie: `token=${jwt.sign({ uid: userId, role: 'admin' }, JWT_SECRET)}` };
const verified = (filePath: string): ToolExecutionRecord => ({ name: 'desktop_write_text_file', arguments: { path: filePath },
  result: JSON.stringify({ success: true, path: filePath }), terminalVerification: { status: 'verified', strategy: 'artifact', reason: 'Read back exact output' } });

beforeAll(async () => {
  app = await makeApp();
  const { default: fileRoutes } = await import('../routes/files');
  app.apiRouter.use('/', fileRoutes);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, 'product,quantity,price,total\nblue-cup,4,18,72');
  conversationId = startIsolatedConversation(userId, 'lumi', 'personal', '').id;
  addMessage({ userId, agentId: 'lumi', conversationId, role: 'assistant', content: 'Saved and verified.', toolCalls: [verified(output)] });
});
afterAll(() => app?.cleanup());

it('projects verified artifacts independently of prose, with durable conversation scope', () => {
  const message = projectConversationMessageForCustomer({ conversationId, role: 'assistant', message: 'Done.', toolCalls: JSON.stringify([verified(output)]) });
  expect(message.fileArtifacts).toHaveLength(1);
  expect(message.fileArtifacts[0]).toMatchObject({ fileName: '中文 sales report.csv', kind: 'sheet', path: output });
  const url = new URL(message.fileArtifacts[0].url, 'http://local.invalid');
  expect(url.searchParams.get('conversationId')).toBe(conversationId);
  expect(url.searchParams.get('path')).toBe(output);
});

it('does not attach a planned, failed, unverified or read-only file as generated output', () => {
  for (const record of [
    { ...verified(output), error: 'Write failed' },
    { ...verified(output), terminalVerification: { status: 'unverified' } },
    { ...verified(output), result: JSON.stringify({ success: false, path: output }) },
    { ...verified(output), name: 'read_file' },
  ]) expect(collectChatArtifacts([record], conversationId)).toEqual([]);
  expect(collectChatArtifacts('Saved to: C:/fake.txt')).toEqual([]);
});

it('delivers and previews only verified producer outputs from a completed workflow', async () => {
  const workflowOutput = path.join(root, 'Documents', 'workflow-result.csv');
  fs.writeFileSync(workflowOutput, 'quantity,total\n5,90');
  const payload = { ok: true, status: 'completed', runId: 'preview-run', workflowId: 'preview-definition', completedSteps: 3, totalSteps: 3,
    outputs: [
      { status: 'verified', capabilityId: 'read_file', result: 'File read: C:/private-input.csv' },
      { status: 'unverified', capabilityId: 'write_file', result: 'File written: C:/unverified.csv (3 bytes)' },
      { status: 'verified', capabilityId: 'write_file', result: `File written: ${workflowOutput} (19 bytes)` },
    ] };
  const record: ToolExecutionRecord = { ...verified(workflowOutput), name: 'get_workflow_run', arguments: { runId: 'preview-run' }, result: JSON.stringify(payload) };
  const artifacts = collectChatArtifacts([record], conversationId);
  expect(artifacts.map(item => item.path)).toEqual([workflowOutput]);
  addMessage({ userId, agentId: 'lumi', conversationId, role: 'assistant', content: 'Workflow completed.', toolCalls: [record] });
  const response = await fetch(`${app.url}${artifacts[0].url}&preview=1`, { headers: auth });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ kind: 'table', sections: [{ rows: [['quantity', 'total'], ['5', '90']] }] });
  for (const failed of [ { ...record, terminalVerification: undefined }, { ...record, name: 'read_file' },
    { ...record, outcome: 'failure' }, { ...record, result: JSON.stringify({ ...payload, success: false }) },
    { ...record, result: JSON.stringify({ ...payload, status: 'running' }) },
    { ...record, result: JSON.stringify({ ...payload, completedSteps: 2 }) } ]) expect(collectChatArtifacts([failed], conversationId)).toEqual([]);
});

it('previews a real output outside the generated directory using its owned receipt', async () => {
  const artifact = collectChatArtifacts([verified(output)], conversationId)[0];
  const response = await fetch(`${app.url}${artifact.url}&preview=1`, { headers: auth });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ kind: 'table', sections: [{ rows: [['product', 'quantity', 'price', 'total'], ['blue-cup', '4', '18', '72']] }] });
  const download = await fetch(`${app.url}${artifact.url}`, { headers: auth });
  expect(await download.text()).toContain('blue-cup,4,18,72');
});

it('rejects guessed paths, another conversation owner and missing authentication', async () => {
  const artifact = collectChatArtifacts([verified(output)], conversationId)[0];
  expect((await fetch(`${app.url}${artifact.url}&preview=1`)).status).toBe(401);
  const other = { Cookie: `token=${jwt.sign({ uid: 'someone-else', role: 'admin' }, JWT_SECRET)}` };
  expect((await fetch(`${app.url}${artifact.url}&preview=1`, { headers: other })).status).toBe(403);
  const secret = path.join(root, 'keys.json'); fs.writeFileSync(secret, '{"must":"stay private"}');
  const url = new URL(artifact.url, app.url); url.searchParams.set('path', secret);
  expect((await fetch(url, { headers: auth })).status).toBe(403);
  url.searchParams.set('path', output); url.searchParams.delete('conversationId');
  expect((await fetch(url, { headers: auth })).status).toBe(403);
});

it('does not let a produced directory junction expose a different file', async () => {
  const realDir = path.join(root, 'private-target'); fs.mkdirSync(realDir);
  const link = path.join(root, 'output-link'); fs.symlinkSync(realDir, link, 'junction');
  const linkedFile = path.join(link, 'redirected.txt'); fs.writeFileSync(path.join(realDir, 'redirected.txt'), 'private');
  addMessage({ userId, agentId: 'lumi', conversationId, role: 'assistant', content: 'Old output', toolCalls: [verified(linkedFile)] });
  const artifact = collectChatArtifacts([verified(linkedFile)], conversationId)[0];
  expect((await fetch(`${app.url}${artifact.url}`, { headers: auth })).status).toBe(403);
});

it('previews spreadsheet values, quoted CSV and passive HTML without running content', async () => {
  const sheetPath = path.join(root, 'report.xlsx');
  const workbook = await createXlsxWorkbook(); const sheet = workbook.addWorksheet('Sales');
  sheet.addRow(['Quantity', 'Total']); sheet.addRow([4, { formula: '4*18', result: 72 }]);
  await writeXlsxWorkbook(workbook, sheetPath);
  expect(await readDocumentPreview(sheetPath)).toMatchObject({ kind: 'table', sections: [{ name: 'Sales', rows: [['Quantity', 'Total'], ['4', '72']] }] });
  const csv = path.join(root, 'quoted.csv'); fs.writeFileSync(csv, 'name,note\r\n"cup, blue","line 1\nline 2"');
  expect(await readDocumentPreview(csv)).toMatchObject({ sections: [{ rows: [['name', 'note'], ['cup, blue', 'line 1\nline 2']] }] });
  const html = path.join(root, 'page.html'); fs.writeFileSync(html, '<script>window.secret=true</script>');
  expect(await readDocumentPreview(html)).toMatchObject({ kind: 'text', text: '<script>window.secret=true</script>' });
});

it('extracts Word, PDF and presentation content locally for inline previews', async () => {
  const { Document, Packer, Paragraph } = await import('docx');
  const docx = path.join(root, 'preview.docx');
  fs.writeFileSync(docx, await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Preview report 72')] }] })));
  expect(await readDocumentPreview(docx)).toMatchObject({ kind: 'text', extracted: true, text: expect.stringContaining('Preview report 72') });
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create(); pdf.addPage().drawText('Preview report 72');
  const pdfPath = path.join(root, 'preview.pdf'); fs.writeFileSync(pdfPath, await pdf.save());
  expect(await readDocumentPreview(pdfPath)).toMatchObject({ kind: 'text', extracted: true, truncated: false, text: expect.stringContaining('Preview report 72') });
  const { default: PptxGenJS } = await import('pptxgenjs');
  const presentation = new PptxGenJS(); presentation.addSlide().addText('Preview report 72', { x: 1, y: 1, w: 5, h: 1 });
  const pptx = path.join(root, 'preview.pptx'); await presentation.writeFile({ fileName: pptx });
  expect(await readDocumentPreview(pptx)).toMatchObject({ kind: 'text', extracted: true, text: expect.stringContaining('Preview report 72') });
});
