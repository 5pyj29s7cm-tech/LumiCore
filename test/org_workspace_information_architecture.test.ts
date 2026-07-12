import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

function source(file: string) {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8');
}

describe('organization workspace information architecture', () => {
  it('keeps legal case creation and deletion separate from the case workflow', () => {
    const legalHub = source('src/components/org/LegalHub.tsx');
    const routes = source('server/org/routes.ts');

    expect(legalHub).toContain('LegalCaseCreateDialog');
    expect(legalHub).toContain('LegalCaseDeleteDialog');
    expect(legalHub).toContain("method: 'DELETE'");
    expect(legalHub).toContain('setActiveLegalCaseId(id)');
    expect(legalHub).not.toContain('text-white/25 opacity-0');
    expect(legalHub).not.toContain('Case Action Board');
    expect(legalHub).not.toContain('案件行动面板');
    expect(routes).toContain("router.delete('/org/legal/cases/:caseId'");
    expect(routes).toContain("requireOrgRole('owner', 'admin')");
  });

  it('separates spatial architecture from brand creative work', () => {
    const orgHub = source('src/components/org/OrgHub.tsx');
    const designHub = source('src/components/org/DesignHub.tsx');

    expect(orgHub).toContain("id: 'spatial-design'");
    expect(orgHub).toContain("id: 'brand-design'");
    expect(orgHub).toContain('<DesignHub workspace="spatial" />');
    expect(orgHub).toContain('<DesignHub workspace="brand" />');
    expect(designHub).toContain("new Set<DesignView>(['space', 'interior', 'architecture'])");
  });

  it('combines template review with the marketplace and hides duplicate dashboard destinations from navigation', () => {
    const orgHub = source('src/components/org/OrgHub.tsx');
    const templateWorkspace = source('src/components/org/AgentTemplateWorkspace.tsx');

    for (const id of ['kb', 'chat', 'templates', 'members']) {
      expect(orgHub).toContain(`id: '${id}'`);
    }
    expect(orgHub.match(/showInNav: false/g)?.length).toBeGreaterThanOrEqual(5);
    expect(orgHub).toContain("case 'templates': return <AgentTemplateWorkspace />");
    expect(orgHub).toContain('initialTab="review"');
    expect(templateWorkspace).toContain('<TemplateMarketplace />');
    expect(templateWorkspace).toContain('<TemplateReviewQueue />');
  });

  it('combines organization settings with branch connection without duplicating the branch navigation item', () => {
    const orgHub = source('src/components/org/OrgHub.tsx');
    const settingsWorkspace = source('src/components/org/OrganizationSettingsWorkspace.tsx');
    const branchPanel = source('src/components/OrgBranchPanel.tsx');

    expect(orgHub).toContain("case 'settings': return <OrganizationSettingsWorkspace />");
    expect(orgHub).toContain('initialTab="branch"');
    expect(orgHub).toContain("id: 'branch'");
    expect(settingsWorkspace).toContain('<OrgSettings />');
    expect(settingsWorkspace).toContain('<OrgBranchPanel />');
    expect(settingsWorkspace).toContain("type OrganizationSettingsTab = 'general' | 'branch'");
    expect(branchPanel).toContain("ui('分支连接', 'Branch Connection')");
    expect(branchPanel).not.toContain("ui('分支终端', 'Branch Terminal')");
  });

  it('reports exact organization views and preserves routed destinations until the workspace mounts', () => {
    const orgHub = source('src/components/org/OrgHub.tsx');
    const desktop = source('src/components/DesktopUI.tsx');
    const navigation = source('src/lib/orgWorkspaceNavigation.ts');
    const contract = source('shared/org_workspace.ts');

    expect(orgHub).toContain('takePendingOrganizationWorkspaceRoute');
    expect(orgHub).toContain("'lumi:org-view-changed'");
    expect(orgHub).toContain('canAccessOrganizationWorkspaceView');
    expect(desktop).toContain('queueOrganizationWorkspaceRoute');
    expect(desktop).toContain('organizationWorkspaceView');
    expect(desktop).toContain('availableOrganizationWorkspaceViews');
    expect(contract).toContain("'spatial-design'");
    expect(contract).toContain("'brand-design'");
    expect(navigation).toContain('sessionStorage');
  });

  it('reports post-ingestion health to the same current-workspace Lumi', () => {
    const desktop = source('src/components/DesktopUI.tsx');
    const editor = source('src/components/org/KnowledgeBaseEditor.tsx');
    const selfModel = source('server/client/self_model.ts');

    expect(desktop).toContain("'/api/org/kb/stats'");
    expect(desktop).toContain('indexedFiles');
    expect(desktop).toContain('partialFiles');
    expect(desktop).toContain('pendingFiles');
    expect(desktop).toContain("'lumi:knowledge-updated'");
    expect(editor).toContain("'organization-knowledge-editor'");
    expect(selfModel).toContain('A saved upload is not automatically fully usable');
    expect(selfModel).toContain('orgMissingIndex');
  });

  it('gives legal tools a shared current-case and execution-state context', () => {
    const legalHub = source('src/components/org/LegalHub.tsx');
    const contextBar = source('src/components/org/LegalCaseContextBar.tsx');
    const toolClient = source('src/lib/legalToolClient.ts');

    expect(legalHub).toContain('<LegalCaseContextBar');
    expect(contextBar).toContain("export type LegalToolState = 'input' | 'running' | 'result'");
    expect(contextBar).toContain("ui('当前案件', 'Current case')");
    expect(contextBar).toContain("ui('已结案', 'Closed')");
    expect(toolClient).toContain("'lumi:org-legal-cases-changed'");
  });
});
