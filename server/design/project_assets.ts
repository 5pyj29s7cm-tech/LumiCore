import { randomUUID } from 'crypto';
import { readDatabaseTables, commitDatabaseTables } from '../../db_layer';
import { getInteriorProject } from './projects';

export const INTERIOR_ASSET_CATEGORIES = [
  'floor-plan',
  'cad',
  'site-photo',
  'material',
  'reference',
  'other',
] as const;

export type InteriorAssetCategory = typeof INTERIOR_ASSET_CATEGORIES[number];
export type InteriorProjectAssetStatus = 'active' | 'removed';

export interface InteriorProjectAsset {
  id: string;
  orgId: string;
  projectId: string;
  fileId: string;
  displayName: string;
  mimeType: string;
  rawSize: number;
  category: InteriorAssetCategory;
  uploadedBy: string;
  status: InteriorProjectAssetStatus;
  extractionStatus: string;
  orgArticleId: string;
  createdAt: string;
  updatedAt: string;
}

export class InteriorProjectAssetValidationError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'InteriorProjectAssetValidationError';
  }
}

function assetRows(db: any): InteriorProjectAsset[] {
  if (!Array.isArray(db.interiorProjectAssets)) db.interiorProjectAssets = [];
  return db.interiorProjectAssets as InteriorProjectAsset[];
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InteriorProjectAssetValidationError(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new InteriorProjectAssetValidationError(`${field} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

export function normalizeInteriorAssetCategory(value: unknown): InteriorAssetCategory {
  const normalized = String(value || 'other').trim();
  if (!INTERIOR_ASSET_CATEGORIES.includes(normalized as InteriorAssetCategory)) {
    throw new InteriorProjectAssetValidationError(
      `category must be one of: ${INTERIOR_ASSET_CATEGORIES.join(', ')}`,
    );
  }
  return normalized as InteriorAssetCategory;
}

function cloneAsset(asset: InteriorProjectAsset): InteriorProjectAsset {
  return { ...asset };
}

export function listInteriorProjectAssets(orgId: string, projectId: string): InteriorProjectAsset[] {
  if (!getInteriorProject(orgId, projectId)) return [];
  return assetRows(readDatabaseTables(['interiorProjectAssets']))
    .filter(asset => asset.orgId === orgId && asset.projectId === projectId && asset.status === 'active')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(cloneAsset);
}

export function createInteriorProjectAsset(input: {
  orgId: string;
  projectId: string;
  fileId: unknown;
  displayName: unknown;
  mimeType?: unknown;
  rawSize?: unknown;
  category?: unknown;
  uploadedBy: string;
  extractionStatus?: unknown;
  orgArticleId?: unknown;
}): InteriorProjectAsset {
  if (!getInteriorProject(input.orgId, input.projectId)) {
    const error: any = new Error('Interior project not found');
    error.statusCode = 404;
    throw error;
  }
  const db = readDatabaseTables(['interiorProjectAssets']);
  const fileId = requiredText(input.fileId, 'fileId', 512);
  const existing = assetRows(db).find(asset => (
    asset.orgId === input.orgId
    && asset.projectId === input.projectId
    && asset.fileId === fileId
    && asset.status === 'active'
  ));
  const timestamp = new Date().toISOString();
  if (existing) {
    existing.category = normalizeInteriorAssetCategory(input.category);
    existing.updatedAt = timestamp;
    commitDatabaseTables(db);
    return cloneAsset(existing);
  }

  const size = Number(input.rawSize || 0);
  const asset: InteriorProjectAsset = {
    id: randomUUID(),
    orgId: input.orgId,
    projectId: input.projectId,
    fileId,
    displayName: requiredText(input.displayName, 'displayName', 512),
    mimeType: String(input.mimeType || '').trim().slice(0, 160),
    rawSize: Number.isFinite(size) && size >= 0 ? size : 0,
    category: normalizeInteriorAssetCategory(input.category),
    uploadedBy: input.uploadedBy,
    status: 'active',
    extractionStatus: String(input.extractionStatus || '').trim().slice(0, 80),
    orgArticleId: String(input.orgArticleId || '').trim().slice(0, 160),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  assetRows(db).push(asset);
  commitDatabaseTables(db);
  return cloneAsset(asset);
}

export function updateInteriorProjectAsset(
  orgId: string,
  projectId: string,
  assetId: string,
  input: { category?: unknown },
): InteriorProjectAsset | null {
  const db = readDatabaseTables(['interiorProjectAssets']);
  const asset = assetRows(db).find(item => (
    item.id === assetId
    && item.orgId === orgId
    && item.projectId === projectId
    && item.status === 'active'
  ));
  if (!asset) return null;
  if (Object.prototype.hasOwnProperty.call(input || {}, 'category')) {
    asset.category = normalizeInteriorAssetCategory(input.category);
  }
  asset.updatedAt = new Date().toISOString();
  commitDatabaseTables(db);
  return cloneAsset(asset);
}

export function removeInteriorProjectAsset(
  orgId: string,
  projectId: string,
  assetId: string,
): InteriorProjectAsset | null {
  const db = readDatabaseTables(['interiorProjectAssets']);
  const asset = assetRows(db).find(item => (
    item.id === assetId
    && item.orgId === orgId
    && item.projectId === projectId
    && item.status === 'active'
  ));
  if (!asset) return null;
  asset.status = 'removed';
  asset.updatedAt = new Date().toISOString();
  commitDatabaseTables(db);
  return cloneAsset(asset);
}
