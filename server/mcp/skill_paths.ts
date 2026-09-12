import os from 'os';
import path from 'path';
import { getDataPath } from '../config/data_path';

// Executable packages, registration and signing identity belong to one profile.
// Sharing ~/lumi_skills lets another Lumi application replace its dependencies.
export const SKILLS_DIR = process.env.VITEST
  ? path.join(process.env.LUMI_TEST_TMPDIR || os.tmpdir(), `lumi-test-skills-${process.pid}-${process.env.VITEST_POOL_ID || '0'}`)
  : getDataPath('skills');

export const LEGACY_SKILLS_DIR = path.join(os.homedir(), 'lumi_skills');
