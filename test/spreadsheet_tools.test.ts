import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import JSZip from 'jszip';
import { loadXlsxWorkbook, prepareSpreadsheetRows } from '../server/utils/spreadsheet';
import { createRequire } from 'node:module';
import { ToolRegistry } from '../server/tools/registry';
import { registerDocumentTools } from '../server/tools/definitions/document_tools';
import { missingSpreadsheetRequirements } from '../server/cognition/spreadsheet_requirements';

const createdFiles = new Set<string>();

function remember(filePath: string): string {
  createdFiles.add(filePath);
  return filePath;
}

function extractPath(result: string): string {
  try {
    const parsed = JSON.parse(result);
    if (typeof parsed?.path === 'string' && parsed.path) return remember(parsed.path);
  } catch {}
  const match = result.match(/[A-Z]:\\.+?\.xlsx|\/.+?\.xlsx/);
  if (!match) throw new Error(`No xlsx path found in result: ${result}`);
  return remember(match[0]);
}

afterEach(() => {
  for (const filePath of createdFiles) {
    try { fs.rmSync(filePath, { force: true }); } catch {}
  }
  createdFiles.clear();
});

describe('spreadsheet document tools', () => {
  it('distinguishes a missing total formula from existing item formulas', async () => {
    const registry = new ToolRegistry();
    registerDocumentTools(registry);
    const result = JSON.parse(await registry.execute('create_xlsx', { sheets: [{ name:'Report',
      headers:['item','qty','price','amount'],data:[['A',2,120,'=B2*C2'],['Total',null,null,240]] }],
    }, { requestConfirmation: async () => true }));
    remember(result.path);
    expect(result).toMatchObject({formulaCount:1,totalFormulaCount:0});
    const records:any[]=[{name:'create_xlsx',result:JSON.stringify(result),terminalVerification:{status:'verified'}}];
    expect(missingSpreadsheetRequirements('Use formulas for amounts and a total formula.',records)).toContain('grand_total_formula');
    expect(missingSpreadsheetRequirements('Use formulas for item amounts. No total formula.',records)).not.toContain('grand_total_formula');
  });
  it('writes real formulas and a chart, then recalculates the saved copy without losing the chart', async () => {
    const registry = new ToolRegistry();
    registerDocumentTools(registry);
    const context = { requestConfirmation: async () => true };
    const outputPath = remember(path.join(os.tmpdir(), `lumi-formula-chart-${Date.now()}.xlsx`));
    const created = JSON.parse(await registry.execute('create_xlsx', {
      outputPath,
      sheets: [{ name: 'Orders', headers: ['item', 'qty', 'price', 'amount'], data: [
        ['A', 2, 120, '=B2*C2'], ['B', 4, 85, '=B3*C3'], ['C', 3, 140, '=B4*C4'], ['Total', null, null, '=SUM(D2:D4)'],
      ], charts: [{ type: 'column', categories: 'A2:A4', values: 'D2:D4', title: 'Purchase amounts', anchor: 'F2' }] }],
    }, context));
    expect(created).toMatchObject({ path: outputPath, formulaCount: 4, totalFormulaCount: 1, chartCount: 1, unresolvedFormulas: [] });
    const sourceBytes = fs.readFileSync(outputPath);
    const initial = await loadXlsxWorkbook(outputPath);
    expect(initial.getWorksheet('Orders').getCell('D5').value).toEqual({ formula: 'SUM(D2:D4)', result: 1000 });
    const updatedPath = remember(outputPath.replace('.xlsx', '-updated.xlsx'));
    const updated = JSON.parse(await registry.execute('modify_xlsx', { filePath: outputPath,
      operations: [{ sheet: 'Orders', match: { column: 'item', value: 'B' }, column: 'qty', value: 6 }],
    }, { ...context, actionIntent: `Change item B quantity to 6 and save as ${updatedPath}` }));
    expect(updated).toMatchObject({ formulaCount: 4, chartCount: 1, unresolvedFormulas: [] });
    expect(updated.appliedEdits).toEqual([{ sheet: 'Orders', cell: 'B3', previous: 4, value: 6 }]);
    expect(updated.calculatedCells).toContainEqual(expect.objectContaining({ sheet: 'Orders', cell: 'D5', value: 1170 }));
    expect(fs.readFileSync(outputPath)).toEqual(sourceBytes);
    const workbook = await loadXlsxWorkbook(updatedPath);
    expect(workbook.getWorksheet('Orders').getCell('D5').result).toBe(1170);
    const zip = await JSZip.loadAsync(fs.readFileSync(updatedPath));
    expect((await zip.file('xl/worksheets/sheet1.xml')!.async('string')).match(/<f>/g)).toHaveLength(4);
    const chart = await zip.file('xl/charts/lumiChart1_1.xml')!.async('string');
    expect(chart).toContain('<c:v>510</c:v>');
    expect(chart).not.toContain('<c:v>340</c:v>');
    expect(await zip.file('xl/worksheets/_rels/sheet1.xml.rels')!.async('string')).toContain('lumiDrawing1.xml');
    expect(await registry.execute('read_xlsx', { filePath: updatedPath, sheetName: 'Orders' })).toContain('Total,,,1170');
    const rejectedPath = remember(outputPath.replace('.xlsx', '-rejected.xlsx'));
    await expect(registry.execute('modify_xlsx', {filePath:outputPath,outputPath:rejectedPath,
      operations:[{sheet:'Orders',match:{column:'item',value:'missing'},column:'qty',value:6}]},context)).rejects.toThrow(/exactly one data row/);
    expect(fs.existsSync(rejectedPath)).toBe(false);
    expect(fs.readFileSync(outputPath)).toEqual(sourceBytes);
  });

  it('normalizes an implicit edit to a copy while retaining explicit overwrite boundaries', async () => {
    const registry = new ToolRegistry(); registerDocumentTools(registry);
    const context = { requestConfirmation: async () => true };
    const source = remember(path.join(os.tmpdir(), `lumi-echoed-output-${Date.now()}.xlsx`));
    await registry.execute('create_xlsx', { outputPath: source, sheets: [{name:'Orders',headers:['item','qty','price','amount'],data:[['A',2,12,'=B2*C2']]}] }, context);
    const bytes = fs.readFileSync(source);
    const args = {filePath:source,outputPath:source,operations:[{sheet:'Orders',cell:'B2',value:4}]};
    const result = JSON.parse(await registry.execute('modify_xlsx', args, {...context,actionIntent:'Update the previous workbook quantity to 4 and save the result.'}));
    remember(result.path);
    expect(result.path).not.toBe(source);
    expect((await loadXlsxWorkbook(result.path)).getWorksheet('Orders').getCell('D2').value).toEqual({formula:'B2*C2',result:48});
    expect(fs.readFileSync(source)).toEqual(bytes);
    for (const actionIntent of ['Overwrite the original workbook in-place.', `Save as ${source}`]) {
      await expect(registry.execute('modify_xlsx', args, {...context,actionIntent})).rejects.toThrow(/must differ/);
      expect(fs.readFileSync(source)).toEqual(bytes);
    }
  });
  it('does not invent cached results for unsupported or circular formulas', async () => {
    const registry = new ToolRegistry();
    registerDocumentTools(registry);
    const result = JSON.parse(await registry.execute('create_xlsx', { sheets: [{ name: 'Check', data: [
      [{ formula: 'A1+1', result: 99 }, { formula: 'UNKNOWN(5)', result: 123 }, '=ROUND(2.345,2)'],
    ] }] }, { requestConfirmation: async () => true }));
    remember(result.path);
    expect(result.unresolvedFormulas).toEqual(['Check!A1', 'Check!B1']);
    const workbook = await loadXlsxWorkbook(result.path);
    expect(workbook.getWorksheet('Check').getCell('A1').result).toBeUndefined();
    expect(workbook.getWorksheet('Check').getCell('B1').result).toBeUndefined();
    expect(workbook.getWorksheet('Check').getCell('C1').result).toBe(2.35);
    expect(prepareSpreadsheetRows(['a'], [{ a: '=1+2' }]).rows).toEqual([[{ formula: '1+2' }]]);
  });

  it('honors an exact DOCX destination and preserves heading/paragraph order', async () => {
    const registry = new ToolRegistry();
    registerDocumentTools(registry);
    const outputPath = remember(path.join(os.tmpdir(), `lumi-document-order-${Date.now()}.docx`));
    const result = JSON.parse(await registry.execute('create_docx', { outputPath, title: 'Meeting', blocks: [
      { type: 'heading', text: 'Arrangements' }, { type: 'paragraph', text: '6 attendees, budget 1200.' },
      { type: 'heading', text: 'Agenda' }, { type: 'paragraph', text: 'Planning and review.' },
    ] }, { requestConfirmation: async () => true }));
    expect(result.path).toBe(outputPath);
    const mammoth = createRequire(import.meta.url)('mammoth');
    const text = (await mammoth.extractRawText({ path: outputPath })).value;
    expect(text.indexOf('6 attendees')).toBeLessThan(text.indexOf('Agenda'));
    expect(text.indexOf('Agenda')).toBeLessThan(text.indexOf('Planning'));
  });

  it('creates, reads, modifies, and converts xlsx files without SheetJS', async () => {
    const registry = new ToolRegistry();
    registerDocumentTools(registry);
    const context = { requestConfirmation: async () => true };

    const created = await registry.execute('create_xlsx', {
      filename: 'spreadsheet-tool-regression',
      sheets: [
        { name: 'Orders', headers: ['sku', 'qty'], data: [['A-1', 2], ['B-2', 5]] },
      ],
    }, context);
    const xlsxPath = extractPath(created);

    const read = await registry.execute('read_xlsx', { filePath: xlsxPath, sheetName: 'Orders' });
    expect(read).toContain('sku,qty');
    expect(read).toContain('A-1,2');

    const modified = await registry.execute('modify_xlsx', {
      filePath: xlsxPath,
      operations: [
        { sheet: 'Orders', cell: 'B2', value: 3 },
        { addSheet: true, sheet: 'Summary', headers: ['metric', 'value'], data: [['total', 8]] },
      ],
    }, context);
    const modifiedPath = extractPath(modified);
    const modifiedRead = await registry.execute('read_xlsx', { filePath: modifiedPath, sheetName: 'Summary' });
    expect(modifiedRead).toContain('metric,value');
    expect(modifiedRead).toContain('total,8');

    const csvPath = remember(modifiedPath.replace(/\.xlsx$/i, '.csv'));
    const csv = await registry.execute('xlsx_to_csv', { filePath: modifiedPath, sheetName: 'Orders', outputPath: csvPath }, context);
    expect(JSON.parse(csv)).toMatchObject({ ok: true, status: 'converted', path: csvPath });
    expect(fs.readFileSync(csvPath, 'utf-8')).toContain('A-1,3');
  });

  it('fails legacy xls files with a clear conversion hint', async () => {
    const registry = new ToolRegistry();
    registerDocumentTools(registry);
    const xlsPath = remember(path.join(process.cwd(), 'lumi_output', `legacy_${Date.now()}.xls`));
    fs.mkdirSync(path.dirname(xlsPath), { recursive: true });
    fs.writeFileSync(xlsPath, 'not a real workbook');

    await expect(registry.execute('read_xlsx', { filePath: xlsPath })).rejects.toThrow('Convert the file to .xlsx or .csv first');
  });
});
