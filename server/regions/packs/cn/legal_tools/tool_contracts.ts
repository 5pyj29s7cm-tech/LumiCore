import { withLegalExecution, assertLegalExecutionActive, legalExecutionWrites } from '../../../../legal/execution';
import * as LegalCases from "../../../../org/legal_cases";
import path from "path";
import fs from "fs";
import { encodeToolResult } from "../../../../tools/result_envelope";
import { createHash } from "crypto";
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
    const content = await handler(args, context);
    const writes = legalExecutionWrites(orgId, userId);
    const changedCaseIds = [...writes.cases.keys()];
    const articleIds = [...writes.articles];
    const materialSources = changedCaseIds.flatMap(caseId => (LegalCases.getCase(orgId, caseId, userId)?.materials || [])
      .filter(material => writes.cases.get(caseId)?.has(material.id))
      .map(material => ({ caseId, materialId: material.id, sourceDigest: createHash('sha256').update(JSON.stringify([
        material.source, material.title, material.content, material.fileName || '', material.localPath || '',
      ])).digest('hex') })));
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
      materialSources,
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

/** Review inputs, never proof of applicability without an authoritative exact-text match. */
export const LEGAL_TEMPORAL_FIELDS = {
  factDate: stringField('案件关键事实发生日期（YYYY-MM-DD）；未知须待确认，不得用生成日期代替。'),
  procedureDate: stringField('相关程序行为发生日期（YYYY-MM-DD）；不得用实体事实日期代替。'),
  temporalReviews: {
    type: 'array',
    description: '与引用、案件时点和事实/程序范围绑定的时间效力复核；权威条文及连续原文必须通过来源核验，适用说明仍需律师复核。',
    items: {
      type: 'object',
      properties: {
        citation: stringField('本案拟适用的法条引用'),
        referenceDate: stringField('与 factDate 或 procedureDate 一致的 YYYY-MM-DD 时点'),
        scope: { type: 'string', enum: ['fact', 'procedure'], description: '对应实体事实或程序行为' },
        authorityCitation: stringField('说明时间效力规则的权威条文引用'),
        authorityQuote: stringField('该权威条文的连续原文摘录'),
        applicability: stringField('本案适用及例外的待复核说明；不是程序自动认定'),
      },
      required: ['citation', 'referenceDate', 'scope', 'authorityCitation', 'authorityQuote', 'applicability'],
    },
  },
};
