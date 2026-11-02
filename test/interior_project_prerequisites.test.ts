import { describe, expect, it } from 'vitest';
import { getMissingInteriorProjectPrerequisites } from '../server/design/project_workflow';

describe('interior design stage prerequisites', () => {
  const workflow = {
    stages: {
      project: { status: 'completed' },
      cad: { status: 'completed' },
      visualization: { status: 'blocked' },
      presentation: { status: 'completed' },
      handoff: { status: 'blocked' },
    },
  } as any;

  it('blocks presentation when visualization is not verified', () => {
    expect(getMissingInteriorProjectPrerequisites(workflow, 'presentation')).toEqual(['visualization']);
  });

  it('blocks handoff on every incomplete prior stage even if a downstream stage was mistakenly marked complete', () => {
    expect(getMissingInteriorProjectPrerequisites(workflow, 'handoff')).toEqual(['visualization']);
  });

  it('lets CAD proceed after the project brief is complete', () => {
    expect(getMissingInteriorProjectPrerequisites(workflow, 'cad')).toEqual([]);
  });
});
