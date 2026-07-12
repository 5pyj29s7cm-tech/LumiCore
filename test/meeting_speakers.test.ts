import { describe, expect, it } from 'vitest';
import { getMeetingAudioDir } from '../server/stt/artifact_paths';
import { formatMeetingTranscriptForAnalysis } from '../server/routes/chat_routes';

describe('meeting speaker transcript formatting', () => {
  it('preserves known and unknown speaker labels for meeting analysis', () => {
    const transcript = formatMeetingTranscriptForAnalysis([
      {
        time: Date.UTC(2026, 0, 1, 9, 0, 0),
        text: 'We should ship the beta this week.',
        speakerMatched: true,
        speakerLabel: 'Alice',
      },
      {
        time: Date.UTC(2026, 0, 1, 9, 1, 0),
        text: 'I will check the rollout risk.',
        speakerMatched: false,
        speakerLabel: 'Speaker 2',
      },
      {
        time: Date.UTC(2026, 0, 1, 9, 2, 0),
        text: 'The final voice was not separated.',
        speakerMatched: false,
      },
    ]);

    expect(transcript).toContain('Alice: We should ship the beta this week.');
    expect(transcript).toContain('Speaker 2: I will check the rollout risk.');
    expect(transcript).toContain('Unknown speaker: The final voice was not separated.');
  });
});

describe('meeting recording scope', () => {
  it('stores personal and organization meeting audio in different scope directories', () => {
    const personal = getMeetingAudioDir({ userId: 'meeting-owner', domain: 'personal', orgId: '' });
    const work = getMeetingAudioDir({ userId: 'meeting-owner', domain: 'work', orgId: 'meeting-org' });
    const otherOrg = getMeetingAudioDir({ userId: 'meeting-owner', domain: 'work', orgId: 'other-org' });
    expect(personal).not.toBe(work);
    expect(work).not.toBe(otherOrg);
    expect(personal).toContain('personal');
    expect(work).toContain('work');
  });
});
