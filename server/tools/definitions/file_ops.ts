import fs from 'fs';
import path from 'path';
import os from 'os';
import { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import type { ToolContext } from '../types';
import { getDataPath } from '../../config/data_path';

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ''
    || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function getAutonomousReportRoot(): string {
  return path.dirname(getDataPath(path.join('autonomy', 'reports', '.keep')));
}

function resolveWritePath(inputPath: string, context?: Pick<ToolContext, 'cwd' | 'autonomous'>): string {
  const requestedPath = resolveSafePath(inputPath, context?.cwd);
  if (!context?.autonomous) return requestedPath;

  const reportRoot = getAutonomousReportRoot();
  const requestBase = path.resolve(context.cwd || process.cwd());
  let relativePath = isPathInside(requestBase, requestedPath)
    ? path.relative(requestBase, requestedPath)
    : path.basename(requestedPath);

  if (!relativePath || relativePath === '.') {
    relativePath = path.basename(requestedPath);
  }

  const candidate = path.resolve(reportRoot, relativePath);
  return isPathInside(reportRoot, candidate)
    ? candidate
    : path.resolve(reportRoot, path.basename(requestedPath));
}

function resolveSafePath(userPath: string, cwd?: string): string {
  const base = cwd || process.cwd();
  const resolved = path.resolve(base, userPath);
  const normalized = path.normalize(resolved);

  const allowedRoots = [
    os.homedir(),
    process.cwd(),
    path.resolve(process.cwd(), '..'),
    os.tmpdir(),
  ];

  const isAllowed = allowedRoots.some(root =>
    normalized.startsWith(path.normalize(root) + path.sep) ||
    normalized === path.normalize(root)
  );

  if (!isAllowed) {
    throw new Error(`Access denied: "${normalized}" is outside allowed paths.`);
  }

  return normalized;
}

function simpleGlobToRegex(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      regexStr += '.*';
      i += 2;
      if (pattern[i] === '/' || pattern[i] === '\\') i++;
    } else if (pattern[i] === '*') {
      regexStr += '[^/\\\\]*';
      i++;
    } else if (pattern[i] === '?') {
      regexStr += '[^/\\\\]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(pattern[i])) {
      regexStr += '\\' + pattern[i];
      i++;
    } else {
      regexStr += pattern[i];
      i++;
    }
  }
  return new RegExp('^' + regexStr + '$');
}

function firstStringArg(args: Record<string, any>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function requirePathArg(args: Record<string, any>, keys: string[], toolName: string): string {
  const value = firstStringArg(args, keys);
  if (!value) {
    throw new Error(`${toolName} requires a file path. Accepted keys: ${keys.join(', ')}.`);
  }
  return value;
}

async function readFileHandler(
  args: Record<string, any>,
  context?: Pick<ToolContext, 'cwd' | 'desktopRelay'>,
): Promise<string> {
  const inputPath = requirePathArg(args, ['path', 'filePath', 'filepath', 'targetPath', 'target'], 'read_file');
  const targetPath = resolveSafePath(inputPath, context?.cwd);
  try {
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      throw new Error(`"${targetPath}" is a directory, not a file.`);
    }
    if (stat.size > 100 * 1024) {
      throw new Error(`File too large (${(stat.size / 1024).toFixed(1)}KB). Max 100KB.`);
    }
    return fs.readFileSync(targetPath, 'utf-8');
  } catch (localError) {
    const canUseNativePath = /^(?:~[\\/]|[a-z]:[\\/]|\/)/i.test(inputPath.trim());
    if (!context?.desktopRelay || !canUseNativePath) throw localError;
    const relayed = await context.desktopRelay('desktop_read_text_file', { path: inputPath.trim() });
    let receipt: any;
    try {
      receipt = JSON.parse(relayed);
    } catch {
      throw new Error('The native desktop client returned no structured text-file read receipt');
    }
    if (receipt?.success !== true || typeof receipt.content !== 'string') {
      throw new Error(String(receipt?.error || 'The native desktop client could not read the text file'));
    }
    return receipt.content;
  }
}

async function writeFileHandler(
  args: Record<string, any>,
  context?: Pick<ToolContext, 'cwd' | 'autonomous'>,
): Promise<string> {
  const inputPath = requirePathArg(args, ['path', 'filePath', 'filepath', 'targetPath', 'target'], 'write_file');
  const targetPath = resolveWritePath(inputPath, context);

  const blockedPaths = ['/etc', '/sys', '/proc', '/dev', 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)'];
  const normalizedTarget = path.normalize(targetPath);
  for (const blocked of blockedPaths) {
    if (normalizedTarget.startsWith(path.normalize(blocked))) {
      throw new Error(`Access denied: cannot write to system path "${targetPath}".`);
    }
  }

  const content = String(args.content || '');
  if (content.length > 500 * 1024) {
    throw new Error(`Content too large (${(content.length / 1024).toFixed(1)}KB). Max 500KB.`);
  }

  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(targetPath, content, 'utf-8');
  return `File written: ${targetPath} (${content.length} bytes)`;
}

async function listDirectoryHandler(args: Record<string, any>, context?: { cwd?: string }): Promise<string> {
  const targetPath = resolveSafePath(args.path || '.', context?.cwd);
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    throw new Error(`"${targetPath}" is not a directory.`);
  }

  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  const results = entries.slice(0, 500).map(entry => {
    const fullPath = path.join(targetPath, entry.name);
    let size = 0;
    try {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        size = fs.statSync(fullPath).size;
      }
    } catch {
      // ignore stat errors for inaccessible files
    }
    return {
      name: entry.name,
      path: fullPath,
      isDirectory: entry.isDirectory(),
      size,
    };
  });

  return JSON.stringify(results, null, 2);
}

async function searchFilesHandler(args: Record<string, any>, context?: { cwd?: string }): Promise<string> {
  const directory = resolveSafePath(args.directory || '.', context?.cwd);
  const pattern = args.pattern || '*';
  const regex = simpleGlobToRegex(pattern);

  const results: string[] = [];
  const maxResults = 200;

  function walk(dir: string) {
    if (results.length >= maxResults) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      const relativePath = path.relative(directory, path.join(dir, entry.name));
      if (regex.test(relativePath) || regex.test(entry.name)) {
        const fullPath = path.join(dir, entry.name);
        results.push(fullPath);
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(path.join(dir, entry.name));
      }
    }
  }

  walk(directory);
  return JSON.stringify(results.slice(0, maxResults), null, 2);
}

async function grepFilesHandler(args: Record<string, any>, context?: { cwd?: string }): Promise<string> {
  const directory = resolveSafePath(args.directory || '.', context?.cwd);
  const pattern = args.pattern || '';
  if (!pattern) throw new Error('Search pattern is required.');

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'gi');
  } catch (e: any) {
    throw new Error(`Invalid regex pattern: ${e.message}`);
  }

  const globPattern = args.glob || '*';
  const maxResults = Math.min(Math.max(Number(args.maxResults) || 100, 1), 500);
  const globRegex = simpleGlobToRegex(globPattern);

  interface Match {
    file: string;
    line: number;
    content: string;
  }
  const results: Match[] = [];

  function walk(dir: string) {
    if (results.length >= maxResults) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'target' || entry.name === 'dist') continue;
        walk(path.join(dir, entry.name));
      } else if (globRegex.test(entry.name)) {
        const filePath = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(filePath);
          if (stat.size > 500 * 1024) continue; // skip files > 500KB
          const content = fs.readFileSync(filePath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            if (regex.test(lines[i])) {
              results.push({
                file: path.relative(directory, filePath),
                line: i + 1,
                content: lines[i].trim().slice(0, 200),
              });
            }
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(directory);

  if (results.length === 0) {
    return `No matches found for pattern "${pattern}" in ${directory}`;
  }

  // Group by file
  const byFile = new Map<string, Match[]>();
  for (const m of results) {
    if (!byFile.has(m.file)) byFile.set(m.file, []);
    byFile.get(m.file)!.push(m);
  }

  const lines: string[] = [`Found ${results.length} matches for "${pattern}":\n`];
  for (const [file, matches] of byFile) {
    lines.push(`${file}:`);
    for (const m of matches) {
      lines.push(`  ${m.line}: ${m.content}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function readFilesBatchHandler(args: Record<string, any>, context?: { cwd?: string }): Promise<string> {
  const paths: string[] = args.paths || args.filePaths || args.filepaths || [];
  if (!paths.length) throw new Error('At least one file path is required.');
  if (paths.length > 10) throw new Error('Maximum 10 files per batch request.');

  const results: string[] = [];
  for (const userPath of paths) {
    try {
      const targetPath = resolveSafePath(userPath, context?.cwd);
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        results.push(`── ${userPath} ──\n[DIRECTORY — use list_directory to browse]`);
        continue;
      }
      if (stat.size > 100 * 1024) {
        results.push(`── ${userPath} ──\n[FILE TOO LARGE: ${(stat.size / 1024).toFixed(1)}KB]`);
        continue;
      }
      const content = fs.readFileSync(targetPath, 'utf-8');
      const truncated = content.length > 5000 ? content.slice(0, 5000) + '\n[...truncated]' : content;
      results.push(`── ${userPath} ──\n${truncated}`);
    } catch (e: any) {
      results.push(`── ${userPath} ──\n[ERROR: ${e.message}]`);
    }
  }
  return results.join('\n\n');
}

export function registerFileOpsTools(registry: ToolRegistry): void {
  registry.register({
    name: 'read_file',
    description: 'Read the contents of a file. Returns the file content as text.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the file to read' },
        filePath: { type: 'string', description: 'Alias for path, accepted for compatibility with chained workflows' },
      },
      required: [],
    },
    handler: readFileHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write' },
        filePath: { type: 'string', description: 'Alias for path, accepted for compatibility with chained workflows' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['content'],
    },
    handler: writeFileHandler,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'files.text.write',
      family: 'file_ops',
      lane: 'files',
      operation: 'create',
      risk: 'medium',
      sideEffects: [{ type: 'local_write', scope: 'explicit local text file path', reversible: true }],
      verification: {
        strategy: 'artifact',
        required: true,
        requiredFields: [],
        successSignals: ['the returned local file path exists and is non-empty'],
        limitations: ['An intentionally empty file cannot satisfy the non-empty artifact verifier.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'files.text.write',
      operation: 'create',
      subjectArgument: 'path',
    }),
  });

  registry.register({
    name: 'list_directory',
    description: 'List files and subdirectories in a directory. Returns a JSON array.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list. Defaults to current directory.' },
      },
      required: [],
    },
    handler: listDirectoryHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'search_files',
    description: 'Search for files matching a glob pattern. Returns matching file paths.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern like "**/*.ts" or "*.json"' },
        directory: { type: 'string', description: 'Directory to search in. Defaults to current directory.' },
      },
      required: ['pattern'],
    },
    handler: searchFilesHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  // ── grep_files: full-text regex search ──
  registry.register({
    name: 'grep_files',
    description: 'Search file CONTENTS with a regex pattern. Returns matching lines with file paths and line numbers. Essential for code exploration — find where symbols are defined, where functions are called, or where patterns appear across the codebase.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for in file contents (e.g. "function\\s+loadConfig", "import.*from")' },
        directory: { type: 'string', description: 'Directory to search in. Defaults to current directory.' },
        glob: { type: 'string', description: 'Optional file filter, e.g. "*.ts" or "*.{ts,tsx}" to only search matching files.' },
        maxResults: { type: 'number', description: 'Maximum matches to return (default 100, max 500).' },
      },
      required: ['pattern'],
    },
    handler: grepFilesHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  // ── read_files_batch: parallel file reading ──
  registry.register({
    name: 'read_files_batch',
    description: 'Read multiple files at once. Useful for understanding cross-file relationships — read a function definition and all its callers simultaneously. Max 10 files per call.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Array of file paths to read (max 10).' },
        filePaths: { type: 'array', items: { type: 'string' }, description: 'Alias for paths, accepted for compatibility with chained workflows.' },
      },
      required: [],
    },
    handler: readFilesBatchHandler,
    permission: 'user',
    securityLevel: 'safe',
  });
}
