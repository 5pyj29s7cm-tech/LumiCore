import fs from "node:fs";
import path from "node:path";
import { type authorizeSelfImprovementStage, recordSelfImprovementStage, type SelfImprovementProposal, type SelfImprovementScope } from "../improvement_program";
import type { SelfImprovementRepositoryIdentity } from "../repository_identity";
import type { CommandRunner, SelfImprovementStagingOptions, SelfImprovementStageResult } from './contracts';
import { assertStagingMayContinue, safeBranchId } from './identity';
import { ensureTrustedStagingParent, assertWithin, ensureUnlinkedDirectoryChain, listPlainStageFiles, assertSafePlainStageRoot } from './filesystem_boundary';
import { makeRestrictedGitContext, runRestrictedGitProbe, assertNoGitContentTransforms, runRestrictedGit, parseLsTreeEntries, gitBlobObjectId, exactCommitManifest, assertStageFilesMatchCommit } from './restricted_git';
import { assertExactPathSet, parseNullSeparatedPaths } from './patch_policy';
import { assertStaticDocumentationContent, verifyStaticDocumentation } from './documentation_policy';

export async function stageAutonomousStaticDocumentation(input: {
  scope: SelfImprovementScope;
  program: ReturnType<typeof authorizeSelfImprovementStage>['program'];
  proposal: SelfImprovementProposal;
  patchText: string;
  patchDigest: string;
  changedPaths: string[];
  profile: 'targeted' | 'standard' | 'full';
  baseCommit: string;
  deliveryBranch: string;
  repository: SelfImprovementRepositoryIdentity;
  runner: CommandRunner;
  options: SelfImprovementStagingOptions;
  commitMessage?: string;
}): Promise<SelfImprovementStageResult> {
  const {
    scope, program, proposal, patchText, patchDigest, changedPaths, profile,
    baseCommit, deliveryBranch, repository, runner, options,
  } = input;
  assertStagingMayContinue(options);
  if (!program.allowLocalCommit) {
    throw new Error('Autonomous documentation staging requires an isolated local commit receipt.');
  }
  const requestedParent = path.resolve(options.worktreeParent
    || path.join(path.dirname(repository.root), '.lumi-self-improvement', path.basename(repository.root)));
  const worktreeParent = ensureTrustedStagingParent(requestedParent, repository);
  const sessionRoot = fs.mkdtempSync(path.join(worktreeParent, `${safeBranchId(proposal.id)}-`));
  assertWithin(worktreeParent, sessionRoot);
  ensureUnlinkedDirectoryChain(sessionRoot, false);
  const stageRoot = path.join(sessionRoot, 'content');
  fs.mkdirSync(stageRoot, { recursive: false, mode: 0o700 });
  ensureUnlinkedDirectoryChain(stageRoot, false);
  const patchPath = path.join(sessionRoot, 'reviewed.patch');
  assertWithin(sessionRoot, patchPath);
  fs.writeFileSync(patchPath, patchText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const indexPath = path.join(sessionRoot, 'git.index');
  assertWithin(sessionRoot, indexPath);
  if (fs.existsSync(indexPath)) throw new Error('The isolated self-improvement index already exists.');
  const branch = `lumi/self-improvement/${safeBranchId(proposal.id)}`;
  const ref = `refs/heads/${branch}`;
  const gitContext = makeRestrictedGitContext(sessionRoot);
  let branchCreated = false;
  let createdCommit = '';
  try {
    const branchProbe = await runRestrictedGitProbe(runner, repository, gitContext, [
      'show-ref', '--verify', '--quiet', ref,
    ]);
    if (branchProbe.exitCode === 0) throw new Error('The isolated self-improvement branch already exists.');
    await assertNoGitContentTransforms(runner, repository, gitContext, changedPaths);

    for (const file of changedPaths) {
      const treeOutput = (await runRestrictedGit(
        runner,
        repository,
        gitContext,
        ['ls-tree', '-z', baseCommit, '--', file],
      )).stdout;
      if (!treeOutput) continue;
      const entries = parseLsTreeEntries(treeOutput);
      if (entries.length !== 1 || entries[0].path !== file || entries[0].mode !== '100644' || entries[0].type !== 'blob') {
        throw new Error(`Existing autonomous documentation must be a regular 100644 Git blob: ${file}.`);
      }
      const content = (await runRestrictedGit(
        runner,
        repository,
        gitContext,
        ['cat-file', 'blob', `${baseCommit}:${file}`],
      )).stdout;
      const contentBuffer = Buffer.from(content, 'utf8');
      if (contentBuffer.length > 1_000_000) {
        throw new Error(`Existing autonomous documentation exceeds the 1 MB static limit: ${file}.`);
      }
      if (gitBlobObjectId(contentBuffer, repository.objectFormat) !== entries[0].objectId) {
        throw new Error(`Materialized autonomous documentation does not match its exact base Git blob: ${file}.`);
      }
      const absolute = path.resolve(stageRoot, ...file.split('/'));
      assertWithin(stageRoot, absolute);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, contentBuffer, { flag: 'wx', mode: 0o600 });
    }

    await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['apply', '--check', '--whitespace=error-all', patchPath],
      stageRoot,
    );
    await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['apply', '--whitespace=error-all', patchPath],
      stageRoot,
    );
    fs.rmSync(patchPath, { force: true });
    assertExactPathSet(listPlainStageFiles(stageRoot), changedPaths, 'Applied static documentation patch');
    assertStaticDocumentationContent(stageRoot, changedPaths);
    const verification = verifyStaticDocumentation(stageRoot, profile, changedPaths);

    const indexEnv = { GIT_INDEX_FILE: indexPath };
    await runRestrictedGit(runner, repository, gitContext, ['read-tree', baseCommit], repository.root, 30_000, indexEnv);
    for (const file of changedPaths) {
      const absolute = path.resolve(stageRoot, ...file.split('/'));
      const objectId = (await runRestrictedGit(
        runner,
        repository,
        gitContext,
        ['hash-object', '-w', '--no-filters', '--', absolute],
      )).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/i.test(objectId)) throw new Error(`Git did not create a valid blob for ${file}.`);
      await runRestrictedGit(
        runner,
        repository,
        gitContext,
        ['update-index', '--add', '--cacheinfo', `100644,${objectId},${file}`],
        repository.root,
        30_000,
        indexEnv,
      );
    }
    const tree = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['write-tree'],
      repository.root,
      30_000,
      indexEnv,
    )).stdout.trim();
    const message = `docs: verified self-improvement ${safeBranchId(proposal.id)}`;
    const identityArgs = [
      '-c', 'user.name=Lumi Self-Improvement',
      '-c', 'user.email=lumi-self-improvement@localhost',
      'commit-tree', tree, '-p', baseCommit, '-m', message,
    ];
    const commit = (await runRestrictedGit(
      runner,
      repository,
      gitContext,
      identityArgs,
      repository.root,
      60_000,
      indexEnv,
    )).stdout.trim();
    createdCommit = commit;
    const zeroObject = '0'.repeat(repository.objectFormat === 'sha256' ? 64 : 40);
    assertStagingMayContinue(options);
    await runRestrictedGit(runner, repository, gitContext, ['update-ref', ref, commit, zeroObject]);
    branchCreated = true;

    const committedPaths = parseNullSeparatedPaths((await runRestrictedGit(
      runner,
      repository,
      gitContext,
      ['diff', '--no-ext-diff', '--name-only', '-z', baseCommit, commit],
    )).stdout);
    assertExactPathSet(committedPaths, changedPaths, 'Committed self-improvement');
    const manifest = await exactCommitManifest(runner, repository, gitContext, commit, changedPaths);
    await assertStageFilesMatchCommit(runner, repository, gitContext, stageRoot, manifest.entries);
    assertStagingMayContinue(options);
    const persistedProposal = await recordSelfImprovementStage(scope, proposal.id, {
      status: 'verified',
      baseCommit,
      worktreePath: stageRoot,
      branch,
      commit,
      patchDigest,
      treeDigest: manifest.digest,
      stagingProtocol: 'static_git_plumbing_v1',
      deliveryBranch,
      evidence: [
        { kind: 'repository', ref: repository.repositoryId, status: 'bound', summary: `trusted repository origin fingerprint ${repository.origin}` },
        { kind: 'git', ref: branch, status: 'isolated', summary: `plumbing-only branch at base ${baseCommit}` },
        { kind: 'tree', ref: tree, status: 'verified', summary: `exact 100644 documentation tree ${manifest.digest}` },
        ...verification.map(receipt => ({
          kind: 'verification', ref: receipt.command, status: receipt.status, summary: receipt.summary,
        })),
        { kind: 'commit', ref: commit, status: 'verified', summary: 'local isolated commit created without checkout, hooks, filters, or signing' },
      ],
    });
    return {
      ok: true,
      status: 'verified',
      persisted: true,
      isolated: true,
      activated: false,
      pushed: false,
      proposal: persistedProposal,
      baseCommit,
      branch,
      commit,
      worktreePath: stageRoot,
      changedPaths,
      repositoryId: repository.repositoryId,
      treeDigest: manifest.digest,
      verification,
    };
  } catch (error) {
    try { fs.rmSync(patchPath, { force: true }); } catch {}
    try { fs.rmSync(indexPath, { force: true }); } catch {}
    if (branchCreated) {
      try { await runRestrictedGitProbe(runner, repository, gitContext, ['update-ref', '-d', ref, createdCommit]); } catch {}
    }
    if (fs.existsSync(sessionRoot)) {
      try {
        const safeSessionRoot = assertSafePlainStageRoot(stageRoot, proposal, repository);
        fs.rmSync(safeSessionRoot, { recursive: true, force: true });
      } catch {}
    }
    throw error;
  } finally {
    try { fs.rmSync(indexPath, { force: true }); } catch {}
    try {
      const safeSessionRoot = assertSafePlainStageRoot(stageRoot, proposal, repository);
      assertWithin(safeSessionRoot, gitContext.hooksPath);
      const hooksStat = fs.lstatSync(gitContext.hooksPath);
      if (!hooksStat.isDirectory() || hooksStat.isSymbolicLink()) throw new Error('Unsafe restricted hooks cleanup target.');
      fs.rmSync(gitContext.hooksPath, { recursive: true, force: true });
    } catch {}
  }
}
