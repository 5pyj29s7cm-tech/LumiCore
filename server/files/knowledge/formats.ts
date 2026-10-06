import path from "path";
import iconv from "iconv-lite";
import { AUDIO_FILE_EXTS } from "../../stt/file_transcription";

// ── Helpers ──

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// i18n-allow: These exact encoding-error tokens recognize and repair mojibake filenames.
export const MOJIBAKE_TOKENS = ['\u00c3', '\u00c2', '\ufffd', '\u00e6', '\u00e9', '\u00e8', '\u00e7', '\u00e5', '\u00e4', '\u951f', '\u93c2', '\u6d93', '\u7f01', '\u7015', '\u6fc2', '\u5a34', '\u6d7c', '\u5fe1', '\u9439', '\u9359'];

export function looksMojibake(value: string): boolean {
  return /[\u0080-\u009f]/.test(value)
    || /[\u00c0-\u00ff][\u0080-\u00bf]/.test(value)
    || MOJIBAKE_TOKENS.some(token => value.includes(token));
}

export function textScore(value: string): number {
  let score = 0;
  const replacement = (value.match(/\ufffd/g) || []).length;
  const mojibake = MOJIBAKE_TOKENS.reduce((sum, token) => sum + (value.includes(token) ? 1 : 0), 0);
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  const ascii = (value.match(/[A-Za-z0-9._ -]/g) || []).length;
  score += cjk * 2 + ascii * 0.15;
  score -= replacement * 8 + mojibake * 2;
  return score;
}

export function repairFilename(value: string): string {
  const original = String(value || '').normalize('NFC');
  if (!original || !looksMojibake(original)) return original;
  const candidates = new Set<string>([original]);
  try { candidates.add(Buffer.from(original, 'latin1').toString('utf8').normalize('NFC')); } catch {}
  try { candidates.add(iconv.decode(iconv.encode(original, 'gbk'), 'utf8').normalize('NFC')); } catch {}
  try { candidates.add(iconv.decode(iconv.encode(original, 'gb18030'), 'utf8').normalize('NFC')); } catch {}
  return [...candidates].sort((a, b) => textScore(b) - textScore(a))[0] || original;
}

export function sanitizeKnowledgeFilename(value: string, fallback = 'untitled'): string {
  const repaired = repairFilename(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim();
  const safe = repaired && repaired !== '.' && repaired !== '..' ? repaired : fallback;
  return path.basename(safe);
}

export const TEXT_KNOWLEDGE_EXTS = /\.(txt|md|json|csv|log|xml|yaml|yml|ts|tsx|js|jsx|py|html|css|env|toml|ini|cfg)$/i;

export const RTF_KNOWLEDGE_EXTS = /\.rtf$/i;

export const EXTRACTABLE_KNOWLEDGE_EXTS = /\.(docx|xlsx|xls|pptx|pdf)$/i;

export const IMAGE_KNOWLEDGE_EXTS = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

export const AUDIO_KNOWLEDGE_EXTS = AUDIO_FILE_EXTS;

export const GENERATED_FILE_EXTS = /\.(docx?|pptx?|xlsx?|pdf|txt|md|csv|tsv|json|png|jpe?g|webp|gif|bmp|svg|html|dxf|dwg|mp4|mov|m4v|webm|mp3|wav|m4a|ogg|flac|aac|rtf|log|xml|yaml|yml|css|js|ts|tsx|jsx|py)$/i;

export const OBSIDIAN_NOTE_EXTS = /\.(md|markdown)$/i;

export const OBSIDIAN_MAX_NOTE_BYTES = Math.max(256 * 1024, Number(process.env.OBSIDIAN_NOTE_MAX_BYTES || 5 * 1024 * 1024));

export const OBSIDIAN_DEFAULT_MAX_FILES = Math.max(50, Number(process.env.OBSIDIAN_SYNC_MAX_FILES || 500));

export const OBSIDIAN_HARD_MAX_FILES = Math.max(OBSIDIAN_DEFAULT_MAX_FILES, Number(process.env.OBSIDIAN_SYNC_HARD_MAX_FILES || 2000));

export const OBSIDIAN_SKIP_DIRS = new Set([
  '.obsidian',
  '.git',
  '.trash',
  '.recycle',
  'node_modules',
  '.DS_Store',
]);

export const DOWNLOAD_MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.rtf': 'application/rtf',
  '.log': 'text/plain',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.py': 'text/x-python',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.mp3': 'audio/mpeg',
  '.mpeg': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.wma': 'audio/x-ms-wma',
  '.webm': 'audio/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.bmp': 'image/bmp',
  '.tsv': 'text/tab-separated-values',
  '.dxf': 'application/dxf',
  '.dwg': 'application/octet-stream',
};

// Only passive formats are rendered under the application's origin.
export const SAFE_INLINE_EXTENSIONS = new Set([
  '.txt', '.log', '.md', '.json', '.csv',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf',
  '.mp3', '.mpeg', '.wav', '.m4a', '.ogg', '.oga', '.flac', '.aac', '.wma', '.webm', '.mp4', '.mov',
]);

export function getDownloadMime(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase() || (filePath.startsWith('.') ? filePath.toLowerCase() : '');
  return DOWNLOAD_MIME_TYPES[ext];
}
