/**
 * Lumi Skill Generator — LLM-driven MCP server package generation.
 *
 * Takes workflow records (tool call sequences) or natural language descriptions
 * and generates a complete, installable MCP server package in ~/lumi_skills/.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { exec } from 'child_process';
import { makeLLMCall, NormalizedMessage } from '../llm/providers';
import { getScopedPreferredLLM } from '../llm/user_preferences';
import type { UserLLMProvider } from '../llm/user_preferences';
import { WorkflowRecord, WorkflowStep } from './worklog';
import { mcpManager, SKILLS_DIR } from '../mcp/client';
import { getDataPath } from '../config/data_path';

const SKILLS_DIR_PATH = SKILLS_DIR;
const SKILL_DRAFTS_DIR = getDataPath('skill-drafts');

export interface SkillGenerateRequest {
  /** Natural language description of what the skill should do */
  description?: string;
  /** Existing workflows to learn from */
  workflows?: WorkflowRecord[];
  /** LLM provider to use */
  provider?: UserLLMProvider;
  model?: string;
  userId?: string;
}

export interface SkillGenerateResult {
  success: boolean;
  skillName?: string;
  toolName?: string;
  directory?: string;
  status?: 'draft';
  review?: GeneratedSkillDraftReview;
  error?: string;
  generatedCode?: string;
}

export interface GeneratedSkillDraftReview {
  status: 'draft';
  generatedAt: string;
  contentHash: string;
  permissions: string[];
  sideEffects: string[];
  risk: 'low' | 'medium' | 'high';
  evidence: {
    kind: 'mcp_tool_receipt';
    assurance: 'declared';
    limitations: string[];
  };
  staticCheck: {
    passed: boolean;
    findings: string[];
  };
  trialRun: {
    passed: boolean;
    note: string;
  };
  requiresUserApproval: true;
}

const GENERATE_PROMPT = `You are a Skill SDK generator for LumiCore. Your job is to create an MCP (Model Context Protocol) server tool with a fully implemented, executable handler function.

## Context
Lumi has learned a repeatable workflow by observing tool execution patterns. You need to encode this knowledge as a standalone MCP tool with REAL, EXECUTABLE code.

## Input
{inputDescription}

## Output Requirements
Output ONLY a JSON object with these fields:

{
  "skillName": "lowercase-kebab-case-name",
  "toolName": "snake_case_tool_name",
  "toolDescription": "1-2 sentence description of what this tool does",
  "inputSchema": {
    "type": "object",
    "properties": {
      "paramName": { "type": "string", "description": "what this param is" }
    },
    "required": ["paramName"]
  },
  "handlerCode": "The COMPLETE TypeScript body of the handler function. Write the code that goes INSIDE the async function body (NOT the function signature - just the body lines). You MUST set a variable named 'result' with the output string. Always wrap logic in try/catch, setting result to the error message on failure. The function has access to 'args' (Record<string, any>) with the destructured parameters. Use fetch() for HTTP calls, fs (imported as 'fs/promises') for file ops. Example:\\n  const {{ url }} = args;\\n  try {\\n    const response = await fetch(url);\\n    const data = await response.text();\\n    result = data.slice(0, 2000);\\n  } catch (e) {\\n    result = 'Error: ' + e.message;\\n  }",
  "permissions": ["network", "filesystem:read"],
  "sideEffects": ["Describe every file write, external request, message, publication, process launch, or other side effect. Use an empty array for a read-only tool."],
  "risk": "low|medium|high",
  "readme": "Markdown documentation: what the skill does, usage example, parameters, output format"
}

## Guidelines
- The skillName should be short and descriptive (max 3 words, kebab-case)
- If the workflow involves web APIs, describe the exact endpoints and parameters in the handlerCode
- If using file operations, use 'fs/promises' (already imported) and specify file paths
- handlerCode MUST be real executable TypeScript, not a description. It runs in a Node.js child process.
- Keep inputSchema focused: only parameters that change between invocations
- Do not use child_process, shell commands, eval, Function, dynamic import, process.env, or hidden nested tool execution
- Declare every required permission and every side effect; generated skills are reviewed drafts and are never installed automatically
- Always set 'result' to a string before the function returns
- For async operations, use 'await' — the handler is an async function
- Do NOT include 'import' statements or 'export' — those are added automatically

JSON output:`;

const SKILL_TEMPLATE = `/**
 * Auto-generated Lumi Skill: {skillName}
 * Generated at: {timestamp}
 * Generator: Lumi Skill SDK
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'module';
import { z } from 'zod';
import fs from 'fs/promises';

const require = createRequire(import.meta.url);

// ── Generated Handler ──
{handlerCode}

// ── Schema (generated) ──
const inputSchema = {inputSchema};

// ── MCP Server Entry ──
async function main() {
  const server = new McpServer(
    { name: '{skillName}', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    '{toolName}',
    {
      description: '{toolDescription}',
      inputSchema,
    },
    handler
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Lumi Skill] {skillName} ready');
}

main().catch((err) => {
  console.error('[Lumi Skill] Fatal:', err);
  process.exit(1);
});
`;

const PACKAGE_TEMPLATE = `{
  "name": "lumi-skill-{skillName}",
  "version": "1.0.0",
  "description": "{toolDescription}",
  "type": "module",
  "main": "index.ts",
  "scripts": {
    "start": "npx tsx index.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.22.0"
  },
  "lumi": {
    "autoGenerated": true,
    "status": "draft",
    "skillName": "{skillName}",
    "generatedFrom": "{generatedFrom}",
    "installedAt": "{installedAt}",
    "toolCount": 1,
    "draftReview": {draftReview}
  }
}
`;

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

  const prompt = GENERATE_PROMPT.replace('{inputDescription}', inputDescription);

  const messages: NormalizedMessage[] = [
    { role: 'user', content: prompt },
  ];

  const preferred = getScopedPreferredLLM(request.userId || 'skill_gen');
  const provider = request.provider || preferred.provider;
  const model = request.model || preferred.model;
  const explicitModelOverride = Boolean(request.provider || request.model);
  const routeConfig = {
    provider,
    model,
    userId: request.userId || 'skill_gen',
    selectionMode: explicitModelOverride ? 'pinned' as const : preferred.selectionMode,
    fallbackCandidates: explicitModelOverride ? [] : preferred.fallbackCandidates,
    allowCloudFallback: explicitModelOverride ? false : preferred.allowCloudFallback,
    source: 'skill_generator',
  };
  let generatedSkillStagingDir = '';

  try {
    const response = await makeLLMCall(
      messages,
      [],
      { ...routeConfig, maxTokens: 2048 },
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
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: 'LLM did not return valid JSON', generatedCode: text };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.skillName || !parsed.toolName) {
      return { success: false, error: 'Missing skillName or toolName in generated output', generatedCode: text };
    }

    if (!parsed.handlerCode || typeof parsed.handlerCode !== 'string' || parsed.handlerCode.trim().length === 0) {
      // If LLM returned old field name (handlerLogic), retry with explicit conversion prompt
      if (parsed.handlerLogic && typeof parsed.handlerLogic === 'string') {
        console.warn('[SkillGen] LLM returned handlerLogic instead of handlerCode — retrying with conversion prompt');
        const conversionMessages: NormalizedMessage[] = [
          { role: 'user', content: `Turn this handler logic description into a TypeScript body for an async function handler(args). The function sets a variable named "result" to the output string. Use try/catch. You have access to 'args' (Record<string, any>), fetch(), and 'fs/promises' (imported as 'fs').\n\nLogic:\n${parsed.handlerLogic}\n\nReturn ONLY a JSON object: {"handlerCode": "// the executable code here"}` },
        ];
        try {
          const convResponse = await makeLLMCall(
            conversionMessages, [],
            { ...routeConfig, maxTokens: 2048 },
            getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
            getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
          );
          const convText = convResponse.text || '';
          const convJson = convText.match(/\{[\s\S]*\}/);
          if (convJson) {
            const convParsed = JSON.parse(convJson[0]);
            if (convParsed.handlerCode && typeof convParsed.handlerCode === 'string') {
              parsed.handlerCode = convParsed.handlerCode;
              console.log('[SkillGen] Successfully converted handlerLogic → handlerCode');
            }
          }
        } catch (e: any) {
          console.warn('[SkillGen] handlerLogic conversion retry failed:', e.message);
        }
      }

      // If still no handlerCode after retry, fail
      if (!parsed.handlerCode || typeof parsed.handlerCode !== 'string' || parsed.handlerCode.trim().length === 0) {
        return { success: false, error: 'LLM did not return handlerCode', generatedCode: text };
      }
    }

    // Build the skill draft. Generated code never enters the active skill
    // directory and is never registered with MCP from this function.
    const skillName = parsed.skillName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const installedSkillDir = path.join(SKILLS_DIR_PATH, skillName);
    if (fs.existsSync(installedSkillDir) || mcpManager.getConfig()[skillName]) {
      return { success: false, error: `Skill "${skillName}" is already installed. Remove it before generating a replacement draft.`, directory: installedSkillDir };
    }
    generatedSkillStagingDir = path.join(os.tmpdir(), `lumi-skill-generate-${skillName}-${process.pid}-${Date.now()}`);
    const skillDir = generatedSkillStagingDir;

    const generatedFrom = request.workflows
      ? request.workflows.map(w => w.id).join(',')
      : 'manual';

    const now = new Date().toISOString();

    // Build the executable handler function from LLM-generated code
    const handlerCode = buildHandlerFunction(parsed.handlerCode, parsed.inputSchema);

    // Build the input schema as a Zod-compatible object literal for the template
    const schemaLiteral = buildSchemaLiteral(parsed.inputSchema);

    // Fill templates
    let indexTs = SKILL_TEMPLATE
      .replace(/{skillName}/g, skillName)
      .replace(/{toolName}/g, parsed.toolName)
      .replace(/{toolDescription}/g, escapeTsSingleQuoted(parsed.toolDescription || parsed.toolName))
      .replace(/{timestamp}/g, now)
      .replace('{handlerCode}', handlerCode)
      .replace('{inputSchema}', schemaLiteral);

    let review = buildGeneratedSkillDraftReview({
      source: indexTs,
      generatedAt: now,
      declaredPermissions: parsed.permissions,
      declaredSideEffects: parsed.sideEffects,
      declaredRisk: parsed.risk,
      trialPassed: false,
    });
    if (!review.staticCheck.passed) {
      return {
        success: false,
        skillName,
        toolName: parsed.toolName,
        generatedCode: indexTs,
        error: `Static skill review failed: ${review.staticCheck.findings.join(' | ')}`,
      };
    }
    let packageJson = buildDraftPackageJson({
      skillName,
      toolDescription: parsed.toolDescription || '',
      generatedFrom,
      generatedAt: now,
      review,
    });

    const readme = (parsed.readme || `# ${skillName}\n\n${parsed.toolDescription}`);

    // Write files
    if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'package.json'), packageJson);
    fs.writeFileSync(path.join(skillDir, 'index.ts'), indexTs);
    fs.writeFileSync(path.join(skillDir, 'README.md'), readme);

    console.log(`[SkillGen] Generated skill "${skillName}" at ${skillDir}`);

    let warnings: string[] = [];

    // Install dependencies so the skill can actually run
    try {
      await installSkillDeps(skillDir);
      console.log(`[SkillGen] Dependencies installed for "${skillName}"`);
    } catch (e: any) {
      console.warn(`[SkillGen] npm install failed for "${skillName}":`, e.message);
      warnings.push(`npm install failed: ${e.message}`);
    }

    // Runtime smoke test — verify the process can start
    let runtimeCheck = await validateSkillRuntime(skillDir);
    if (!runtimeCheck.valid) {
      console.warn(`[SkillGen] Runtime check failed for "${skillName}":`, runtimeCheck.error);
      warnings.push(`Runtime check failed: ${runtimeCheck.error}`);
    }

    // Validate TypeScript compilation
    let validation = await validateSkillTypeScript(skillDir);

    if (!validation.valid) {
      console.warn(`[SkillGen] Type-check failed for "${skillName}", retrying with error feedback...`);
      warnings.push(`First attempt type errors: ${validation.errors.slice(0, 500)}`);

      // Retry: feed errors back to LLM
      const retryPrompt = `Fix the TypeScript errors in this handler code.

## Original description
${inputDescription}

## Errored handler code
${parsed.handlerCode}

## TypeScript errors
${validation.errors}

Return ONLY a JSON object with "handlerCode" (the fixed code body).`;

      try {
        const retryMessages: NormalizedMessage[] = [
          { role: 'user', content: retryPrompt },
        ];
        const retryResponse = await makeLLMCall(
          retryMessages, [],
          { ...routeConfig, maxTokens: 2048 },
          getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
          getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
        );

        const retryText = retryResponse.text || '';
        const retryJson = retryText.match(/\{[\s\S]*\}/);
        if (retryJson) {
          const retryParsed = JSON.parse(retryJson[0]);
          const fixedCode = retryParsed.handlerCode;
          if (fixedCode && typeof fixedCode === 'string') {
            const fixedHandler = buildHandlerFunction(fixedCode, parsed.inputSchema);
            const fixedIndexTs = SKILL_TEMPLATE
              .replace(/{skillName}/g, skillName)
              .replace(/{toolName}/g, parsed.toolName)
              .replace(/{toolDescription}/g, escapeTsSingleQuoted(parsed.toolDescription || parsed.toolName))
              .replace(/{timestamp}/g, now)
              .replace('{handlerCode}', fixedHandler)
              .replace('{inputSchema}', schemaLiteral);

            fs.writeFileSync(path.join(skillDir, 'index.ts'), fixedIndexTs);

            validation = await validateSkillTypeScript(skillDir);
            if (validation.valid) {
              console.log(`[SkillGen] Type-check passed after retry for "${skillName}"`);
              warnings = [];
              // Use the fixed code in the return
              indexTs = fixedIndexTs;

              // Install deps for the corrected skill
              try {
                await installSkillDeps(skillDir);
              } catch (e: any) {
                console.warn(`[SkillGen] npm install failed after retry for "${skillName}":`, e.message);
                warnings.push(`npm install failed: ${e.message}`);
              }

              // Runtime smoke test on the fixed code
              runtimeCheck = await validateSkillRuntime(skillDir);
              if (!runtimeCheck.valid) {
                warnings.push(`Runtime check after retry: ${runtimeCheck.error}`);
              }
            } else {
              warnings.push(`Retry still failing: ${validation.errors.slice(0, 300)}`);
              console.warn(`[SkillGen] Type-check still failing after retry for "${skillName}":`, validation.errors.slice(0, 200));
            }
          }
        }
      } catch (retryErr: any) {
        warnings.push(`Retry failed: ${retryErr.message}`);
      }
    }

    if (warnings.length > 0) {
      return {
        success: false,
        skillName,
        toolName: parsed.toolName,
        generatedCode: indexTs,
        error: warnings.join(' | '),
      };
    }

    review = buildGeneratedSkillDraftReview({
      source: indexTs,
      generatedAt: now,
      declaredPermissions: parsed.permissions,
      declaredSideEffects: parsed.sideEffects,
      declaredRisk: parsed.risk,
      trialPassed: runtimeCheck.valid,
    });
    if (!review.staticCheck.passed || !review.trialRun.passed) {
      return {
        success: false,
        skillName,
        toolName: parsed.toolName,
        generatedCode: indexTs,
        error: [
          ...review.staticCheck.findings,
          ...(review.trialRun.passed ? [] : [review.trialRun.note]),
        ].join(' | '),
      };
    }
    packageJson = buildDraftPackageJson({
      skillName,
      toolDescription: parsed.toolDescription || '',
      generatedFrom,
      generatedAt: now,
      review,
    });
    fs.writeFileSync(path.join(skillDir, 'package.json'), packageJson);

    const draftDir = allocateDraftDirectory(skillName, now);
    fs.mkdirSync(path.dirname(draftDir), { recursive: true });
    fs.renameSync(skillDir, draftDir);
    generatedSkillStagingDir = '';

    return {
      success: true,
      skillName,
      toolName: parsed.toolName,
      directory: draftDir,
      status: 'draft',
      review,
      generatedCode: indexTs,
    };
  } catch (err: any) {
    console.error('[SkillGen] Generation failed:', err);
    return { success: false, error: err.message };
  } finally {
    if (generatedSkillStagingDir) {
      try { fs.rmSync(generatedSkillStagingDir, { recursive: true, force: true }); } catch {}
    }
  }
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value.map(item => String(item || '').trim()).filter(Boolean),
  )).sort((left, right) => left.localeCompare(right));
}

function sourceHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function inspectGeneratedSkillSource(source: string): {
  permissions: string[];
  sideEffects: string[];
  risk: GeneratedSkillDraftReview['risk'];
  findings: string[];
} {
  const permissions = new Set<string>();
  const sideEffects = new Set<string>();
  const findings: string[] = [];

  if (/\bfetch\s*\(/.test(source)) permissions.add('network');
  if (/\bfs\.(?:readFile|readdir|stat|access|open)\s*\(/.test(source)) permissions.add('filesystem:read');
  if (/\bfs\.(?:writeFile|appendFile|mkdir|copyFile|rename)\s*\(/.test(source)) {
    permissions.add('filesystem:write');
    sideEffects.add('Writes or changes local files.');
  }
  if (/\bfetch\s*\([^)]*,\s*\{[\s\S]{0,800}\bmethod\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i.test(source)) {
    sideEffects.add('Sends a state-changing external network request.');
  } else if (permissions.has('network')) {
    sideEffects.add('Connects to an external network service.');
  }

  const forbidden: Array<[RegExp, string]> = [
    [/\b(?:child_process|execFile|execSync|spawnSync|spawn)\b/, 'Shell and process execution are not allowed in generated skill drafts.'],
    [/\b(?:eval\s*\(|new\s+Function\s*\(|Function\s*\()/, 'Dynamic code evaluation is not allowed in generated skill drafts.'],
    [/\bimport\s*\(/, 'Dynamic imports are not allowed in generated skill drafts.'],
    [/\brequire\s*\(/, 'Runtime require() is not allowed in generated skill drafts.'],
    [/\bprocess\.env\b/, 'Generated skill drafts cannot read host environment secrets directly.'],
    [/\bfs\.(?:rm|rmdir|unlink|truncate)\s*\(/, 'Destructive filesystem operations are not allowed in generated skill drafts.'],
    [/\b(?:mcpManager|toolRegistry|executeToolCall|desktopRelay)\b/, 'Generated skills cannot hide nested Lumi tool execution.'],
  ];
  for (const [pattern, message] of forbidden) {
    if (pattern.test(source)) findings.push(message);
  }

  const risk: GeneratedSkillDraftReview['risk'] = sideEffects.size > 0
    ? (permissions.has('filesystem:write') || /state-changing external/.test([...sideEffects].join(' ')) ? 'high' : 'medium')
    : permissions.size > 0
      ? 'medium'
      : 'low';

  return {
    permissions: [...permissions].sort((left, right) => left.localeCompare(right)),
    sideEffects: [...sideEffects].sort((left, right) => left.localeCompare(right)),
    risk,
    findings,
  };
}

function normalizeRisk(
  declared: unknown,
  inferred: GeneratedSkillDraftReview['risk'],
): GeneratedSkillDraftReview['risk'] {
  const ranks = { low: 0, medium: 1, high: 2 } as const;
  const requested = String(declared || '').toLowerCase() as keyof typeof ranks;
  if (!(requested in ranks)) return inferred;
  return ranks[requested] > ranks[inferred] ? requested : inferred;
}

function buildGeneratedSkillDraftReview(input: {
  source: string;
  generatedAt: string;
  declaredPermissions?: unknown;
  declaredSideEffects?: unknown;
  declaredRisk?: unknown;
  trialPassed: boolean;
}): GeneratedSkillDraftReview {
  const inspection = inspectGeneratedSkillSource(input.source);
  return {
    status: 'draft',
    generatedAt: input.generatedAt,
    contentHash: sourceHash(input.source),
    permissions: Array.from(new Set([
      ...normalizeStringList(input.declaredPermissions),
      ...inspection.permissions,
    ])).sort((left, right) => left.localeCompare(right)),
    sideEffects: Array.from(new Set([
      ...normalizeStringList(input.declaredSideEffects),
      ...inspection.sideEffects,
    ])).sort((left, right) => left.localeCompare(right)),
    risk: normalizeRisk(input.declaredRisk, inspection.risk),
    evidence: {
      kind: 'mcp_tool_receipt',
      assurance: 'declared',
      limitations: ['A successful MCP receipt proves the generated handler returned; domain outcome still requires task-level verification.'],
    },
    staticCheck: {
      passed: inspection.findings.length === 0,
      findings: inspection.findings,
    },
    trialRun: {
      passed: input.trialPassed,
      note: input.trialPassed
        ? 'The isolated MCP process started without a fatal startup error.'
        : 'The isolated MCP process has not passed its startup trial.',
    },
    requiresUserApproval: true,
  };
}

function buildDraftPackageJson(input: {
  skillName: string;
  toolDescription: string;
  generatedFrom: string;
  generatedAt: string;
  review: GeneratedSkillDraftReview;
}): string {
  return PACKAGE_TEMPLATE
    .replace(/{skillName}/g, input.skillName)
    .replace(/{toolDescription}/g, escapeJsonString(input.toolDescription))
    .replace(/{generatedFrom}/g, escapeJsonString(input.generatedFrom))
    .replace(/{installedAt}/g, input.generatedAt)
    .replace('{draftReview}', JSON.stringify(input.review));
}

function allocateDraftDirectory(skillName: string, generatedAt: string): string {
  const suffix = generatedAt.replace(/[:.]/g, '-');
  const preferred = path.join(SKILL_DRAFTS_DIR, `${skillName}-${suffix}`);
  if (!fs.existsSync(preferred)) return preferred;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${preferred}-${index}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Unable to allocate a draft directory for "${skillName}".`);
}

export function readGeneratedSkillDraft(directory: string): {
  skillName: string;
  review: GeneratedSkillDraftReview;
} | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (pkg?.lumi?.autoGenerated !== true || pkg?.lumi?.status !== 'draft') return null;
    const skillName = String(pkg?.lumi?.skillName || '').trim();
    const review = pkg?.lumi?.draftReview as GeneratedSkillDraftReview;
    if (!skillName || !review || review.status !== 'draft') return null;
    return { skillName, review };
  } catch {
    return null;
  }
}

export async function validateGeneratedSkillDraftForInstall(directory: string): Promise<{
  valid: boolean;
  skillName?: string;
  review?: GeneratedSkillDraftReview;
  errors: string[];
}> {
  const draft = readGeneratedSkillDraft(directory);
  if (!draft) return { valid: false, errors: ['The directory is not a generated Lumi skill draft.'] };
  const indexPath = path.join(directory, 'index.ts');
  if (!fs.existsSync(indexPath)) return { valid: false, errors: ['The generated draft is missing index.ts.'] };

  const source = fs.readFileSync(indexPath, 'utf8');
  const current = buildGeneratedSkillDraftReview({
    source,
    generatedAt: draft.review.generatedAt,
    declaredPermissions: draft.review.permissions,
    declaredSideEffects: draft.review.sideEffects,
    declaredRisk: draft.review.risk,
    trialPassed: false,
  });
  const errors = [...current.staticCheck.findings];
  if (current.contentHash !== draft.review.contentHash) {
    errors.push('The generated draft changed after review; generate or review it again before installation.');
  }

  const typeCheck = await validateSkillTypeScript(directory);
  if (!typeCheck.valid) errors.push(`TypeScript validation failed: ${typeCheck.errors.slice(0, 1000)}`);
  const trial = errors.length === 0
    ? await validateSkillRuntime(directory)
    : { valid: false, error: 'Skipped because static or type validation failed.' };
  if (!trial.valid) errors.push(`Trial run failed: ${trial.error || 'unknown startup error'}`);

  return {
    valid: errors.length === 0,
    skillName: draft.skillName,
    review: {
      ...current,
      trialRun: {
        passed: trial.valid,
        note: trial.valid
          ? 'The isolated MCP process passed a fresh pre-install startup trial.'
          : String(trial.error || 'The isolated MCP process failed its pre-install startup trial.'),
      },
    },
    errors,
  };
}

// ── Validation ──

async function validateSkillTypeScript(skillDir: string): Promise<{ valid: boolean; errors: string }> {
  return new Promise((resolve) => {
    exec('npx tsc --noEmit', {
      timeout: 60000,
      maxBuffer: 512 * 1024,
      cwd: skillDir,
    }, (error, stdout, stderr) => {
      const output = (stdout + '\n' + stderr).trim();
      if (!error && !output) {
        resolve({ valid: true, errors: '' });
      } else {
        resolve({ valid: false, errors: output || error?.message || 'Unknown error' });
      }
    });
  });
}

/** Install npm dependencies in the skill directory so it can actually run */
async function installSkillDeps(skillDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec('npm install --loglevel=error --no-audit --no-fund', {
      timeout: 120000,
      maxBuffer: 512 * 1024,
      cwd: skillDir,
    }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve();
      }
    });
  });
}

/** Quick runtime smoke test: run the skill process briefly to verify it starts */
async function validateSkillRuntime(skillDir: string): Promise<{ valid: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = exec(
      'npx tsx index.ts',
      { timeout: 15000, cwd: skillDir, env: { ...process.env, LUMI_SKILL_SMOKE_TEST: '1' } },
      (_error, _stdout, stderr) => {
        // Process will exit quickly (or be killed) — success = no fatal crash
        const output = `${_stdout || ''}\n${stderr || ''}`;
        const fatalPatterns = [
          'ERR_MODULE_NOT_FOUND',
          'Cannot find package',
          'SyntaxError',
          'TypeError:',
          'Transform failed',
          'TransformError',
          'has already been declared',
          'Unexpected token',
        ];
        const hasFatal = fatalPatterns.some(p => output.includes(p));
        if (hasFatal) {
          resolve({ valid: false, error: output.slice(0, 800) });
        } else {
          resolve({ valid: true });
        }
      },
    );
    // Kill after 5s — if it hasn't crashed by then, it successfully loaded
    setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ valid: true });
    }, 5000);
  });
}

// ── Helpers ──

function topTools(steps: WorkflowStep[]): { name: string; count: number }[] {
  const counts: Record<string, number> = {};
  for (const s of steps) {
    counts[s.name] = (counts[s.name] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));
}

function buildHandlerFunction(handlerCode: string, inputSchema: any): string {
  const props = inputSchema?.properties || {};
  const paramNames = Object.keys(props);

  const destructure = paramNames.length > 0
    ? `  const { ${paramNames.join(', ')} } = args;`
    : '  // No parameters defined';

  // Indent the LLM-generated body code to match the function body
  const sanitizedBody = sanitizeHandlerBody(handlerCode, paramNames);

  const indentedBody = sanitizedBody
    .split('\n')
    .map(line => line.trim() ? `  ${line}` : '')
    .join('\n');

  return `async function handler(args: Record<string, any>): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
${destructure}
  let result = '';

  // ── Generated implementation ──
${indentedBody}

  return {
    content: [{ type: 'text', text: result }],
  };
}`;
}

function sanitizeHandlerBody(handlerCode: string, paramNames: string[]): string {
  const duplicateDestructure = paramNames.length
    ? new RegExp(`^\\s*const\\s*\\{\\s*${paramNames.map(escapeRegExp).join('\\s*,\\s*')}\\s*\\}\\s*=\\s*args\\s*;\\s*$`)
    : null;

  return String(handlerCode || '')
    .replace(/^```(?:ts|typescript|js|javascript)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .split('\n')
    .filter(line => !duplicateDestructure?.test(line))
    .map(line => {
      const trimmed = line.trim();
      if (/^return\s+result\s*;?$/.test(trimmed)) return '';
      const valueReturn = trimmed.match(/^return\s+(.+);$/);
      if (valueReturn && !trimmed.includes('content:')) {
        const indent = line.match(/^\s*/)?.[0] || '';
        return `${indent}result = String(${valueReturn[1]});\n${indent}return { content: [{ type: 'text', text: result }] };`;
      }
      return line;
    })
    .join('\n')
    .trim();
}

function buildSchemaLiteral(schema: any): string {
  if (!schema || !schema.properties) {
    return '{ type: "object", properties: {}, required: [] }';
  }

  const props = schema.properties || {};
  const required = schema.required || [];

  const propEntries = Object.entries(props).map(([key, prop]: [string, any]) => {
    return `  ${key}: ${mapJsonTypeToZod(prop)}${prop.description ? `.describe('${prop.description.replace(/'/g, "\\'")}')` : ''}`;
  });

  if (propEntries.length === 0) {
    return `z.object({})`;
  }

  return `z.object({\n${propEntries.join(',\n')}\n})`;
}

function mapJsonTypeToZod(prop: any): string {
  const jsonType = prop?.type || 'string';
  switch (jsonType) {
    case 'string': return 'z.string()';
    case 'number': return 'z.number()';
    case 'integer': return 'z.number()';
    case 'boolean': return 'z.boolean()';
    case 'array': return 'z.array(z.any())';
    case 'object': return 'z.record(z.any())';
    default: return 'z.string()';
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeTsSingleQuoted(value: string): string {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapeJsonString(value: string): string {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
