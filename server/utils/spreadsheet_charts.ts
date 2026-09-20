import JSZip from 'jszip';
import { rangeCells } from './spreadsheet_formulas';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const xml = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const unxml = (value: string) => value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const relationships = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
const relation = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${xml(target)}"/>`;
const override = (name: string, type: string) => `<Override PartName="/${name}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`;
const cache = (values: unknown[], numeric: boolean) => `${numeric ? '<c:formatCode>General</c:formatCode>' : ''}<c:ptCount val="${values.length}"/>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${xml(v)}</c:v></c:pt>`).join('')}`;

export interface SpreadsheetChart { type: 'bar' | 'column'; title?: string; categories: string; values: string; anchor?: string; }
export interface SheetCharts { sheet: string; charts: SpreadsheetChart[]; }

function chartXml(sheet: any, spec: SpreadsheetChart): string {
  if (!['bar', 'column'].includes(spec.type)) throw new Error('Supported spreadsheet chart types: bar, column.');
  const categories = rangeCells(sheet, spec.categories).map(c => c.text);
  const values = rangeCells(sheet, spec.values).map(c => c.formula ? c.result : c.value);
  if (!values.length || values.length !== categories.length || values.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error(`Chart ${sheet.name}: categories=${spec.categories} (${categories.length} cells), values=${spec.values} (${values.length} cells). Each value cell must exist and contain a numeric value or a calculated formula. Current values: ${JSON.stringify(values.slice(0, 12))}. Add the missing amount/formula column to sheet.data, then point values to that column range; do not put formulas in charts.values.`);
  }
  const formula = (range: string) => xml(`'${sheet.name.replace(/'/g, "''")}'!${range}`);
  const title = spec.title ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${xml(spec.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="${C}" xmlns:a="${A}"><c:chart>${title}<c:plotArea><c:layout/><c:barChart><c:barDir val="${spec.type === 'bar' ? 'bar' : 'col'}"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>${xml(spec.title || 'Amount')}</c:v></c:tx><c:cat><c:strRef><c:f>${formula(spec.categories)}</c:f><c:strCache>${cache(categories, false)}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>${formula(spec.values)}</c:f><c:numCache>${cache(values, true)}</c:numCache></c:numRef></c:val></c:ser><c:gapWidth val="120"/><c:axId val="101"/><c:axId val="102"/></c:barChart><c:catAx><c:axId val="101"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="102"/><c:crosses val="autoZero"/></c:catAx><c:valAx><c:axId val="102"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="#,##0.00" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="101"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`;
}

export async function addSpreadsheetCharts(zip: JSZip, workbook: any, definitions: SheetCharts[]): Promise<number> {
  let count = 0;
  let contentTypes = await zip.file('[Content_Types].xml')!.async('string');
  for (const definition of definitions) {
    if (!definition.charts?.length) continue;
    const sheet = workbook.getWorksheet(definition.sheet);
    if (!sheet) throw new Error(`Chart sheet does not exist: ${definition.sheet}`);
    if (definition.charts.length > 20) throw new Error('At most 20 charts per sheet are supported.');
    const drawing = `xl/drawings/lumiDrawing${sheet.id}.xml`;
    const sheetPath = `xl/worksheets/sheet${sheet.id}.xml`;
    let worksheet = await zip.file(sheetPath)!.async('string');
    if (/<drawing\b/.test(worksheet)) throw new Error('Adding charts to an existing drawing requires an explicit drawing merge.');
    const anchors: string[] = [];
    const rels: string[] = [];
    for (const [index, spec] of definition.charts.entries()) {
      const chart = `xl/charts/lumiChart${sheet.id}_${index + 1}.xml`;
      zip.file(chart, chartXml(sheet, spec));
      const anchor = sheet.getCell(spec.anchor || `F${2 + index * 18}`);
      const col = anchor.col - 1;
      const row = anchor.row - 1;
      const marker = (name: string, x: number, y: number) => `<xdr:${name}><xdr:col>${x}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${y}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:${name}>`;
      anchors.push(`<xdr:twoCellAnchor>${marker('from', col, row)}${marker('to', col + 8, row + 16)}<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${index + 1}" name="Chart ${index + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" xmlns:r="${REL}" r:id="rId${index + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`);
      rels.push(relation(`rId${index + 1}`, 'chart', `../charts/lumiChart${sheet.id}_${index + 1}.xml`));
      contentTypes = contentTypes.replace('</Types>', `${override(chart, 'drawingml.chart')}</Types>`);
      count++;
    }
    zip.file(drawing, `<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}">${anchors.join('')}</xdr:wsDr>`);
    zip.file(`xl/drawings/_rels/lumiDrawing${sheet.id}.xml.rels`, relationships(rels.join('')));
    const relPath = `xl/worksheets/_rels/sheet${sheet.id}.xml.rels`;
    const existingRels = await zip.file(relPath)?.async('string') || relationships('');
    zip.file(relPath, existingRels.replace('</Relationships>', `${relation('rIdLumiChart', 'drawing', `../drawings/lumiDrawing${sheet.id}.xml`)}</Relationships>`));
    worksheet = worksheet.replace('</worksheet>', `<drawing r:id="rIdLumiChart"/></worksheet>`);
    zip.file(sheetPath, worksheet);
    contentTypes = contentTypes.replace('</Types>', `${override(drawing, 'drawing')}</Types>`);
  }
  zip.file('[Content_Types].xml', contentTypes);
  return count;
}

/** ExcelJS drops charts on save. Keep the original drawing graph while applying
 * cell edits, and refresh caches so opening the saved copy shows current data. */
export async function preserveSpreadsheetCharts(original: JSZip, output: JSZip, workbook: any): Promise<number> {
  const chartPaths = Object.keys(original.files).filter(p => /^xl\/charts\/[^/]+\.xml$/.test(p));
  if (!chartPaths.length) return 0;
  for (const [name, part] of Object.entries(original.files)) {
    if (!part.dir && /^xl\/(?:charts|drawings|media)\//.test(name)) output.file(name, await part.async('nodebuffer'));
  }
  for (const name of Object.keys(original.files).filter(p => /^xl\/worksheets\/[^/]+\.xml$/.test(p))) {
    const drawing = (await original.file(name)!.async('string')).match(/<drawing\b[^>]*\br:id="([^"]+)"[^>]*\/>/);
    if (!drawing) continue;
    const current = output.file(name);
    if (!current) throw new Error('Cannot preserve chart: worksheet identity changed.');
    const relPath = name.replace('/worksheets/', '/worksheets/_rels/') + '.rels';
    const sourceRels = await original.file(relPath)?.async('string') || '';
    const sourceRelation = (sourceRels.match(/<Relationship\b[^>]*\/>/g) || []).find(r => r.includes(`Id="${drawing[1]}"`));
    if (!sourceRelation) throw new Error('Cannot preserve chart: drawing relationship is missing.');
    const currentRels = await output.file(relPath)?.async('string') || relationships('');
    const id = 'rIdLumiPreservedDrawing';
    output.file(relPath, currentRels.replace('</Relationships>', `${sourceRelation.replace(/\bId="[^"]+"/, `Id="${id}"`)}</Relationships>`));
    output.file(name, (await current.async('string')).replace(/<drawing\b[^>]*\/>/g, '').replace('</worksheet>', `<drawing r:id="${id}"/></worksheet>`));
  }
  let types = await output.file('[Content_Types].xml')!.async('string');
  for (const item of (await original.file('[Content_Types].xml')!.async('string')).match(/<(?:Override|Default)\b[^>]*\/>/g) || []) {
    const identity = item.match(/(?:PartName|Extension)="[^"]+"/)?.[0];
    if (identity && !types.includes(identity)) types = types.replace('</Types>', `${item}</Types>`);
  }
  output.file('[Content_Types].xml', types);
  for (const name of chartPaths) {
    let source = await original.file(name)!.async('string');
    source = source.replace(/<c:(numRef|strRef)\b[^>]*>[\s\S]*?<\/c:\1>/g, (reference, kind: string) => {
      const f = reference.match(/<c:f>([\s\S]*?)<\/c:f>/)?.[1];
      const formula = f && unxml(f);
      const match = formula && /^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(formula);
      if (!match) return reference.replace(/<c:(?:numCache|strCache)>[\s\S]*?<\/c:(?:numCache|strCache)>/g, '');
      const sheet = workbook.getWorksheet((match[1] || match[2]).replace(/''/g, "'"));
      try {
        const numeric = kind === 'numRef';
        const values = rangeCells(sheet, match[3]).map(c => numeric ? (c.formula ? c.result : c.value) : c.text);
        if (numeric && values.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error('Uncalculated chart values');
        const tag = numeric ? 'numCache' : 'strCache';
        return reference.replace(/<c:(?:numCache|strCache)>[\s\S]*?<\/c:(?:numCache|strCache)>/g, '').replace(`</c:${kind}>`, `<c:${tag}>${cache(values, numeric)}</c:${tag}></c:${kind}>`);
      } catch { return reference.replace(/<c:(?:numCache|strCache)>[\s\S]*?<\/c:(?:numCache|strCache)>/g, ''); }
    });
    output.file(name, source);
  }
  return chartPaths.length;
}
