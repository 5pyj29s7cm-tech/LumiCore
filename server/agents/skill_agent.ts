/**
 * Auto-create a team agent when a skill is installed.
 *
 * Layer 1 of the two-layer design:
 *   Skill install → team agent created → Lumi can dispatch tasks to it
 *
 * Each installed skill becomes a named agent visible in the Skill Hall team tab.
 * The orchestrator's matchWorkers() finds them by skillTag overlap.
 */

import { readDB, writeDB } from "../../db_layer";
import crypto from 'crypto';

export function createAgentForSkill(
  skillName: string,
  skillInfo: {
    description?: string;
    category?: string;
    toolCount?: number;
    skillTags?: string[];
    installSource?: string;
    runtime?: 'internal' | 'external';
    externalCommand?: string;
    externalRuntimeAuthorized?: boolean;
    scope?: {
      ownerUid?: string;
      userId?: string;
      domain?: string;
      orgId?: string;
    };
  },
  io?: { emit: (event: string, data: any) => void },
): string | null {
  try {
    const db = readDB();
    if (!db.agents) db.agents = [];

    const category = mapCategory(skillInfo.category || 'general');
    const description = skillInfo.description || `Auto-generated agent for skill: ${skillName}`;
    const runtime = skillInfo.runtime || 'internal';
    const externalCommand = skillInfo.externalCommand;
    if (runtime === 'external' && skillInfo.externalRuntimeAuthorized !== true) {
      throw new Error('External skill agents require explicit local-administrator runtime authorization.');
    }
    const baseAgentId = `skill_${skillName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    const agentId = scopedAgentId(baseAgentId, skillInfo.scope);
    const tags = Array.from(new Set([
      ...(skillInfo.skillTags || []),
      skillName.toLowerCase(),
      category,
      ...(runtime === 'external' ? ['external', 'cli'] : []),
    ].map(tag => String(tag || '').trim()).filter(Boolean)));
    const now = new Date().toISOString();

    const existing = db.agents.find((a: any) =>
      (a.id === agentId || a.id === baseAgentId) && agentMatchesScope(a, skillInfo.scope),
    );
    if (existing) {
      let changed = false;
      if (runtime === 'external') {
        existing.externalRuntimeAuthorizedAt = now;
        if (existing.runtime !== 'external') {
          existing.runtime = 'external';
          changed = true;
        }
        if (!existing.healthStatus) {
          existing.healthStatus = 'untested';
          changed = true;
        }
        if (externalCommand && existing.externalCommand !== externalCommand) {
          existing.externalCommand = externalCommand;
          changed = true;
        }
      }
      const existingTags = Array.isArray(existing.skillTags)
        ? existing.skillTags
        : String(existing.skillTags || '').split(',').map(tag => tag.trim()).filter(Boolean);
      const mergedTags = Array.from(new Set([...existingTags, ...tags]));
      if (mergedTags.length !== existingTags.length) {
        existing.skillTags = mergedTags;
        changed = true;
      }
      if (changed) {
        writeDB(db);
        io?.emit('agent:created', { id: existing.id, name: skillName, skillTags: mergedTags, runtime: existing.runtime, healthStatus: existing.healthStatus });
      }
      return existing.id;
    }

    db.agents.push({
      id: agentId,
      name: skillName,
      category,
      config: JSON.stringify({
        description,
        installSource: skillInfo.installSource || 'marketplace',
        teamSource: 'skill_hall',
        runtime,
        ...(externalCommand ? { externalCommand } : {}),
      }),
      data: '{}',
      createdAt: now,
      lastActiveAt: now,
      status: 'active',
      personalityId: 'lumi',
      modelPreference: '',
      memoryScope: 'shared',
      autonomyLevel: 'reactive',
      runtimeConfig: JSON.stringify({
        source: 'skill_hall',
        connectionType: runtime === 'external' ? 'cli' : 'mcp',
      }),
      skillTags: tags,
      executionMode: 'lumi',
      allowCrossPollination: true,
      territory: 'open',
      runtime,
      healthStatus: runtime === 'external' ? 'untested' : 'online',
      ...(externalCommand ? { externalCommand } : {}),
      ...(runtime === 'external' ? { externalRuntimeAuthorizedAt: now } : {}),
      ...(skillInfo.scope?.ownerUid ? { ownerUid: skillInfo.scope.ownerUid, userId: skillInfo.scope.userId || skillInfo.scope.ownerUid } : {}),
      ...(skillInfo.scope?.domain ? { domain: skillInfo.scope.domain, orgId: skillInfo.scope.orgId || '' } : {}),
      autoCreated: true,
    });

    writeDB(db);
    console.log(`[SkillAgent] Created team agent for skill "${skillName}" (id: ${agentId}, tags: ${tags.join(', ')})`);
    io?.emit('agent:created', {
      id: agentId,
      name: skillName,
      skillTags: tags,
      runtime,
      healthStatus: runtime === 'external' ? 'untested' : 'online',
      externalCommand,
    });
    return agentId;
  } catch (err) {
    console.warn(`[SkillAgent] Failed to create agent for "${skillName}":`, (err as Error).message);
    return null;
  }
}

function scopedAgentId(baseId: string, scope?: { ownerUid?: string; domain?: string; orgId?: string }): string {
  if (scope?.domain === 'work' && scope.orgId) {
    return `${baseId}_org-${scopeHash(scope.orgId)}`;
  }
  if (scope?.ownerUid) return `${baseId}_user-${scopeHash(scope.ownerUid)}`;
  return baseId;
}

function scopeHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function agentMatchesScope(agent: any, scope?: { ownerUid?: string; domain?: string; orgId?: string }): boolean {
  if (!scope) return true;
  if (scope.domain === 'work') {
    return (agent.orgId || '') === (scope.orgId || '') && (agent.domain || 'work') === 'work';
  }
  if (agent.orgId || agent.domain === 'work') return false;
  return scope.ownerUid ? agent.ownerUid === scope.ownerUid : !agent.ownerUid;
}

/** Map marketplace categories to orchestrator categories */
function mapCategory(cat: string): string {
  const lower = cat.toLowerCase();
  if (lower.includes('code') || lower.includes('dev') || lower.includes('programming')) return 'code';
  if (lower.includes('content') || lower.includes('writing') || lower.includes('media')) return 'content';
  if (lower.includes('analysis') || lower.includes('data') || lower.includes('research')) return 'analysis';
  if (lower.includes('search') || lower.includes('web') || lower.includes('fetch')) return 'search';
  if (lower.includes('automation') || lower.includes('desktop')) return 'automation';
  if (lower.includes('image') || lower.includes('video') || lower.includes('audio') || lower.includes('creative')) return 'media';
  return 'general';
}
