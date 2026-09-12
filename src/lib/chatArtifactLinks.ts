import { chatArtifactKind, makeChatArtifact, type ChatArtifact } from '../../shared/chat_artifacts';
import { localFileResourcePath } from '@/services/fileResource';

/** Convert local artifact references only; external URLs keep the normal link path. */
export function chatArtifactFromLink(value: string | undefined, conversationId?: string, encoded = false): ChatArtifact | null {
  if (!value) return null;
  let target = value.trim();
  const resource = localFileResourcePath(target);
  if (resource) {
    const url = new URL(resource, 'http://local.invalid');
    let filePath: string;
    try { filePath = url.searchParams.get('path') || decodeURIComponent(url.pathname.split('/').pop() || ''); }
    catch { return null; }
    if (conversationId && url.pathname === '/api/files/generated' && !url.searchParams.has('conversationId')) url.searchParams.set('conversationId', conversationId);
    const fileName = filePath.split(/[\\/]/).pop() || 'file';
    return { id: `resource-${resource}`, path: url.searchParams.get('path') || '', fileName, url: `${url.pathname}${url.search}`, kind: chatArtifactKind(fileName) };
  }
  if (/^file:\/\//i.test(target)) {
    try { const url = new URL(target); if (url.hostname) return null; target = decodeURIComponent(url.pathname).replace(/^\/(?=[a-z]:[\\/])/i, ''); }
    catch { return null; }
  } else if (encoded) {
    try { target = decodeURIComponent(target); } catch { return null; }
  }
  if ((!/^[a-z]:[\\/]/i.test(target) && !/^\/(?!\/)/.test(target)) || /[\r\n\0]/.test(target)) return null;
  if (chatArtifactKind(target) === 'file') return null;
  return makeChatArtifact(target, conversationId);
}

/** Legacy replies keep links without making prose an authorization receipt. */
export function legacyChatArtifacts(text: string, conversationId?: string): ChatArtifact[] {
  const extensions = 'docx?|pptx?|xlsx?|pdf|txt|md|csv|tsv|json|png|jpe?g|webp|gif|bmp|svg|html|dxf|dwg|mp4|mov|m4v|webm|mp3|wav|m4a|ogg|flac|aac|rtf|log|xml|yaml|yml';
  const pattern = new RegExp(`(?:[a-z]:[\\\\/]|/lumi_output/)[^\\r\\n\x60\"<>|*?]+?\\.(?:${extensions})(?![a-z0-9])`, 'gi');
  return [...new Set(text.match(pattern) || [])].map(target => makeChatArtifact(target.trim(), conversationId));
}
