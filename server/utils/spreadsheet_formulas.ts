/** Generated formulas are data, never JavaScript. Unsupported formulas remain
 * formulas for the office application to calculate; stale caches are removed. */
export function generatedCellValue(value: any): any {
  if (typeof value === 'string' && value.startsWith('=')) return { formula: value.slice(1) };
  if (value && typeof value === 'object' && typeof value.formula === 'string') {
    return { ...value, formula: value.formula.replace(/^=/, '') };
  }
  return value;
}

export function rangeCells(sheet: any, range: string): any[] {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d*)(?::\$?([A-Z]{1,3})\$?([1-9]\d*))?$/i.exec(range);
  if (!match) throw new Error(`Unsupported cell range: ${range}`);
  const start = sheet.getCell(`${match[1]}${match[2]}`);
  const end = sheet.getCell(`${match[3] || match[1]}${match[4] || match[2]}`);
  if (end.row < start.row || end.col < start.col || (end.row - start.row + 1) * (end.col - start.col + 1) > 10000) {
    throw new Error('Spreadsheet range must contain at most 10000 cells in ascending order.');
  }
  const cells: any[] = [];
  for (let row = start.row; row <= end.row; row++) {
    for (let col = start.col; col <= end.col; col++) cells.push(sheet.getCell(row, col));
  }
  return cells;
}

export function recalculateSpreadsheet(workbook: any): { formulaCount: number; unresolvedFormulas: string[] } {
  const active = new Set<string>();
  const results = new Map<string, number>();
  const unresolvedFormulas: string[] = [];
  let formulaCount = 0;
  let operations = 0;
  const calculate = (sheet: any, cell: any): number => {
    if (++operations > 200000) throw new Error('Formula calculation budget exceeded');
    if (!cell.formula) {
      if (cell.value == null || cell.value === '') return 0;
      if (typeof cell.value !== 'number') throw new Error('Non-numeric formula input');
      return cell.value;
    }
    const identity = `${sheet.id}:${cell.address}`;
    if (results.has(identity)) return results.get(identity)!;
    if (active.has(identity) || active.size > 100) throw new Error('Circular or deeply nested formula');
    active.add(identity);
    try {
      const source = String(cell.formula).replace(/^=/, '');
      if (source.length > 8000) throw new Error('Formula too long');
      const tokens = source.match(/(?:'(?:[^']|'')+'|[\p{L}_][\p{L}\p{N}_ .]*)!\$?[A-Z]{1,3}\$?[1-9]\d*(?::\$?[A-Z]{1,3}\$?[1-9]\d*)?|\$?[A-Z]{1,3}\$?[1-9]\d*(?::\$?[A-Z]{1,3}\$?[1-9]\d*)?|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[A-Z_][A-Z_0-9]*|[+\-*/^%(),]/giu) || [];
      if (tokens.join('').replace(/\s/g, '') !== source.replace(/\s/g, '')) throw new Error('Unsupported formula syntax');
      let position = 0;
      let depth = 0;
      const number = (value: number | number[]) => {
        if (Array.isArray(value)) throw new Error('Range requires an aggregate function');
        return value;
      };
      const primary = (): number | number[] => {
        if (++depth > 100) throw new Error('Formula nesting limit');
        try {
          const token = tokens[position++];
          if (!token) throw new Error('Missing formula operand');
          if (token === '+' || token === '-') return (token === '-' ? -1 : 1) * number(primary());
          if (token === '(') {
            const value = expression(0);
            if (tokens[position++] !== ')') throw new Error('Missing closing parenthesis');
            return value;
          }
          if (/^(?:\d|\.)/.test(token)) return Number(token);
          if (tokens[position] === '(') {
            position++;
            const args: number[] = [];
            if (tokens[position] !== ')') {
              do {
                args.push(...[expression(0)].flat());
                if (tokens[position] !== ',') break;
                position++;
              } while (position < tokens.length);
            }
            if (tokens[position++] !== ')') throw new Error('Unclosed function');
            const sum = args.reduce((a, b) => a + b, 0);
            switch (token.toUpperCase()) {
              case 'SUM': return sum;
              case 'AVERAGE': return sum / args.length;
              case 'MIN': return Math.min(...args);
              case 'MAX': return Math.max(...args);
              case 'ROUND': {
                if (args.length !== 2 || Math.abs(args[1]) > 100) throw new Error('Invalid ROUND arguments');
                const scale = 10 ** args[1];
                return Math.sign(args[0]) * Math.round(Math.abs(args[0]) * scale + Number.EPSILON) / scale;
              }
              default: throw new Error('Formula requires office calculation');
            }
          }
          const separator = token.lastIndexOf('!');
          const targetSheet = separator >= 0
            ? workbook.getWorksheet(token.slice(0, separator).replace(/^'|'$/g, '').replace(/''/g, "'")) : sheet;
          if (!targetSheet) throw new Error('Unknown formula worksheet');
          const reference = separator >= 0 ? token.slice(separator + 1) : token;
          const values = rangeCells(targetSheet, reference).map(ref => calculate(targetSheet, ref));
          return reference.includes(':') ? values : values[0];
        } finally { depth--; }
      };
      const priorities: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 };
      const expression = (minimum: number): number | number[] => {
        let left = primary();
        while (tokens[position] === '%') { position++; left = number(left) / 100; }
        while ((priorities[tokens[position]] || 0) > minimum) {
          const operator = tokens[position++];
          const a = number(left);
          const b = number(expression(priorities[operator]));
          left = operator === '+' ? a + b : operator === '-' ? a - b
            : operator === '*' ? a * b : operator === '/' ? a / b : a ** b;
        }
        return left;
      };
      const result = number(expression(0));
      if (position !== tokens.length || !Number.isFinite(result)) throw new Error('Invalid formula result');
      results.set(identity, result);
      return result;
    } finally { active.delete(identity); }
  };
  workbook.eachSheet((sheet: any) => sheet.eachRow((row: any) => row.eachCell((cell: any) => {
    if (!cell.formula) return;
    formulaCount++;
    const formula = cell.formula;
    try { cell.value = { formula, result: calculate(sheet, cell) }; }
    catch { cell.value = { formula }; unresolvedFormulas.push(`${sheet.name}!${cell.address}`); }
  })));
  workbook.calcProperties = { ...workbook.calcProperties, fullCalcOnLoad: true };
  return { formulaCount, unresolvedFormulas };
}
