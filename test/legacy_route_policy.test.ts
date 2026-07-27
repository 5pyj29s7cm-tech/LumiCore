import { describe, expect, it } from 'vitest';
import {
  LEGACY_DIRECT_EXECUTION_ENABLED,
  shouldRunLegacyDirectExecution,
} from '../server/cognition/legacy_route_policy';

describe('legacy route compatibility policy', () => {
  it('keeps legacy quick commands, workflow regexes, and cognition hints read-only', () => {
    expect(LEGACY_DIRECT_EXECUTION_ENABLED).toBe(false);
    expect(shouldRunLegacyDirectExecution()).toBe(false);
  });
});
