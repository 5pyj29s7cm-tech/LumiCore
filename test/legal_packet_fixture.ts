/** Explicit offline model fixture for registered packet source-bound analysis; never a production fallback. */
export function packetDraftFixture(prompt: string, document: any): any {
  if (!document || typeof document.markdown !== 'string') return document;
  const target = JSON.parse(prompt.split('## 当前文书\n')[1]);
  const rows = JSON.parse(prompt.split('材料原句与固定编目（待核验，不是已证事实）：\n')[1].split('\n')[0]);
  const catalog = /^(16_|27_)/.test(document.baseName);
  return { baseName: document.baseName, complete: true, entries: (catalog ? rows : target.sections).map((section: any) => ({
    sectionId: catalog ? section.sectionId : section.id,
    sourceIds: (catalog ? section.sources : rows.flatMap((row: any) => row.sources)).map((source: any) => source.id),
    response: document.markdown, missing: '' })) };
}
