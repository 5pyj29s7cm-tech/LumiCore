import { describe, expect, it } from 'vitest';
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
      },
    ]);

    expect(transcript).toContain('Alice: We should ship the beta this week.');
    expect(transcript).toContain('Unknown speaker: I will check the rollout risk.');
  });
});
