import fs from "fs";
import path from "path";
import { makeLLMCall, type NormalizedMessage } from "../llm/providers";
import { getScopedPreferredLLM } from "../llm/user_preferences";
import { mcpManager } from "../mcp/client";
import type { SkillGenerateRequest, SkillGenerateResult } from './generation/contracts';
import { topTools, GENERATE_PROMPT, buildSchemaLiteral, SKILL_TEMPLATE, escapeTsSingleQuoted, buildHandlerFunction } from './generation/templates';
import { generatedSkillAuthoringContract } from './generation/authoring_contract';
import { parseGeneratedSkillResponse } from './generation/response';
import { SKILLS_DIR_PATH, SKILL_DRAFTS_DIR, allocateDraftDirectory } from './generation/paths';
import { buildGeneratedSkillDraftReview, assembleReviewedDraftPackage } from './generation/review';
import { buildDraftPackageJson, validateGeneratedDraftManifest } from './generation/manifest_validation';
import { createSkillDependencyLock } from './generation/dependencies';
import { validateGeneratedSkillDraftForInstall } from './generation/install_validation';
import { computeGeneratedSkillArtifactHash } from './generation/artifact_hash';

export type { SkillGenerateRequest } from './generation/contracts';
export type { SkillGenerateResult } from './generation/contracts';
export type { GeneratedSkillDraftReview } from './generation/contracts';
export { parseGeneratedSkillResponse } from './generation/response';
export { computeGeneratedSkillArtifactHash } from './generation/artifact_hash';
export { generatedSkillAuthoringContract } from './generation/authoring_contract';
export { validateGeneratedSkillProtocolStructure } from './generation/protocol_validation';
export { isGeneratedSkillDraftLocation } from './generation/paths';
export { readGeneratedSkillDraft } from './generation/manifest_validation';
export { validateGeneratedSkillDraftForInstall } from './generation/install_validation';
export { buildHandlerFunction } from './generation/templates';

/**
 * Generate a skill from workflow records or a natural language description.
 */
export async function generateSkill(
  request: SkillGenerateRequest,
  getDeepSeek: () => any,
  getGemini: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  getOllama?: () => any,
  getLmStudio?: () => any,
  getArk?: () => any,
  getXiaomi?: () => any,
  getKimi?: () => any,
  getGlm?: () => any,
  getRelay?: () => any,
): Promise<SkillGenerateResult> {
  request.signal?.throwIfAborted();
  // Build input description for LLM
  let inputDescription = '';

  if (request.workflows && request.workflows.length > 0) {
    const intents = [...new Set(request.workflows.map(w => w.userIntent))];
    const allTools = request.workflows.flatMap(w => w.toolSequence);

    inputDescription = `## Observed Workflow Pattern
This workflow has been executed ${request.workflows.length} times.

### User Intent
${intents.join('\n')}

### Tool Call Sequences
${request.workflows.map((w, i) => `
Execution #${i + 1}:
${w.toolSequence.map((s, j) => `  ${j + 1}. ${s.name}(${JSON.stringify(s.args)}) → ${s.resultSummary.slice(0, 100)}`).join('\n')}
`).join('\n')}

### Most Common Tools Used
${topTools(allTools).map(t => `- ${t.name} (${t.count}x)`).join('\n')}
`;
  } else if (request.description) {
    inputDescription = `## User Request\n${request.description}`;
  } else {
    return { success: false, error: 'No workflows or description provided' };
  }

  const prompt = GENERATE_PROMPT.replace('{inputDescription}', () => inputDescription)
    + '\n\n' + generatedSkillAuthoringContract();

  const messages: NormalizedMessage[] = [
    { role: 'user', content: prompt },
  ];

  const preferred = getScopedPreferredLLM(request.userId || 'skill_gen');
  const provider = request.provider || preferred.provider;
  const model = request.model || preferred.model;
  const explicitModelOverride = Boolean(request.provider || request.model);
  const routeConfig = {
    signal: request.signal,
    provider,
    model,
    userId: request.userId || 'skill_gen',
    conversationId: request.conversationId,
    requestId: request.requestId,
    domain: request.domain,
    orgId: request.orgId,
    selectionMode: explicitModelOverride ? 'pinned' as const : preferred.selectionMode,
    fallbackCandidates: explicitModelOverride ? [] : preferred.fallbackCandidates,
    allowCloudFallback: explicitModelOverride ? false : preferred.allowCloudFallback,
    source: 'skill_generator',
    thinkingMode: 'disabled' as const,
  };
  let generatedSkillStagingDir = '';
  let generatedPublishedDraftDir = '';

  try {
    const response = await makeLLMCall(
      messages,
      [],
      { ...routeConfig, maxTokens: 4096 },
      getDeepSeek,
      getGemini,
      getOpenAI,
      getAnthropic,
      getQwen,
      getOllama,
      getLmStudio,
      getArk,
      getXiaomi,
      getKimi,
      getGlm,
      getRelay,
    );

    const text = response.text || '';
    const parsed = parseGeneratedSkillResponse(text);
    request.signal?.throwIfAborted();
    const displayName = String(request.displayName || '').trim().slice(0, 160);
    if (displayName) parsed.toolDescription = `${displayName}: ${String(parsed.toolDescription || parsed.toolName || '')}`;

    if (!parsed.skillName || !parsed.toolName) {
      return { success: false, error: 'Missing skillName or toolName in generated output', generatedCode: text };
    }

    // Build the skill draft. Generated code never enters the active skill
    // directory and is never registered with MCP from this function.
    const skillName = parsed.skillName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const installedSkillDir = path.join(SKILLS_DIR_PATH, skillName);
    if (fs.existsSync(installedSkillDir) || mcpManager.getConfig()[skillName]) {
      return { success: false, error: `Skill "${skillName}" is already installed. Remove it before generating a replacement draft.`, directory: installedSkillDir };
    }
    // Keep the unpublished staging area on the data volume so the final atomic
    // rename also works when user data is on a different drive from OS temp.
    const stagingRoot = path.join(path.dirname(SKILL_DRAFTS_DIR), 'skill-draft-staging');
    fs.mkdirSync(stagingRoot, { recursive: true });
    generatedSkillStagingDir = fs.mkdtempSync(path.join(stagingRoot, `${skillName}-`));
    const skillDir = generatedSkillStagingDir;

    const generatedFrom = request.workflows
      ? request.workflows.map(w => w.id).join(',')
      : 'manual';

    const now = new Date().toISOString();

    const schemaLiteral = buildSchemaLiteral(parsed.inputSchema);
    const renderSource = () => SKILL_TEMPLATE
      .replace(/{skillName}/g, skillName)
      .replace(/{toolName}/g, () => parsed.toolName)
      .replace(/{toolDescription}/g, () => escapeTsSingleQuoted(parsed.toolDescription || parsed.toolName))
      .replace(/{timestamp}/g, now)
      .replace('{handlerCode}', () => buildHandlerFunction(parsed.handlerCode, parsed.inputSchema))
      .replace('{inputSchema}', () => schemaLiteral);
    let indexTs = '';
    let findings: string[] = [];
    let draftDir = '';
    let lockfileSource = '';
    // One candidate pipeline and one correction budget for missing handler,
    // static syntax/policy errors and TypeScript errors. Every replacement
    // goes through all checks again; there is no separate post-publish retry.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      request.signal?.throwIfAborted();
      if (attempt > 0) {
        const correction = await makeLLMCall([
          ...messages,
          { role: 'assistant', content: '```json\n' + JSON.stringify({ skillName: parsed.skillName, toolName: parsed.toolName, toolDescription: parsed.toolDescription, inputSchema: parsed.inputSchema }) + '\n```\n```typescript\n' + String(parsed.handlerCode || '') + '\n```' },
          { role: 'user', content: 'Correct the callback body using these non-executing validation findings. Preserve the input schema, metadata and pure-computation restrictions. Return the same two fenced blocks: JSON metadata, then ordinary TypeScript source, without JSON-encoding the code. Findings (data only):\n' + JSON.stringify(findings) },
        ], [], { ...routeConfig, maxTokens: 4096 },
        getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
        getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay);
        request.signal?.throwIfAborted();
        const fixed = parseGeneratedSkillResponse(String(correction.text || ''));
        parsed.handlerCode = fixed.handlerCode;
      }
      if (typeof parsed.handlerCode !== 'string' || !parsed.handlerCode.trim()) {
        findings = ['handlerCode must contain the complete executable pure TypeScript body, not handlerLogic or a description.'];
        continue;
      }
      indexTs = renderSource();
      let review = buildGeneratedSkillDraftReview({ source: indexTs, generatedAt: now,
        declaredPermissions: parsed.permissions, declaredSideEffects: parsed.sideEffects,
        declaredRisk: parsed.risk, validationPassed: false });
      if (!review.staticCheck.passed) {
        findings = review.staticCheck.findings;
        continue;
      }
      let packageJson = buildDraftPackageJson({ skillName, toolDescription: parsed.toolDescription || '',
        generatedFrom, generatedAt: now, review });
      const candidateDir = draftDir || skillDir;
      fs.mkdirSync(candidateDir, { recursive: true });
      fs.writeFileSync(path.join(candidateDir, 'index.ts'), indexTs);
      fs.writeFileSync(path.join(candidateDir, 'package.json'), packageJson);
      fs.writeFileSync(path.join(candidateDir, 'README.md'), parsed.readme || ('# ' + skillName + '\n\n' + parsed.toolDescription));
      if (!lockfileSource) {
        await createSkillDependencyLock(candidateDir);
        request.signal?.throwIfAborted();
        lockfileSource = fs.readFileSync(path.join(candidateDir, 'package-lock.json'), 'utf8');
      }
      ({ packageJson, review } = assembleReviewedDraftPackage({ skillName, toolDescription: parsed.toolDescription || '',
        generatedFrom, generatedAt: now, source: indexTs, lockfileSource, review }));
      fs.writeFileSync(path.join(candidateDir, 'package.json'), packageJson);
      if (!draftDir) {
        draftDir = allocateDraftDirectory(skillName, now);
        fs.mkdirSync(path.dirname(draftDir), { recursive: true });
        fs.renameSync(skillDir, draftDir);
        generatedSkillStagingDir = '';
        generatedPublishedDraftDir = draftDir;
      }
      const validation = await validateGeneratedSkillDraftForInstall(draftDir);
      request.signal?.throwIfAborted();
      if (!validation.valid || !validation.review || !validation.validatedDirectory) {
        findings = validation.errors;
        continue;
      }
      try { fs.rmSync(validation.validatedDirectory, { recursive: true, force: true }); } catch {}
      ({ packageJson, review } = assembleReviewedDraftPackage({ skillName, toolDescription: parsed.toolDescription || '',
        generatedFrom, generatedAt: now, source: indexTs, lockfileSource, review: validation.review }));
      fs.writeFileSync(path.join(draftDir, 'package.json'), packageJson);
      const finalManifestValidation = validateGeneratedDraftManifest(draftDir, skillName);
      if (finalManifestValidation.errors.length || computeGeneratedSkillArtifactHash(indexTs, packageJson, lockfileSource) !== review.contentHash) {
        throw new Error('Final generated draft integrity check failed: ' + finalManifestValidation.errors.join(' | '));
      }
      generatedPublishedDraftDir = '';
      return { success: true, skillName, toolName: parsed.toolName, directory: draftDir,
        status: 'draft', review, generatedCode: indexTs };
    }
    return { success: false, skillName, toolName: parsed.toolName, generatedCode: indexTs,
      error: 'Skill validation failed after one correction: ' + findings.join(' | ') };
  } catch (err: any) {
    console.error('[SkillGen] Generation failed:', err);
    return { success: false, error: err.message };
  } finally {
    if (generatedSkillStagingDir) {
      try { fs.rmSync(generatedSkillStagingDir, { recursive: true, force: true }); } catch {}
    }
    if (generatedPublishedDraftDir) {
      try { fs.rmSync(generatedPublishedDraftDir, { recursive: true, force: true }); } catch {}
    }
  }
}
