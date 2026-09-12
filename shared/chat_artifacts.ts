export type ChatArtifact = {
  id: string;
  fileName: string;
  path: string;
  url: string;
  kind: 'image' | 'video' | 'audio' | 'document' | 'deck' | 'sheet' | 'pdf' | 'cad' | 'file';
};

export function chatArtifactKind(fileName: string): ChatArtifact['kind'] {
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (/^(png|jpe?g|webp|gif|svg|bmp)$/.test(extension || '')) return 'image';
  if (/^(mp4|mov|m4v|webm)$/.test(extension || '')) return 'video';
  if (/^(mp3|wav|m4a|ogg|flac|aac)$/.test(extension || '')) return 'audio';
  if (/^pptx?$/.test(extension || '')) return 'deck';
  if (/^(xlsx?|csv|tsv)$/.test(extension || '')) return 'sheet';
  if (extension === 'pdf') return 'pdf';
  if (/^(dxf|dwg)$/.test(extension || '')) return 'cad';
  if (/^(docx?|txt|md|json|html|rtf|log|xml|yaml|yml|css|js|ts|tsx|jsx|py)$/.test(extension || '')) return 'document';
  return 'file';
}

export function makeChatArtifact(filePath: string, conversationId?: string): ChatArtifact {
  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  const params = new URLSearchParams({ path: filePath, inline: '1' });
  if (conversationId) params.set('conversationId', conversationId);
  return { id: `generated-${filePath}`, fileName, path: filePath,
    url: `/api/files/generated?${params}`, kind: chatArtifactKind(fileName) };
}

export type ChatDocumentPreview = {
  kind: 'text' | 'table' | 'unsupported';
  text?: string;
  sections?: Array<{ name: string; rows: string[][] }>;
  truncated?: boolean;
  extracted?: boolean;
};
