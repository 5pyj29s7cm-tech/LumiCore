import { describe, expect, it } from 'vitest';
import {
  OFFICE_DEMO_TEXT,
  verifyOfficePasteEvidence,
} from '../server/skills/bundled/desktop-automation/workflows/self_intro_workflow';

function validEvidence() {
  return {
    activeWindowRaw: JSON.stringify({
      title: 'Lumi self introduction - WPS Office',
      process_name: 'wps.exe',
    }),
    uiSnapshotRaw: JSON.stringify({
      status: 'ok',
      capturedNodes: 8,
      tree: { name: 'Lumi self introduction - WPS Office' },
    }),
    clipboardWriteResult: 'Clipboard updated',
    clipboardReadResult: OFFICE_DEMO_TEXT,
    selectAllResult: 'Pressed: ctrl+a',
    pasteResult: 'Pressed: ctrl+v',
  };
}

describe('self-introduction office demo evidence', () => {
  it('accepts the completion line only after editor, clipboard, paste, and UI verification', () => {
    expect(verifyOfficePasteEvidence(validEvidence())).toEqual({
      ok: true,
      reason: 'verified',
    });
  });

  it('rejects a different foreground application', () => {
    expect(verifyOfficePasteEvidence({
      ...validEvidence(),
      activeWindowRaw: JSON.stringify({
        title: 'Untitled - Paint',
        process_name: 'mspaint.exe',
      }),
    })).toEqual({
      ok: false,
      reason: 'active_editor_not_verified',
    });
  });

  it('rejects missing paste or post-action UI evidence', () => {
    expect(verifyOfficePasteEvidence({
      ...validEvidence(),
      pasteResult: '',
    }).ok).toBe(false);
    expect(verifyOfficePasteEvidence({
      ...validEvidence(),
      uiSnapshotRaw: JSON.stringify({ status: 'empty', capturedNodes: 0 }),
    })).toEqual({
      ok: false,
      reason: 'editor_ui_not_verified',
    });
  });
});
