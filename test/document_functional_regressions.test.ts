import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { getGeneratedOutputDir } from '../server/config/data_path';
import { ToolRegistry } from '../server/tools/registry';
import { registerDocumentTools } from '../server/tools/definitions/document_tools';
import { loadXlsxWorkbook, worksheetToCsvPage } from '../server/utils/spreadsheet';
import { transcribeAudioFile } from '../server/stt/file_transcription';

vi.mock('../server/stt/file_transcription', async importOriginal => ({
  ...await importOriginal<typeof import('../server/stt/file_transcription')>(),
  transcribeAudioFile: vi.fn(async () => ({ text: 'Synthetic transcript', provider: 'relay', model: 'test/asr', language: 'zh' })),
}));

let registry: ToolRegistry;
const context = { userId: 'document-functional-user', requestConfirmation: async () => true };
beforeAll(async () => { await initDatabase(); });
beforeEach(() => {
  vi.clearAllMocks();
  registry = new ToolRegistry();
  registerDocumentTools(registry);
});
async function run(name: string, args: Record<string, unknown>) {
  return JSON.parse(await registry.execute(name, args, context));
}

describe('document functionality regressions', () => {
  it('leaves the configured STT choice intact and accepts an explicit official override', async () => {
    const audioPath = path.join(getGeneratedOutputDir(), 'synthetic.wav');
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });
    fs.writeFileSync(audioPath, 'synthetic audio; provider is mocked');
    await run('transcribe_audio_to_text_file', { filePath: audioPath });
    expect(vi.mocked(transcribeAudioFile).mock.calls[0][1]?.preferredProvider).toBeUndefined();
    await run('transcribe_audio_to_text_file', { filePath: audioPath, preferredProvider: 'relay' });
    expect(vi.mocked(transcribeAudioFile).mock.calls[1][1]?.preferredProvider).toBe('relay');
    await run('transcribe_audio_to_text_file', { filePath: audioPath, preferredProvider: 'auto' });
    expect(vi.mocked(transcribeAudioFile).mock.calls[2][1]?.preferredProvider).toBe('auto');
  });

  it('keeps object fields aligned across key order changes, missing values and new sheets', async () => {
    const data = [{ sku: 'A-1', qty: 2 }, { qty: 5, sku: 'B-2' }, { sku: 'C-3' }];
    const created = await run('create_xlsx', { sheets: [{ name: 'Orders', headers: ['sku', 'qty'], data }] });
    const workbook = await loadXlsxWorkbook(created.path);
    expect(workbook.getWorksheet('Orders').getRow(3).values.slice(1)).toEqual(['B-2', 5]);
    expect(workbook.getWorksheet('Orders').getCell('A4').value).toBe('C-3');
    expect(workbook.getWorksheet('Orders').getCell('B4').value).toBeNull();
    const modified = await run('modify_xlsx', { filePath: created.path, operations: [{ addSheet: true, sheet: 'Copy', headers: ['sku', 'qty'], data }] });
    expect((await loadXlsxWorkbook(modified.path)).getWorksheet('Copy').getRow(3).values.slice(1)).toEqual(['B-2', 5]);
    await expect(run('create_xlsx', { sheets: [{ headers: ['sku'], data: [{ sku: 'A', qty: 2 }] }] })).rejects.toThrow('missing from headers');
  });

  it('infers a stable union of object keys when headers are omitted', async () => {
    const created = await run('create_xlsx', { sheets: [{ name: 'Inferred', data: [{ sku: 'A' }, { qty: 5, sku: 'B' }] }] });
    const sheet = (await loadXlsxWorkbook(created.path)).getWorksheet('Inferred');
    expect(sheet.getRow(1).values.slice(1)).toEqual(['sku', 'qty']);
    expect(sheet.getRow(3).values.slice(1)).toEqual(['B', 5]);
  });

  it('pages a named sheet without silently dropping or cutting records', async () => {
    const data = Array.from({ length: 421 }, (_, i) => [`record-${i}`, 'complete field '.repeat(5)]);
    const created = await run('create_xlsx', { sheets: [{ name: 'Long', headers: ['id', 'description'], data }] });
    let startRow = 1;
    const pages: string[] = [];
    for (let page = 0; page < 10; page++) {
      const text = await registry.execute('read_xlsx', { filePath: created.path, sheetName: 'Long', startRow, maxRows: 200 }, context);
      pages.push(text);
      const next = text.match(/Continue with startRow=(\d+)/);
      if (!next) break;
      expect(text).toContain('[Truncated:');
      expect(Number(next[1])).toBeGreaterThan(startRow);
      startRow = Number(next[1]);
    }
    expect(pages.length).toBeGreaterThan(1);
    const records = pages.join('\n').match(/record-\d+,/g) || [];
    expect(records).toHaveLength(421);
    expect(new Set(records).size).toBe(421);
    expect(records.at(-1)).toBe('record-420,');
    expect(pages.at(-1)).not.toContain('[Truncated:');
    expect(await registry.execute('read_xlsx', { filePath: created.path, sheetName: 'Long', startRow: 1000 }, context)).toContain('No rows in this range');
    expect(await registry.execute('read_xlsx', { filePath: created.path, sheetName: 'Long', startRow: Infinity, maxRows: NaN }, context)).toContain('Rows 1-');
  });

  it('visits only the requested rows and keeps an oversized first row intact', () => {
    const getRow = vi.fn((index: number) => ({ getCell: () => ({ value: index === 80000 ? 'x'.repeat(12000) : 'next row' }) }));
    const page = worksheetToCsvPage({ rowCount: 100000, columnCount: 1, getRow }, 80000, 200);
    expect(page).toMatchObject({ endRow: 80000, hasMore: true, csv: 'x'.repeat(12000) });
    expect(getRow.mock.calls.map(call => call[0])).toEqual([80000, 80001]);
  });
});
