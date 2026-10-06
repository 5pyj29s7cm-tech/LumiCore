import fs from "fs";
import path from "path";
import { exec } from "child_process";

// ── Validation ──

export function runDependencyCommand(command: string, skillDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(command, {
      timeout: 120000,
      maxBuffer: 512 * 1024,
      cwd: skillDir,
    }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve();
      }
    });
  });
}

/** Resolve the generated template once without executing package scripts. */
export async function createSkillDependencyLock(skillDir: string): Promise<void> {
  await runDependencyCommand(
    'npm install --package-lock-only --ignore-scripts --loglevel=error --no-audit --no-fund',
    skillDir,
  );
  if (!fs.existsSync(path.join(skillDir, 'package-lock.json'))) {
    throw new Error('npm did not produce the required generated-skill dependency lockfile');
  }
}

/** Reproduce exactly the reviewed lock in an isolated validation snapshot. */
export async function installLockedSkillDeps(skillDir: string): Promise<void> {
  await runDependencyCommand(
    'npm ci --ignore-scripts --loglevel=error --no-audit --no-fund',
    skillDir,
  );
}
