export function legalToolEntryId(toolName: string): string {
  if (/bid/i.test(toolName)) return 'bid';
  if (/contract/i.test(toolName)) return 'contract-review';
  if (/(?:asset|equity|company)/i.test(toolName)) return 'asset-trace';
  if (/(?:citation|verify|final)/i.test(toolName)) return 'verify';
  if (/(?:statute|search_case|case_search|research|external_search)/i.test(toolName)) return 'research';
  if (/(?:packet|strategy|opinion|document|draft)/i.test(toolName)) return 'packet';
  return 'workspace';
}

export function legalToolCaseIdentity(args: Record<string, any>): string {
  const id = String(args.caseId || '').trim();
  if (id) return `id:${id}`;
  const name = String(args.caseName || args.title || '').trim();
  return name ? `name:${name.toLocaleLowerCase()}` : 'standalone';
}
