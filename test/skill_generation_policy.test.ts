import { afterEach, describe, expect, it } from 'vitest';
import { isAutomaticSkillGenerationEnabled } from '../server/skills/generator';

describe('Executable skill generation policy', () => {
  const original = process.env.LUMI_AUTO_GENERATE_EXECUTABLE_SKILLS;

  afterEach(() => {
    if (original === undefined) delete process.env.LUMI_AUTO_GENERATE_EXECUTABLE_SKILLS;
    else process.env.LUMI_AUTO_GENERATE_EXECUTABLE_SKILLS = original;
  });

  it('does not silently compile repeated workflows into executable skills by default', () => {
    delete process.env.LUMI_AUTO_GENERATE_EXECUTABLE_SKILLS;
    expect(isAutomaticSkillGenerationEnabled()).toBe(false);
  });

  it('requires an explicit deployment opt-in', () => {
    process.env.LUMI_AUTO_GENERATE_EXECUTABLE_SKILLS = 'true';
    expect(isAutomaticSkillGenerationEnabled()).toBe(true);
  });
});
