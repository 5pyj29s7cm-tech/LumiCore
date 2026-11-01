import { detectLanguage } from '../../utils/language';

export type StatuteSourceLanguage = 'zh' | 'en';

/** Use the current user's language context, never a returned legal title or source body. */
export function statuteSourceLanguage(userText?: string): StatuteSourceLanguage {
  return userText?.trim() && detectLanguage(userText) === 'en' ? 'en' : 'zh';
}

const zh = {
  statuses: { 1: '已废止', 2: '已修改', 3: '现行有效', 4: '尚未生效' } as Record<number, string>,
  unknown: '未知', unavailable: '未返回',
  source: '来源名称：', record: '官方记录：', query: '原始检索词：', published: '公布日期：', effective: '施行日期：',
  effectiveness: '效力代码：', authority: '制定机关：', category: '类别：', articleMax: '官方目录最后条号：',
  originalPath: '原件路径：', url: '来源链接：', endpoint: '查询端点：', queriedAt: '查询时间：', originalReadAt: '原件读取时间：',
  separator: '；',
  cachedScope: '读取范围：复用同一新鲜缓存中身份和哈希匹配的原件文字，重新解析后仅返回明确请求的条文；未发起新的联网查询。',
  requested: '请求条文（来源原文摘录；未定位条文明确标注）：',
  missingProvision: '：本次未定位，未取得该条正文。',
  uncountedScope: '正文提取范围：已读取同一官方记录的原件文字；官方目录未提供条数，未作外部条数或完整性核验。',
  selectedOnly: '本次仅返回明确请求的条文。',
  checkedOriginal: (count: number) => `原件内部核对：共 ${count} 条，条号与官方目录一致。`,
  fullOriginal: (count: number) => `正文提取范围：已提取并核对全部 ${count} 条正文；条号与官方目录一致。`,
  incomplete: '读取范围：已取得来源元数据，正文提取未完成：',
};
const en: typeof zh = {
  statuses: { 1: 'Repealed', 2: 'Amended', 3: 'In force', 4: 'Not yet effective' },
  unknown: 'Unknown', unavailable: 'Not returned',
  source: 'Source title: ', record: 'Official record: ', query: 'Original query: ', published: 'Publication date: ', effective: 'Effective date: ',
  effectiveness: 'Effectiveness code: ', authority: 'Issuing authority: ', category: 'Category: ', articleMax: 'Last article number in official outline: ',
  originalPath: 'Original document path: ', url: 'Source URL: ', endpoint: 'Query endpoint: ', queriedAt: 'Queried at: ', originalReadAt: 'Original read at: ',
  separator: '; ',
  cachedScope: 'Read scope: reused the identity- and hash-matched original in the same fresh cache, reparsed it and returned only explicitly requested provisions; no new online query was made.',
  requested: 'Requested provisions (verbatim source excerpts; missing provisions are explicitly marked):',
  missingProvision: ': Not located in this read; the provision text was not obtained.',
  uncountedScope: 'Text extraction scope: the original text of the same official record was read; the official outline supplied no article count, so no external count or completeness verification was performed.',
  selectedOnly: 'Only explicitly requested provisions are returned.',
  checkedOriginal: (count: number) => `Original consistency check: ${count} provisions; article numbers match the official outline.`,
  fullOriginal: (count: number) => `Text extraction scope: all ${count} provisions were extracted and checked; article numbers match the official outline.`,
  incomplete: 'Read scope: source metadata was obtained, but body extraction did not finish: ',
};

export function statuteSourceMessages(language: StatuteSourceLanguage = 'zh') {
  return language === 'en' ? en : zh;
}

export function statuteEffectivenessLabel(code: number | null | undefined, language: StatuteSourceLanguage = 'zh'): string {
  const copy = statuteSourceMessages(language);
  return copy.statuses[Number(code)] || copy.unknown;
}
