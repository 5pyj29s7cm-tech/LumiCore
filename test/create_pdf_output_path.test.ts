import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { registerPdfTools } from '../server/tools/definitions/pdf_tools';
import { getGeneratedOutputDir } from '../server/config/data_path';
import { extractPdfTextContent } from '../server/utils/pdf_text';

beforeAll(() => initDatabase());

const context = { userId: 'pdf-output-path-test', authenticated: true, authRole: 'admin' as const,
  localExecution: true, userConfirmed: true, allowLocalFileWrites: true };
function registry(): ToolRegistry {
  const tools = new ToolRegistry();
  registerPdfTools(tools);
  return tools;
}
function output(name: string): string {
  return path.join(String(process.env.LUMI_DATA_DIR), 'pdf-output-path', name);
}

describe('create_pdf exact destination', () => {
  it('advertises an optional exact output path on the existing tool', () => {
    const definition = registry().get('create_pdf')!;
    expect(definition.parameters.properties.outputPath.type).toBe('string');
    expect(definition.parameters.required).not.toContain('outputPath');
  });

  it('creates and reads back a PDF at the exact new absolute path', async () => {
    const target = output(path.join('nested', 'requested.PDF'));
    const body = 'PDF-EXACT-DESTINATION-HEAD\nRetain the full supplied text.\nPDF-EXACT-DESTINATION-TAIL';
    const result = JSON.parse(await registry().execute('create_pdf', { outputPath: target, title: 'Exact output', content: body }, context));
    expect(result).toMatchObject({ ok: true, status: 'created', path: path.resolve(target), pageCount: 1 });
    expect(fs.readFileSync(target).subarray(0, 5).toString()).toBe('%PDF-');
    expect(result.size).toBe(fs.statSync(target).size);
    const text = (await extractPdfTextContent(target)).text;
    expect(text).toContain('PDF-EXACT-DESTINATION-HEAD');
    expect(text).toContain('PDF-EXACT-DESTINATION-TAIL');
  });

  it('keeps the timestamped generated-directory default when no path is requested', async () => {
    const result = JSON.parse(await registry().execute('create_pdf', { title: 'Legacy title', content: 'Default PDF output remains available.' }, context));
    expect(path.dirname(result.path)).toBe(getGeneratedOutputDir());
    expect(path.basename(result.path)).toMatch(/^Legacy title_\d+\.pdf$/);
    expect(fs.statSync(result.path).size).toBeGreaterThan(0);
  });

  it('binds one exact PDF destination from the existing current request', async () => {
    const target = output('bound-request.pdf');
    const result = JSON.parse(await registry().execute('create_pdf', { content: 'Bound PDF text.' }, {
      ...context, actionIntent: '请创建 ' + target + '，正文为 Bound PDF text。',
    }));
    expect(result.path).toBe(path.resolve(target));
    expect(fs.existsSync(target)).toBe(true);
  });

  it.each(['relative.pdf', output('wrong.docx'), 42])('rejects an invalid explicit destination without making a default PDF: %s', async outputPath => {
    const generated = getGeneratedOutputDir();
    const before = fs.readdirSync(generated).sort();
    await expect(registry().execute('create_pdf', { outputPath, content: 'Must not be written.' }, context))
      .rejects.toThrow(/outputPath must be an absolute \.pdf/);
    expect(fs.readdirSync(generated).sort()).toEqual(before);
  });

  it('preserves an existing target byte for byte instead of overwriting original material', async () => {
    const target = output('existing-source.pdf');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const original = Buffer.from('Synthetic original material must remain unchanged.');
    fs.writeFileSync(target, original);
    await expect(registry().execute('create_pdf', { outputPath: target, content: 'Do not replace the original.' }, context))
      .rejects.toThrow(/already exists/);
    expect(fs.readFileSync(target)).toEqual(original);
  });
});
