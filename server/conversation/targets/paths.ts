import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { CanonicalPathValue } from './contracts';
import { compact, primaryTaskText, unique, normalizedIdentity } from './values';
import { FILE_EXTENSIONS, POSIX_QUOTED_PATH_RE, POSIX_ABSOLUTE_PATH_RE } from './recognition';

function canonicalPathValue(value: unknown): CanonicalPathValue | null {
  let clean = compact(value, 500)
    .replace(/^['"“”‘’]+|['"“”‘’]+$/gu, '');
  if (!clean) return null;
  if (/^~[\\/]/u.test(clean)) {
    clean = path.join(os.homedir(), clean.slice(2));
  }
  const windowsPath = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(clean);
  const posixPath = clean.startsWith('/');
  // Backslashes are valid Windows separators but ambiguous POSIX filename
  // characters. Reject mixed POSIX paths instead of normalizing an attacker-
  // controlled traversal into a trusted search root.
  if (posixPath && clean.includes('\\')) return null;
  clean = windowsPath ? clean.replace(/\//g, '\\') : clean;
  const flavor = windowsPath ? path.win32 : path.posix;
  let normalized = flavor.normalize(clean);
  const absolute = flavor.isAbsolute(normalized);

  // Resolve an existing ancestor so a junction/symlink below an allowed root
  // cannot escape it. Preserve a non-existing suffix for planned output paths.
  const suffix: string[] = [];
  let probe = normalized;
  const nativePathFlavor = windowsPath === (process.platform === 'win32');
  try {
    // Never ask the local filesystem to resolve a foreign-host path. Lexical
    // normalization remains fail-closed; native paths additionally resolve
    // existing ancestors to prevent junction/symlink escapes.
    if (absolute && nativePathFlavor) {
      while (!fs.existsSync(probe)) {
        const parent = flavor.dirname(probe);
        if (!parent || parent === probe) break;
        suffix.unshift(flavor.basename(probe));
        probe = parent;
      }
      if (fs.existsSync(probe)) {
        const realAncestor = fs.realpathSync.native(probe);
        normalized = flavor.resolve(realAncestor, ...suffix);
      }
    }
  } catch {
    // A native path that started resolving but cannot be inspected is not safe
    // to compare lexically: an inaccessible junction/symlink could otherwise
    // escape an allowed root. Foreign-host paths never enter this branch.
    return null;
  }
  const comparisonPath = windowsPath ? normalized.toLocaleLowerCase() : normalized;
  return {
    flavor: windowsPath ? 'win32' : 'posix',
    normalized: comparisonPath,
    identity: comparisonPath.replace(/[\\/]+/g, '/'),
    absolute,
  };
}

export function canonicalPathIdentity(value: unknown): string {
  return canonicalPathValue(value)?.identity || '';
}

function explicitPathFlavor(value: unknown): CanonicalPathValue['flavor'] | null {
  const clean = compact(value, 500).replace(/^['"“”‘’]+|['"“”‘’]+$/gu, '');
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(clean)) return 'win32';
  if (/^~[\\/]/u.test(clean)) return process.platform === 'win32' ? 'win32' : 'posix';
  if (clean.startsWith('/') && !clean.includes('\\')) return 'posix';
  return null;
}

export function fileNamesMatchByPathFlavor(left: unknown, right: unknown): boolean {
  const leftName = fileName(left);
  const rightName = fileName(right);
  if (!leftName || !rightName) return false;
  const leftFlavor = explicitPathFlavor(left);
  const rightFlavor = explicitPathFlavor(right);
  if (leftFlavor && rightFlavor && leftFlavor !== rightFlavor) return false;
  const flavor = leftFlavor || rightFlavor || (process.platform === 'win32' ? 'win32' : 'posix');
  return flavor === 'win32'
    ? leftName.toLowerCase() === rightName.toLowerCase()
    : leftName === rightName;
}

export function targetReferenceMatches(candidate: unknown, expected: unknown): boolean {
  const expectedFlavor = explicitPathFlavor(expected);
  const expectedPath = canonicalPathValue(expected);
  if (expectedFlavor) {
    if (!expectedPath?.absolute || expectedPath.flavor !== expectedFlavor) return false;
    const candidatePath = canonicalPathValue(candidate);
    return Boolean(
      candidatePath?.absolute
      && candidatePath.flavor === expectedPath.flavor
      && candidatePath.identity === expectedPath.identity,
    );
  }
  return fileNamesMatchByPathFlavor(candidate, expected);
}

export function fileName(value: unknown): string {
  const clean = compact(value, 500).replace(/[。！？.!?]+$/u, '');
  if (!clean) return '';
  const segments = clean.split(/[\\/]/).filter(Boolean);
  return compact(segments.at(-1) || clean, 220);
}

export function displayableFileName(value: unknown): string {
  const clean = fileName(value);
  return new RegExp(`\\.${FILE_EXTENSIONS}$`, 'iu').test(clean) ? clean : '';
}

export function concreteTargetPath(value: unknown): boolean {
  const clean = compact(value, 500);
  if (clean.startsWith('/') && clean.includes('\\')) return false;
  return /^(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/[A-Za-z0-9_.-])/u.test(clean);
}

/** Keep a named search directory separate from the file to discover inside it. */
export function directorySearchReference(text: string): { directory: string; filename: string } | null {
  const match = text.match(new RegExp(
    `((?:[A-Za-z]:[\\\\/]|\\\\\\\\)[^\\r\\n，,；;。！？!?"'“”‘’]{1,420}?)` +
    // i18n-allow: Chinese directory-plus-file instruction parsing; not user-visible copy.
    `["'”’]?\\s*(?:中|里|内|下)\\s*(?:查找|搜索|寻找|检索)(?:并(?:读取|阅读|查看|打开))?\\s*(?:文件|文档)?\\s*["'“‘]?` +
    `([^\\\\/\\r\\n，,；;。！？!?"'“”‘’]{1,180}\\.${FILE_EXTENSIONS})`,
    'iu',
  ));
  if (!match) return null;
  return { directory: match[1].trim(), filename: match[2].trim() };
}

export function explicitAbsolutePaths(text: string): string[] {
  const clean = primaryTaskText(text);
  const directorySearch = directorySearchReference(clean);
  const windowsMatches = (clean.match(/(?:[A-Za-z]:[\\/]|~[\\/]|\\\\)[^\r\n，,；;。！？!?"'“”‘’]{1,420}/gu) || [])
    .map(value => directorySearch && value.startsWith(directorySearch.directory) && value.includes(directorySearch.filename)
      ? directorySearch.directory : value);
  const quotedPosixMatches = [...clean.matchAll(POSIX_QUOTED_PATH_RE)]
    .map(match => match.slice(1).find(Boolean) || '')
    // compact() deliberately collapses whitespace, so reject quoted paths
    // whose filesystem identity could change during normalization.
    .filter(value => !/\s{2,}|[^\S ]/u.test(value));
  const unquotedPosixMatches = [...clean.matchAll(POSIX_ABSOLUTE_PATH_RE)].flatMap(match => {
    const value = match[0];
    const suffix = clean.slice((match.index || 0) + value.length);
    if (!suffix) return [value];
    if (/^[，,；;。！？!?"'”’\)\]}]/u.test(suffix)) return [value];
    if (!/^\s/u.test(suffix)) return [];
    const continuation = suffix.replace(/^\s+/u, '');
    if (!continuation) return [value];
    // An unquoted space may be prose or part of a POSIX filename. Only retain
    // the token when a conservative clause boundary makes that unambiguous.
    // i18n-allow: multilingual path-clause boundary recognition; not user-visible copy.
    return /^(?:(?:for|to|from|in|under|with|using|and|then|please)(?=$|\s|[，,；;。！？!?"'“”‘’\)\]}])|(?:中|里|下|内)(?=$|\s|[，,；;。！？!?"'“”‘’\)\]}]|查找|搜索|寻找|检索|读取)|(?:用于|然后|请)(?=$|\s|[，,；;。！？!?"'“”‘’\)\]}]))/iu.test(continuation)
      ? [value]
      : [];
  });
  return unique([...windowsMatches, ...quotedPosixMatches, ...unquotedPosixMatches], 12);
}

export function pathMentionedByUser(candidate: string, taskText: string): boolean {
  const target = normalizedIdentity(candidate);
  if (!target) return false;
  const primary = normalizedIdentity(primaryTaskText(taskText));
  if (primary.includes(target)) return true;
  const base = normalizedIdentity(displayableFileName(candidate));
  return Boolean(base && primary.includes(base));
}

export function directoryWithin(candidate: string, root: string): boolean {
  const child = canonicalPathValue(candidate);
  const parent = canonicalPathValue(root);
  if (!child?.absolute || !parent?.absolute || child.flavor !== parent.flavor) return false;
  const flavor = child.flavor === 'win32' ? path.win32 : path.posix;
  const relative = flavor.relative(parent.normalized, child.normalized);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(relative));
}
