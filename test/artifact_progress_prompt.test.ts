import { describe, it, expect } from 'vitest';
import { buildArtifactProgressPrompt, resolveRequiredToolNamesForModel, resolveArtifactReadbackCall, resolveInteractiveToolTimeouts } from '../server/llm/adapter';
import { requestedArtifactSaveAsPath, matchesRequestedArtifactOutput } from '../server/cognition/artifact_write_scope';

describe('generated deliverable continuation', () => {
  it('separates a correction source from its exact save-as destination', () => {
    const task='把刚才报表的 B类数量改成6，另存到 D:/work/updated.xlsx，告诉我总金额。';
    expect(requestedArtifactSaveAsPath(task)).toBe('D:/work/updated.xlsx');
    expect(matchesRequestedArtifactOutput(task,'D:/work/random-copy.xlsx')).toBe(false);
    expect(matchesRequestedArtifactOutput(task,'D:/work/updated.xlsx')).toBe(true);
    expect(requestedArtifactSaveAsPath('不要另存到 D:/work/no.xlsx')).toBe('');
  });
  it('bounds silent official file-task waiting only when an ordered fallback is configured', () => {
    const config: any = { provider: 'relay', model: 'primary', selectionMode: 'ordered_fallback', fallbackCandidates: [{provider:'relay', model:'backup'}] };
    const task='Create D:/work/meeting.docx with a meeting agenda.';
    expect(resolveInteractiveToolTimeouts(config,task)?.semanticContentMs).toBe(25000);
    expect(resolveInteractiveToolTimeouts({...config,selectionMode:'pinned'},task)).toBeUndefined();
    expect(resolveInteractiveToolTimeouts({...config,provider:'lmstudio'},task)).toBeUndefined();
    expect(resolveInteractiveToolTimeouts({...config,attemptTimeouts:{semanticContentMs:90000}},task)?.semanticContentMs).toBe(90000);
    expect(resolveInteractiveToolTimeouts(config,'Explain a mathematical theorem.')).toBeUndefined();
  });
  const saved: any = { name: 'create_docx', arguments: {}, result: JSON.stringify({ ok: true, status: 'created', path: 'D:/work/meeting.docx' }), terminalVerification: { status: 'verified' } };
  it('carries a verified output and its pending open step into the next model request', () => {
    const prompt = buildArtifactProgressPrompt('Create a meeting document and open it in WPS.', [saved]);
    expect(prompt).toContain('"savedPath":"D:/work/meeting.docx"');
    expect(prompt).toContain('"openRequestedAndPending":true');
    expect(prompt).toContain('Do not create it again');
    expect(buildArtifactProgressPrompt('Create a document. Do not open it.', [saved])).toContain('"openRequestedAndPending":false');
  });
  it('does not promote failed or unverified writes into saved-file state', () => {
    expect(buildArtifactProgressPrompt('Open the document', [{ ...saved, error: 'write failed' }])).toBe('');
    expect(buildArtifactProgressPrompt('Open the document', [{ ...saved, terminalVerification: { status: 'unverified' } }])).toBe('');
  });
  it('keeps the requested application-open capability in the small-model projection', () => {
    const declarations = ['create_docx', 'desktop_path_info', 'desktop_open'].map(name => ({ function: { name } }));
    expect(resolveRequiredToolNamesForModel(undefined, 'Create a document and open it in WPS.', declarations, [])).toContain('desktop_open');
  });
  it('reads only a verified current-turn output explicitly requested for readback', () => {
    const task = 'Create D:/work/meeting.docx then read it back and check its contents.';
    const current = { ...saved, requestId: 'r1', taskId: 't1' };
    const exposed = new Set(['read_docx']);
    expect(resolveArtifactReadbackCall(task, [current], exposed, { requestId: 'r1', taskId: 't1' }))
      .toEqual({ name: 'read_docx', arguments: { filePath: 'D:/work/meeting.docx' } });
    expect(resolveArtifactReadbackCall(task, [current], exposed, { requestId: 'other' })).toBeNull();
    expect(resolveArtifactReadbackCall(task, [current], new Set(), { requestId: 'r1' })).toBeNull();
    expect(resolveArtifactReadbackCall(task, [{ ...current, error: 'failed' }], exposed, { requestId: 'r1' })).toBeNull();
    expect(resolveArtifactReadbackCall(task, [{ ...current, result: JSON.stringify({path:'D:/other.docx'}) }], exposed, { requestId: 'r1' })).toBeNull();
    expect(resolveArtifactReadbackCall('Create D:/work/meeting.docx.', [current], exposed, { requestId: 'r1' })).toBeNull();
    const read: any = { name: 'read_docx', requestId: 'r1', arguments: { filePath: 'D:/work/meeting.docx' }, error: 'read failed' };
    expect(resolveArtifactReadbackCall(task, [current, read], exposed, { requestId: 'r1' })).toBeNull();
  });
});
