import fs from "node:fs";
import path from "node:path";
import { isAutonomousSelfImprovementDocumentationPath } from "../improvement_program";
import { containsSelfImprovementSecret } from "../content_security";
import type { SelfImprovementVerificationReceipt } from './contracts';
import { assertWithin } from './filesystem_boundary';
import { digest } from './identity';

export function verifyStaticDocumentation(
  worktreePath: string,
  profile: 'targeted' | 'standard' | 'full',
  changedPaths: string[],
): SelfImprovementVerificationReceipt[] {
  if (!changedPaths.length || changedPaths.some(file => !isAutonomousSelfImprovementDocumentationPath(file))) {
    throw new Error('Autonomous self-improvement may verify only exact static Markdown documentation paths.');
  }
  const contents = changedPaths.map(file => {
    const absolute = path.resolve(worktreePath, ...file.split('/'));
    assertWithin(worktreePath, absolute);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) {
      throw new Error(`Autonomous documentation must remain a regular file under 1 MB: ${file}.`);
    }
    const content = fs.readFileSync(absolute);
    if (content.includes(0) || content.toString('utf8').includes('\uFFFD')) {
      throw new Error(`Autonomous documentation must be valid UTF-8 text without NUL bytes: ${file}.`);
    }
    return `${file}\0${digest(content)}`;
  });
  return [{
    profile,
    command: 'static-markdown-integrity',
    status: 'passed',
    exitCode: 0,
    durationMs: 0,
    outputDigest: digest(contents.sort().join('\n')),
    summary: `static Markdown integrity verified for ${changedPaths.length} reviewed path(s); no project code was executed`,
  }];
}

export function assertStaticDocumentationContent(stageRoot: string, changedPaths: string[]): void {
  for (const file of changedPaths) {
    const absolute = path.resolve(stageRoot, ...file.split('/'));
    assertWithin(stageRoot, absolute);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) {
      throw new Error(`Autonomous documentation must remain a regular file under 1 MB: ${file}.`);
    }
    const content = fs.readFileSync(absolute);
    const text = content.toString('utf8');
    if (content.includes(0) || text.includes('\uFFFD')) {
      throw new Error(`Autonomous documentation must be valid UTF-8 text without NUL bytes: ${file}.`);
    }
    if (containsSelfImprovementSecret(text)) {
      throw new Error(`Autonomous documentation appears to contain credential or private-key material: ${file}.`);
    }
  }
}
