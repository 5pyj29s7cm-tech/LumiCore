import type { KnowledgeIngestionManifest } from "../../knowledge/ingestion_manifest";
import type { GeneratedArchiveScope } from "../generated_archive";
import type { VisionProvider } from "../../llm/vision_preferences";
import type { MarkdownKnowledgeMetadata } from "../../knowledge/markdown";

export type KnowledgeStatus = 'ready' | 'indexing' | 'indexed' | 'partial' | 'unsupported' | 'failed';

export type ExtractionMethod = 'text' | 'markdown' | 'rtf' | 'docx' | 'spreadsheet' | 'presentation' | 'pdf' | 'image-vision' | 'image-metadata' | 'audio-transcript' | 'unsupported';

export interface KnowledgeExtractionResult {
  content: string | null;
  method: ExtractionMethod;
  status: Extract<KnowledgeStatus, 'indexed' | 'partial' | 'unsupported' | 'failed'>;
  warning?: string;
  error?: string;
  failureKind?: KnowledgeIngestionManifest['extraction']['failureKind'];
  provider?: VisionProvider | string;
  model?: string;
  sourceMetadata?: MarkdownKnowledgeMetadata;
}

export interface KnowledgeEntry {
  archiveId?: string;
  archiveKind?: string;
  sourceConversationId?: string;
  id: string;
  name: string;
  displayName: string;
  path?: string;
  domain: 'personal' | 'work';
  orgId?: string;
  size: string;
  rawSize: number;
  type: 'file';
  source: KnowledgeFileSource;
  agentIds: string[];
  status: KnowledgeStatus;
  extractionStatus?: KnowledgeExtractionResult['status'];
  extractionMethod?: ExtractionMethod;
  extractionWarning?: string;
  extractionError?: string;
  extractionFailureKind?: KnowledgeExtractionResult['failureKind'];
  extractionProvider?: string;
  extractionModel?: string;
  contentChars?: number;
  ingestionStatus?: KnowledgeIngestionManifest['status'];
  ingestionManifestId?: string;
  ingestionCoverage?: KnowledgeIngestionManifest['coverage'];
  sourceTitle?: string;
  sourceAliases?: string[];
  sourceTags?: string[];
  sourceLinks?: string[];
  sourceBacklinks?: string[];
  sourceProperties?: Record<string, unknown>;
  obsidianVaultId?: string;
  obsidianVaultName?: string;
  obsidianVaultPath?: string;
  obsidianRelativePath?: string;
  obsidianSourcePath?: string;
  updatedAt: string;
  createdAt: string;
}

export type KnowledgeFileSource = 'upload' | 'generated' | 'ingested' | 'obsidian';

export interface ObsidianVaultConfig {
  id: string;
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
  name: string;
  path: string;
  enabled: boolean;
  isObsidianVault: boolean;
  createdAt: string;
  updatedAt: string;
  lastSyncAt?: string;
  lastScanAt?: string;
  lastNoteCount?: number;
  lastSyncResult?: {
    synced: number;
    skipped: number;
    failed: number;
    noteCount: number;
  };
}

export interface ObsidianNoteFile {
  absolutePath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
}

export interface FileScope extends GeneratedArchiveScope {
  dir: string;
  legacyPersonalOwner?: boolean;
}

export interface KnowledgeFileInput {
  signal?: AbortSignal;
  sourcePath: string;
  originalName: string;
  size?: number;
  mimeType?: string;
  move?: boolean;
  assertAuthorized?: () => void;
}
