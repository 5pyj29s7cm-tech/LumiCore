// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/hooks/useFileDrop', () => ({ useFileDrop: () => ({ props: {}, dragging: false }) }));
vi.mock('../src/components/FileResourceMedia', () => ({ FileResourceImage: () => <span />, FileResourceVideo: () => <span /> }));
vi.mock('../src/components/FileLocationActions', () => ({ FileLocationActions: () => null }));
vi.mock('../src/services/fileResource', () => ({ saveFileResource: vi.fn(() => { throw Error('No file export expected'); }) }));
import { MediaGenerationStudio, EMPTY_MEDIA_GENERATION_SOURCES } from '../src/components/MediaGenerationStudio';
import { renderMeetingWorkspace } from '../src/components/desktop/meeting_workspace_view';
afterEach(cleanup);

function mediaProps() {
  return { ...EMPTY_MEDIA_GENERATION_SOURCES, mode: 'image' as const, locale: 'en' as const, busy: false, status: 'idle' as const,
    artifacts: [], onModeChange: vi.fn(), onSourceChange: vi.fn(), onClose: vi.fn(), onGenerate: vi.fn(),
    onOpenArtifact: vi.fn(), onArtifactReady: vi.fn(), onArtifactError: vi.fn() };
}
describe('all-partitions creation', () => {
  it('requires a prompt and emits one structured image request without calling a provider', () => {
    const props = mediaProps(); const view = render(<MediaGenerationStudio {...props} />);
    fireEvent.submit(view.container.querySelector('form')!); expect(props.onGenerate).not.toHaveBeenCalled();
    fireEvent.change(view.container.querySelector('textarea')!, { target: { value: '  Synthetic image  ' } });
    fireEvent.submit(view.container.querySelector('form')!);
    expect(props.onGenerate).toHaveBeenCalledTimes(1);
    expect(props.onGenerate.mock.calls[0][0]).toMatchObject({ mode: 'image', operation: 'text_to_image', prompt: 'Synthetic image', count: 1 });
    view.rerender(<MediaGenerationStudio {...props} busy status="generating" />);
    fireEvent.submit(view.container.querySelector('form')!); expect(props.onGenerate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /return to command center/i })); expect(props.onClose).toHaveBeenCalledTimes(1);
  });
  it('requires the primary edit source and binds bounded reference identities to the request', () => {
    const props = { ...mediaProps(), operation: 'image_edit' as const };
    const view = render(<MediaGenerationStudio {...props} />);
    fireEvent.change(view.container.querySelector('textarea')!, { target: { value: 'Fixture edit' } });
    fireEvent.submit(view.container.querySelector('form')!); expect(props.onGenerate).not.toHaveBeenCalled();
    view.rerender(<MediaGenerationStudio {...props} primaryImage="D:/fixture/source.png" primaryArtifactId="source-id" referenceImages={['D:/fixture/ref.png', 'D:/fixture/extra.png']} referenceArtifactIds={['reference-id', 'extra-id']} />);
    fireEvent.submit(view.container.querySelector('form')!);
    expect(props.onGenerate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'image_edit', primaryImage: 'D:/fixture/source.png', primaryArtifactId: 'source-id', referenceImages: ['D:/fixture/ref.png'], referenceArtifactIds: ['reference-id'] }));
  });
});

function meetingProps() {
  return { meetingNotesOpen: true, resolvedAppearanceMode: 'dark', operationMode: 'assistant', meetingPaused: true, callState: 'idle', callError: '', t: {}, lang: 'en',
    legalMeetingCaseTitle: '', copyMeetingNotes: vi.fn(), downloadMeetingNotes: vi.fn(), setMeetingNotesOpen: vi.fn(),
    meetingNotes: [{ id: 'later', time: 20, text: 'Second synthetic entry' }, { id: 'earlier', time: 10, text: 'First synthetic entry' }],
    meetingSpeakerCount: 1, meetingReportGenerating: false, meetingReport: 'Synthetic summary', meetingReportError: '', formatMeetingTime: (time: number) => String(time),
    meetingNoteHasSpeakerInfo: () => false, meetingSpeakerLabel: () => '', toggleMeetingCapturePaused: vi.fn(), endMeetingAndReport: vi.fn(), clearMeetingNotes: vi.fn(),
    meetingHistory: [{ id: 'fixture-history', startedAt: '2026-01-01T00:00:00Z', caseTitle: '', notes: [] }], meetingRecordId: '', meetingHistoryReadOnly: true,
    selectMeetingHistoryRecord: vi.fn(), importMeetingHistoryFile: vi.fn(), meetingExportPath: '', meetingExportBusy: false, meetingExportError: '', openMeetingExport: vi.fn(),
  } as any;
}
describe('all-partitions meeting', () => {
  it('renders synthetic history in time order with capture and summarization disabled', () => {
    const props = meetingProps(); const view = render(renderMeetingWorkspace(props));
    expect(screen.getByText('History · view only')).toBeTruthy();
    expect(Array.from(view.container.querySelectorAll('ol li p')).map(node => node.textContent)).toEqual(['First synthetic entry', 'Second synthetic entry']);
    expect((screen.getByRole('button', { name: 'Continue recording' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Finish and summarize' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('combobox', { name: 'Meeting records' }), { target: { value: 'fixture-history' } });
    expect(props.selectMeetingHistoryRecord).toHaveBeenCalledExactlyOnceWith('fixture-history');
    fireEvent.click(screen.getByRole('button', { name: 'Close meeting page' })); expect(props.setMeetingNotesOpen).toHaveBeenCalledExactlyOnceWith(false);
    expect(props.toggleMeetingCapturePaused).not.toHaveBeenCalled(); expect(props.endMeetingAndReport).not.toHaveBeenCalled();
  });
  it('locks history while active and exposes pause through only the supplied callback', () => {
    const props = { ...meetingProps(), operationMode: 'meeting', meetingPaused: false, meetingHistoryReadOnly: false, callState: 'listening', meetingReport: '' };
    const view = render(renderMeetingWorkspace(props));
    expect((screen.getByRole('combobox', { name: 'Meeting records' }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText('Import recovered records') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Pause recording' })); expect(props.toggleMeetingCapturePaused).toHaveBeenCalledTimes(1);
    expect(props.importMeetingHistoryFile).not.toHaveBeenCalled(); expect(props.endMeetingAndReport).not.toHaveBeenCalled();
    view.rerender(renderMeetingWorkspace({ ...props, meetingNotesOpen: false })); expect(view.container.childElementCount).toBe(0);
  });
});
