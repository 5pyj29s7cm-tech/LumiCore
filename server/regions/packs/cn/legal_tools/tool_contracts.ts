import { withLegalExecution, assertLegalExecutionActive } from '../../../../legal/execution';
import * as LegalCases from "../../../../org/legal_cases";
import * as EDB from "../../../../org/db";
import path from "path";
import fs from "fs";
import { encodeToolResult } from "../../../../tools/result_envelope";
import { type CapabilityOperation, type CapabilityRisk, type CapabilitySideEffect, type ToolDefinition } from "../../../../tools/types";
import { capabilityContract, capabilityEvidence } from "../../../../tools/capability_contracts";
import { expandLocalPath, textArg, legalWorkspaceId } from "./context";

type LegalToolHandler = (args: Record<string, any>, context?: any) => Promise<string>;

interface LegalReceiptProfile {
  status: string;
  expectCaseMutation?: 'always' | 'when_requested' | 'when_case_id';
  requireArtifacts?: boolean | ((args: Record<string, any>) => boolean);
  requireArticleMutation?: boolean;
  classify?: (content: string, args: Record<string, any>) => { ok: boolean; status: string };
}

function legalCaseSnapshot(orgId: string, userId?: string): Map<string, string> {
  return new Map(LegalCases.listCases(orgId, '', 200, userId).map(caseFile => [
    caseFile.id,
    JSON.stringify({
      updatedAt: caseFile.updatedAt,
      title: caseFile.title,
      stage: caseFile.stage,
      materials: caseFile.materials.map(material => [material.id, material.createdAt, material.localPath]),
    }),
  ]));
}

function changedLegalCaseIds(before: Map<string, string>, after: Map<string, string>): string[] {
  return Array.from(after.entries())
    .filter(([id, fingerprint]) => before.get(id) !== fingerprint)
    .map(([id]) => id);
}

function legalArticleIds(orgId: string): Set<string> {
  return new Set(EDB.listKbArticles(orgId).map(article => article.id));
}

function existingLegalOutputPaths(content: string): string[] {
  const paths = new Set<string>();
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s*/, '');
    const separator = Math.max(line.indexOf('：'), line.indexOf(': '));
    if (separator < 0) continue;
    const candidate = line.slice(separator + (line[separator] === '：' ? 1 : 2)).trim().replace(/^`|`$/g, '');
    if (!candidate || candidate.length > 1_000) continue;
    try {
      const resolved = path.resolve(expandLocalPath(candidate));
      if (fs.existsSync(resolved)) paths.add(resolved);
    } catch {}
  }
  return Array.from(paths);
}

export function legalInputBlocked(content: string): boolean {
  return /^(?:请提供|无法解析文件|链接格式无效|仅支持 http|出于安全原因)/.test(String(content || '').trim());
}

function shouldExpectCaseMutation(args: Record<string, any>, mode?: LegalReceiptProfile['expectCaseMutation']): boolean {
  if (!mode || args.persistCase === false) return false;
  if (mode === 'always') return true;
  if (mode === 'when_case_id') return Boolean(textArg(args, 'caseId'));
  return args.persistCase === true || Boolean(textArg(args, 'caseId') || textArg(args, 'caseName') || textArg(args, 'title'));
}

export function withLegalReceipt(handler: LegalToolHandler, profile: LegalReceiptProfile): LegalToolHandler {
  return async (args, context) => {
    const orgId = legalWorkspaceId(args, context);
    const userId = textArg(args, 'userId') || context?.userId || 'system';
    const beforeCases = legalCaseSnapshot(orgId, userId);
    const beforeArticles = legalArticleIds(orgId);
    const content = await handler(args, context);
    const afterCases = legalCaseSnapshot(orgId, userId);
    const afterArticles = legalArticleIds(orgId);
    const changedCaseIds = changedLegalCaseIds(beforeCases, afterCases);
    const articleIds = Array.from(afterArticles).filter(id => !beforeArticles.has(id));
    const artifacts = existingLegalOutputPaths(content);
    const classified = profile.classify?.(content, args)
      || (legalInputBlocked(content) ? { ok: false, status: 'blocked' } : { ok: true, status: profile.status });
    const expectedCaseMutation = shouldExpectCaseMutation(args, profile.expectCaseMutation);
    if (classified.ok && expectedCaseMutation && changedCaseIds.length === 0) {
      throw new Error('Legal work product was not persisted to the requested case workspace.');
    }
    const requireArtifacts = typeof profile.requireArtifacts === 'function'
      ? profile.requireArtifacts(args)
      : profile.requireArtifacts === true;
    if (classified.ok && requireArtifacts && artifacts.length === 0) {
      throw new Error('Legal work product did not produce a verifiable local artifact.');
    }
    if (classified.ok && profile.requireArticleMutation && articleIds.length === 0) {
      throw new Error('Legal knowledge-base import did not persist an article.');
    }
    return encodeToolResult(content, {
      ok: classified.ok,
      status: classified.status,
      persisted: changedCaseIds.length > 0 || articleIds.length > 0,
      changedCaseIds,
      articleIds,
      artifacts,
      content,
    });
  };
}

export function legalCapability(input: {
  id: string;
  operation: Exclude<CapabilityOperation, 'unknown'>;
  risk: Exclude<CapabilityRisk, 'none'>;
  sideEffects: CapabilitySideEffect[];
  successStatuses: string[];
  requireArtifacts?: boolean;
  limitations?: string[];
}) {
  return capabilityContract({
    id: input.id,
    family: 'legal-workflow',
    lane: 'industry',
    operation: input.operation,
    risk: input.risk,
    sideEffects: input.sideEffects,
    verification: {
      strategy: input.requireArtifacts ? 'artifact' : 'terminal_receipt',
      required: true,
      requiredFields: ['ok', 'status', 'persisted', 'changedCaseIds', 'articleIds', 'artifacts', 'content'],
      requiredValues: { ok: true },
      successStatuses: input.successStatuses,
      failureStatuses: ['blocked', 'failed', 'unverified'],
      requiredArtifactCollections: input.requireArtifacts ? ['artifacts'] : undefined,
      successSignals: ['structured legal receipt reports case, knowledge-base, and file effects separately'],
      limitations: input.limitations || ['Generated legal work remains subject to lawyer review and is not automatically filed, signed, sent, or published.'],
    },
  });
}

export function legalEvidence(
  id: string,
  operation: Exclude<CapabilityOperation, 'unknown'>,
  subjectArgument?: string,
  limitations?: string[],
) {
  return capabilityEvidence({ id, operation, subjectArgument, limitations });
}

type LegalToolInput = Omit<ToolDefinition, 'parameters' | 'permission' | 'securityLevel'> & {
  properties: Record<string, any>; required?: string[];
};

/** Own the public schema and cancellation fence once for every legal tool. */
export function defineLegalTool({ properties, required, handler, ...definition }: LegalToolInput): ToolDefinition {
  return {
    ...definition, permission: 'user', securityLevel: 'safe',
    parameters: { type: 'object', properties: structuredClone(properties),
      ...(required === undefined ? {} : { required: [...required] }) },
    handler: (args, context) => withLegalExecution(context, async () => {
      assertLegalExecutionActive();
      const result = await handler(args, context);
      assertLegalExecutionActive();
      return result;
    }),
  };
}

export const stringField = (description: string) => ({ type: 'string', description });
export const numberField = (description: string) => ({ type: 'number', description });
export const booleanField = (description: string) => ({ type: 'boolean', description });
export const stringListField = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

export const CASE_ARCHIVE_FIELDS = {
  caseId: stringField('已有案件工作台 ID；提供后将工作产物归档到该案件空间'),
  caseName: stringField('案件、项目或工作空间名称'),
  caseType: stringField('案由或事项类型'),
  persistCase: booleanField('是否归档到案件空间；提供 caseId/caseName 时默认归档，设置 false 可关闭'),
  orgId: stringField('组织 ID，默认上下文 orgId 或 default'),
  userId: stringField('操作用户 ID，默认上下文 userId 或 system'),
};
