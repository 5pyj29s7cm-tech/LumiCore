import { randomUUID } from 'crypto';
import { readDatabaseTables, commitDatabaseTables } from '../../db_layer';
import type { InteriorProjectWorkflowState } from './project_workflow';

export const INTERIOR_PROJECT_TYPES = [
  'residential',
  'office',
  'retail',
  'hospitality',
  'other',
] as const;

export const INTERIOR_PROJECT_STATUSES = [
  'brief',
  'planning',
  'design',
  'visualization',
  'handoff',
  'archived',
] as const;

export type InteriorProjectType = typeof INTERIOR_PROJECT_TYPES[number];
export type InteriorProjectStatus = typeof INTERIOR_PROJECT_STATUSES[number];

export interface InteriorProjectBrief {
  location: string;
  area: string;
  occupants: string;
  budget: string;
  style: string;
  requirements: string;
  constraints: string;
}

export interface InteriorProject {
  id: string;
  orgId: string;
  ownerUserId: string;
  name: string;
  projectType: InteriorProjectType;
  status: InteriorProjectStatus;
  brief: InteriorProjectBrief;
  /** Durable project-level execution chain shared by every design workspace. */
  workflow?: InteriorProjectWorkflowState;
  createdAt: string;
  updatedAt: string;
}

export interface CreateInteriorProjectInput {
  name: unknown;
  projectType?: unknown;
  brief?: unknown;
}

export interface UpdateInteriorProjectInput {
  name?: unknown;
  projectType?: unknown;
  status?: unknown;
  brief?: unknown;
}

export class InteriorProjectValidationError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'InteriorProjectValidationError';
  }
}

/**
 * Interior projects predate the unified personal/work domain model and persist
 * their scope in the `orgId` column. Keep that schema backwards compatible
 * while assigning every personal user a collision-free private scope.
 */
export function personalInteriorProjectScope(userId: string): string {
  const normalized = String(userId || '').trim();
  if (!normalized) throw new InteriorProjectValidationError('userId is required');
  return `personal:${normalized}`;
}

const EMPTY_BRIEF: InteriorProjectBrief = {
  location: '',
  area: '',
  occupants: '',
  budget: '',
  style: '',
  requirements: '',
  constraints: '',
};

const ACTIVE_PROJECT_SETTING_KEY = 'interior_active_projects_v1';

const BRIEF_LIMITS: Record<keyof InteriorProjectBrief, number> = {
  location: 240,
  area: 120,
  occupants: 240,
  budget: 240,
  style: 600,
  requirements: 6000,
  constraints: 6000,
};

function projectRows(db: any): InteriorProject[] {
  if (!Array.isArray(db.interiorProjects)) db.interiorProjects = [];
  return db.interiorProjects as InteriorProject[];
}

function cloneProject(project: InteriorProject): InteriorProject {
  return {
    ...project,
    brief: { ...project.brief },
    ...(project.workflow ? { workflow: structuredClone(project.workflow) } : {}),
  };
}

function activeProjectSelections(db: any): Record<string, string> {
  if (!Array.isArray(db.settings)) db.settings = [];
  const row = db.settings.find((item: any) => item.key === ACTIVE_PROJECT_SETTING_KEY);
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function activeProjectSelectionKey(orgId: string, userId: string): string {
  const normalizedScope = String(orgId || '').trim();
  const normalizedUser = String(userId || '').trim();
  if (!normalizedScope || !normalizedUser) {
    throw new InteriorProjectValidationError('orgId and userId are required for active project selection');
  }
  return `${normalizedScope}::${normalizedUser}`;
}

function textField(value: unknown, field: string, maxLength: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new InteriorProjectValidationError(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new InteriorProjectValidationError(`${field} must be a string`);
  }
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (required && !normalized) {
    throw new InteriorProjectValidationError(`${field} is required`);
  }
  if (normalized.length > maxLength) {
    throw new InteriorProjectValidationError(`${field} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

function enumField<T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T,
  fallback?: T[number],
): T[number] {
  if ((value === undefined || value === null || value === '') && fallback) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new InteriorProjectValidationError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T[number];
}

function briefInput(value: unknown, current: InteriorProjectBrief = EMPTY_BRIEF): InteriorProjectBrief {
  if (value === undefined) return { ...current };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InteriorProjectValidationError('brief must be an object');
  }
  const input = value as Record<string, unknown>;
  const next = { ...current };
  for (const field of Object.keys(BRIEF_LIMITS) as Array<keyof InteriorProjectBrief>) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      next[field] = textField(input[field], `brief.${field}`, BRIEF_LIMITS[field]);
    }
  }
  return next;
}

export function listInteriorProjects(
  orgId: string,
  options: { includeArchived?: boolean } = {},
): InteriorProject[] {
  const rows = projectRows(readDatabaseTables(['interiorProjects', 'settings']))
    .filter(project => project.orgId === orgId)
    .filter(project => options.includeArchived || project.status !== 'archived')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return rows.map(cloneProject);
}

export function getInteriorProject(orgId: string, projectId: string): InteriorProject | null {
  const project = projectRows(readDatabaseTables(['interiorProjects', 'settings'])).find(item => item.orgId === orgId && item.id === projectId);
  return project ? cloneProject(project) : null;
}

export function getActiveInteriorProject(orgId: string, userId: string): InteriorProject | null {
  const db = readDatabaseTables(['interiorProjects', 'settings']);
  const projectId = activeProjectSelections(db)[activeProjectSelectionKey(orgId, userId)];
  if (!projectId) return null;
  const project = projectRows(db).find(item => item.orgId === orgId && item.id === projectId && item.status !== 'archived');
  return project ? cloneProject(project) : null;
}

export function setActiveInteriorProject(
  orgId: string,
  userId: string,
  projectId: string | null,
): InteriorProject | null {
  const db = readDatabaseTables(['interiorProjects', 'settings']);
  const key = activeProjectSelectionKey(orgId, userId);
  const selections = activeProjectSelections(db);
  const normalizedProjectId = String(projectId || '').trim();
  let project: InteriorProject | null = null;
  if (normalizedProjectId) {
    project = projectRows(db).find(item => (
      item.orgId === orgId
      && item.id === normalizedProjectId
      && item.status !== 'archived'
    )) || null;
    if (!project) throw new InteriorProjectValidationError('Active interior project was not found in this scope');
    selections[key] = project.id;
  } else {
    delete selections[key];
  }
  const row = db.settings.find((item: any) => item.key === ACTIVE_PROJECT_SETTING_KEY);
  const value = JSON.stringify(selections);
  if (row) row.value = value;
  else db.settings.push({ key: ACTIVE_PROJECT_SETTING_KEY, value });
  commitDatabaseTables(db);
  return project ? cloneProject(project) : null;
}

export function createInteriorProject(
  orgId: string,
  ownerUserId: string,
  input: CreateInteriorProjectInput,
): InteriorProject {
  const db = readDatabaseTables(['interiorProjects', 'settings']);
  const timestamp = new Date().toISOString();
  const project: InteriorProject = {
    id: randomUUID(),
    orgId,
    ownerUserId,
    name: textField(input?.name, 'name', 120, true),
    projectType: enumField(input?.projectType, 'projectType', INTERIOR_PROJECT_TYPES, 'other'),
    status: 'brief',
    brief: briefInput(input?.brief),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  projectRows(db).push(project);
  commitDatabaseTables(db);
  return cloneProject(project);
}

export function updateInteriorProject(
  orgId: string,
  projectId: string,
  input: UpdateInteriorProjectInput,
): InteriorProject | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InteriorProjectValidationError('request body must be an object');
  }
  const db = readDatabaseTables(['interiorProjects', 'settings']);
  const project = projectRows(db).find(item => item.orgId === orgId && item.id === projectId);
  if (!project) return null;

  if (Object.prototype.hasOwnProperty.call(input, 'name')) {
    project.name = textField(input.name, 'name', 120, true);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'projectType')) {
    project.projectType = enumField(input.projectType, 'projectType', INTERIOR_PROJECT_TYPES);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'status')) {
    project.status = enumField(input.status, 'status', INTERIOR_PROJECT_STATUSES);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'brief')) {
    project.brief = briefInput(input.brief, project.brief);
  }
  project.updatedAt = new Date().toISOString();
  commitDatabaseTables(db);
  return cloneProject(project);
}
