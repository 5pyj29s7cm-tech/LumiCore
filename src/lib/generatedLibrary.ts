import type { FileEntry } from '@/components/MemoryTree/types';
import type { MediaGenerationArtifact } from './mediaGenerationArtifacts';

export function archivedMediaArtifacts(files: FileEntry[], scopedUrl: (url: string) => string): MediaGenerationArtifact[] {
  return files.flatMap(file => file.archiveId && (file.archiveKind === 'image' || file.archiveKind === 'video') ? [{
    id: file.archiveId, fileId: file.id, kind: file.archiveKind, path: file.path,
    fileName: file.displayName || file.name, createdAt: file.createdAt,
    url: scopedUrl(`/api/files/download/${encodeURIComponent(file.id)}?inline=1`),
  }] : []);
}
