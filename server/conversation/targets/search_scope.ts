import path from "node:path";
import os from "node:os";
import { unique, normalizedIdentity, compact } from './values';
import { pathMentionedByUser, fileName, explicitAbsolutePaths, directoryWithin } from './paths';
import { RUNTIME_BASENAME_RE, RUNTIME_SEGMENT_RE, STANDARD_ROOT_ALIAS_RE } from './recognition';
import { explicitDirectory } from './instruction_targets';

function runtimeRoots(): string[] {
  return unique([
    process.cwd(),
    path.dirname(process.execPath || ''),
  ], 4).filter(root => normalizedIdentity(root) !== normalizedIdentity(path.parse(root).root));
}

/** Runtime/project artifacts are never inferred as user material. An exact user path remains valid. */
export function isUnconfirmedRuntimeCandidate(candidate: string, taskText: string): boolean {
  const clean = compact(candidate, 500);
  if (!clean || pathMentionedByUser(clean, taskText)) return false;
  if (RUNTIME_BASENAME_RE.test(fileName(clean)) || RUNTIME_SEGMENT_RE.test(clean)) return true;
  const normalized = normalizedIdentity(clean);
  return runtimeRoots().some(root => {
    const runtime = normalizedIdentity(root).replace(/\/$/, '');
    return Boolean(runtime && (normalized === runtime || normalized.startsWith(`${runtime}/`)));
  });
}

export function allowedTaskSearchRoots(taskText: string, sourcePaths: string[] = []): string[] {
  const explicit = explicitAbsolutePaths(taskText).map(explicitDirectory).filter(Boolean);
  const safeSourceRoots = sourcePaths
    .filter(value => !isUnconfirmedRuntimeCandidate(value, taskText))
    .filter(value => pathMentionedByUser(value, taskText))
    .map(explicitDirectory)
    .filter(Boolean);
  return unique(['~/Desktop', '~/Documents', '~/Downloads', ...explicit, ...safeSourceRoots], 12);
}

function userProfileRoots(): string[] {
  const envHome = compact(process.env.USERPROFILE, 500);
  const driveHome = compact(`${process.env.HOMEDRIVE || ''}${process.env.HOMEPATH || ''}`, 500);
  const homes = unique([os.homedir(), envHome, driveHome], 4);
  return unique(homes.flatMap(home => [
    path.resolve(home, 'Desktop'),
    path.resolve(home, 'Documents'),
    path.resolve(home, 'Downloads'),
  ]), 12);
}

export function isStandardUserDirectory(candidate: string): boolean {
  const clean = compact(candidate, 500);
  if (!clean) return false;
  const standardRoots = [
    ...(STANDARD_ROOT_ALIAS_RE.test(clean) ? ['~/Desktop', '~/Documents', '~/Downloads'] : []),
    ...userProfileRoots(),
  ];
  return standardRoots.some(root => directoryWithin(clean, root));
}

export function isAllowedTaskSearchDirectory(
  directory: string,
  taskText: string,
  sourcePaths: string[] = [],
): boolean {
  const clean = compact(directory, 500);
  if (!clean || isUnconfirmedRuntimeCandidate(clean, taskText)) return false;
  if (isStandardUserDirectory(clean)) return true;
  return allowedTaskSearchRoots(taskText, sourcePaths).some(root => directoryWithin(clean, root));
}
