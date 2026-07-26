import { exec } from 'child_process';
import path from 'path';
import { ToolRegistry } from '../registry';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';

const REPO_ROOT = process.cwd();

function git(args: string, timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(`git ${args}`, { timeout, maxBuffer: 300 * 1024, cwd: REPO_ROOT }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
      } else {
        resolve(stdout || stderr || '');
      }
    });
  });
}

async function gitStatusHandler(): Promise<string> {
  const output = await git('status --short --branch');
  if (!output.trim()) return 'Working tree clean. No changes.';
  return output.trim();
}

async function gitDiffHandler(args: Record<string, any>): Promise<string> {
  const staged = args.staged ? '--cached' : '';
  const file = args.file ? `-- ${args.file}` : '';
  const output = await git(`diff ${staged} ${file}`.trim(), 15000);
  const lines = output.split('\n');
  if (lines.length > 500) {
    return lines.slice(0, 500).join('\n') + `\n\n[... truncated: ${lines.length - 500} more lines]`;
  }
  return output || 'No changes.';
}

async function gitStageHandler(args: Record<string, any>): Promise<string> {
  const files: string[] = args.files || [];
  if (!files.length) throw new Error('At least one file path is required.');

  // Safety: reject dangerous patterns
  const dangerous = ['..', '~', '*', '?', '[', ']'];
  for (const file of files) {
    for (const d of dangerous) {
      if (file.includes(d)) throw new Error(`Dangerous pattern rejected: "${file}". Use explicit file paths.`);
    }
  }

  const fileList = files.map(f => `"${f}"`).join(' ');
  await git(`add ${fileList}`);
  return JSON.stringify({ ok: true, status: 'staged', fileCount: files.length, files }, null, 2);
}

async function gitCommitHandler(args: Record<string, any>): Promise<string> {
  const message = String(args.message || '').trim();
  if (!message) throw new Error('Commit message is required.');
  if (message.length > 200) throw new Error(`Commit message too long (${message.length} chars). Max 200.`);

  // Safety: reject destructive flags
  if (message.includes('--no-verify') || message.includes('--force')) {
    throw new Error('Dangerous commit flag rejected.');
  }

  const body = args.body ? `-m "${String(args.body).replace(/"/g, '\\"')}"` : '';
  await git(`commit -m "${message.replace(/"/g, '\\"')}" ${body}`.trim());
  const revision = (await git('rev-parse HEAD')).trim();
  return JSON.stringify({ ok: true, status: 'committed', message, revision }, null, 2);
}

export function registerGitTools(registry: ToolRegistry): void {
  registry.register({
    name: 'git_status',
    description: 'Show working tree status. Returns branch info and changed files. Equivalent to "git status --short --branch".',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: gitStatusHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'git_diff',
    description: 'Show changes in unified diff format. Use "staged: true" to see staged changes. Use "file" to limit to a specific file.',
    parameters: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'Show staged (cached) changes instead of working tree' },
        file: { type: 'string', description: 'Limit diff to a specific file path' },
      },
      required: [],
    },
    handler: gitDiffHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'git_stage',
    description: 'Stage specific files for commit (git add). Must provide explicit file paths — wildcards rejected for safety.',
    parameters: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Array of file paths to stage' },
      },
      required: ['files'],
    },
    handler: gitStageHandler,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'git.index.stage',
      family: 'git',
      lane: 'system',
      operation: 'mutate',
      risk: 'medium',
      sideEffects: [{ type: 'local_write', scope: 'current repository Git index', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'fileCount', 'files'],
        requiredValues: { ok: true, status: 'staged' },
        successStatuses: ['staged'],
        successSignals: ['git add completed for every explicit file path'],
        limitations: ['The receipt does not claim a commit was created.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'git.index.stage',
      operation: 'mutate',
      subjectArgument: 'files',
    }),
  });

  registry.register({
    name: 'git_commit',
    description: 'Commit staged changes with a descriptive message. Max 200 chars. Destructive flags (--no-verify, --force) are blocked.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message (max 200 chars)' },
        body: { type: 'string', description: 'Optional extended commit body' },
      },
      required: ['message'],
    },
    handler: gitCommitHandler,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'git.commit.create',
      family: 'git',
      lane: 'system',
      operation: 'create',
      risk: 'high',
      sideEffects: [{ type: 'local_write', scope: 'current repository commit history', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'message', 'revision'],
        requiredValues: { ok: true, status: 'committed' },
        successStatuses: ['committed'],
        successSignals: ['git commit completed and HEAD resolves to the returned revision'],
        limitations: ['The receipt does not claim the commit was pushed.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'git.commit.create',
      operation: 'create',
      subjectArgument: 'message',
      limitations: ['Local commit creation is distinct from remote publication.'],
    }),
  });
}
