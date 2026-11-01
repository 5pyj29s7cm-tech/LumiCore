import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCurrentFormalVariantAcceptanceManifest, validateFormalVariantAcceptanceManifest, validateFormalVariantAcceptanceEvidence, FORMAL_VARIANT_EVIDENCE_KIND } from '../scripts/formal-variant-acceptance.mjs';
import { normalizeFormalClientTopology, currentFormalLocationDigest, validateCurrentTopologyCompletion } from '../scripts/lib/formal-client-topology.mjs';

function input() {
  return { generatedAt: '2026-11-01T00:00:00Z', clients: ['main', 'designer-client', 'legal-client'].map((clientId, index) => ({
    clientId, appIdentifier: ['com.lumiai.os','com.lumiai.designer','com.lumiai.legal'][index], nativeIdentityFingerprint: String(index+1).repeat(64), sourceFingerprint: String(index+4).repeat(64),
    coreSha: 'a'.repeat(40), sourceSha: index ? String(index).repeat(40) : 'a'.repeat(40), dataRoot: `D:/formal/${clientId}/data`, webviewProfile: `D:/formal/${clientId}/webview`,
  })), businessScopes: ['ecommerce','finance'].map(productLine => ({ clientId: 'main', productLine, userId: 'synthetic-user', domain: 'work', orgId: 'synthetic-org', workspaceId: productLine+'-workspace' })) };
}
function native(binding: any) {
  return { clientKind: 'tauri', appIdentifier: binding.appIdentifier, identityFingerprint: binding.nativeIdentityFingerprint, buildId: binding.sourceSha,
    sourceFingerprint: binding.sourceFingerprint, sourceDirty: false, osAttested: true, trustLevel: 'os_attested_native_claim', webviewProfileBound: true, webviewProfileTrustLevel: 'native_attested',
    dataRootSha256: currentFormalLocationDigest(binding.dataRoot), webviewProfileSha256: currentFormalLocationDigest(binding.webviewProfile), executableSha256: 'd'.repeat(64), pid: 101, startedAt: '2026-11-01T00:00:00Z', deviceId: binding.clientId, executionSessionId: binding.clientId+'-session' };
}
function evidence(manifest: any) {
  return { schemaVersion: 2, kind: FORMAL_VARIANT_EVIDENCE_KIND, manifestDigest: manifest.manifestDigest, scenarios: manifest.scenarios.map((s: any) => {
    const taskId=s.scenarioId+'-task', requestId=s.scenarioId+'-request';
    const receipts=s.requiredReceipts.flatMap((r: any) => Array.from({length:r.minimum},(_,i) => ({toolName:r.toolName,receiptId:s.scenarioId+r.toolName+i,taskId,requestId,persisted:true,outcome:'succeeded',terminalVerification:{status:'verified'},...(s.binding.businessScope ? {businessScope:s.binding.businessScope}: {})})));
    const receiptIds=receipts.map((r: any)=>r.receiptId);
    return { scenarioId:s.scenarioId, bindingFingerprint:s.binding.fingerprint, runtimeBinding:structuredClone(s.binding), nativeClient:native(s.binding), completedAt:'2026-11-01T01:00:00Z',
      fixtures:s.fixtures.map((f: any)=>({id:f.id,path:path.win32.join(s.binding.dataRoot, 'synthetic', f.id+f.acceptedExtensions[0]),size:12,sha256:'b'.repeat(64)})),
      steps:s.userSteps.map((step: any)=>({id:step.id,status:'completed',taskId,requestId,userMessageId:step.id+'-user',assistantMessageId:step.id+'-reply'})), toolReceipts:receipts,observedForbiddenSideEffects:[],
      artifacts:s.finalArtifacts.map((a: any)=>({id:a.id,kind:a.kind,receiptIds,...(a.kind==='file'?{path:path.win32.join(s.binding.dataRoot,'synthetic',a.id+a.acceptedExtensions[0]),size:22,sha256:'c'.repeat(64)}:{durableId:a.id})})),
      humanChecks:s.humanChecks.map((h: any)=>({id:h.id,status:'passed',reviewerType:'human',reviewer:'synthetic-reviewer',checkedAt:'2026-11-01T01:00:00Z'})) };
  }) };
}
describe('current three-client formal topology, synthetic contract checks only', () => {
  it('uses one Main runtime for two distinct business scopes and retains four business contracts', () => {
    const m=buildCurrentFormalVariantAcceptanceManifest(input());
    expect(validateFormalVariantAcceptanceManifest(m)).toEqual({ok:true,errors:[]});
    expect(m.clients).toHaveLength(3); expect(m.scenarios).toHaveLength(4);
    const main=m.scenarios.filter((s: any)=>s.binding.clientId==='main'); expect(main).toHaveLength(2);
    expect(main[0].binding.dataRoot).toBe(main[1].binding.dataRoot); expect(main[0].binding.fingerprint).not.toBe(main[1].binding.fingerprint);
    expect(m.executionPolicy).toMatchObject({launchClient:false,synthesizeBusinessResults:false,defaultOutcome:'unverified'});
  });
  it.each(['extra-client','wrong-app','shared-profile','nested-path','unbound','foreign-client','missing-org','duplicate-scope','main-sha'])('rejects %s before creating a plan', change => {
    const value=input();
    if(change==='extra-client') value.clients.push({...value.clients[0],clientId:'finance-client'});
    if(change==='wrong-app') value.clients[2].appIdentifier='com.lumiai.os';
    if(change==='shared-profile') value.clients[2].webviewProfile=value.clients[0].webviewProfile;
    if(change==='nested-path') value.clients[2].dataRoot=value.clients[0].dataRoot+'/nested';
    if(change==='unbound') value.businessScopes[0].workspaceId='_unbound';
    if(change==='foreign-client') value.businessScopes[0].clientId='designer-client';
    if(change==='missing-org') value.businessScopes[0].orgId='';
    if(change==='duplicate-scope') value.businessScopes[1].productLine='ecommerce';
    if(change==='main-sha') value.clients[0].sourceSha='b'.repeat(40);
    expect(()=>buildCurrentFormalVariantAcceptanceManifest(value)).toThrow();
  });
  it('does not turn structurally complete caller JSON into acceptance or verified files', () => {
    const m=buildCurrentFormalVariantAcceptanceManifest(input()), e=evidence(m);
    expect(validateFormalVariantAcceptanceEvidence(m,e)).toMatchObject({ok:true,acceptancePassed:false,acceptanceDecision:'not_adjudicated',filesystemVerified:false});
    expect(validateFormalVariantAcceptanceEvidence(m,e,{verifyFilesystem:true})).toMatchObject({ok:false,acceptancePassed:false});
    e.schemaVersion=1; expect(validateFormalVariantAcceptanceEvidence(m,e).errors).toContain('evidence_envelope_invalid');
  });
  it.each(['scope','receipt-scope','native','profile','stale-source','cross-task'])('rejects mismatched %s evidence', change => {
    const m=buildCurrentFormalVariantAcceptanceManifest(input()), e=evidence(m);
    const commerce=e.scenarios.find((s: any)=>s.runtimeBinding.businessScope?.productLine==='ecommerce');
    if(change==='scope') commerce.runtimeBinding.businessScope.workspaceId='other-store';
    if(change==='receipt-scope') commerce.toolReceipts[0].businessScope={...commerce.runtimeBinding.businessScope,workspaceId:'other-store'};
    if(change==='native') commerce.nativeClient.osAttested=false;
    if(change==='profile') commerce.nativeClient.webviewProfileSha256='f'.repeat(64);
    if(change==='stale-source') commerce.nativeClient.buildId='b'.repeat(40);
    if(change==='cross-task') e.scenarios[0].steps[0].taskId=commerce.steps[0].taskId;
    expect(validateFormalVariantAcceptanceEvidence(m,e).ok).toBe(false);
  });
  it('requires three native runtime proofs and both scopes in the Stage9 producer summary', () => {
    const topology=normalizeFormalClientTopology(input());
    const payload={clientTopology:topology, completedClients:topology.clients.map((c: any)=>({clientId:c.clientId,fingerprint:c.fingerprint,nativeClient:native(c)})),completedBusinessScopes:topology.businessScopes,completedBusinessLoops:['design','ecommerce','finance','legal']};
    expect(validateCurrentTopologyCompletion(payload)).toBe(true);
    payload.completedClients[0].nativeClient.webviewProfileBound=false; expect(()=>validateCurrentTopologyCompletion(payload)).toThrow(/runtime_binding/);
    payload.completedClients[0].nativeClient.webviewProfileBound=true; payload.completedBusinessScopes=[]; expect(()=>validateCurrentTopologyCompletion(payload)).toThrow(/scopes_not_proven/);
  });
});
