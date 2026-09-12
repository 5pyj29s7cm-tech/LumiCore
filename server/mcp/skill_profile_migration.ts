import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { MCPServerConfig } from './client';
import {
  computeSkillContentDigest, verifyManagedSkillIdentitySignature,
  type ManagedSkillIdentity,
} from '../marketplace/official_identity';

/** Copy only this profile's previously approved code. Never move shared files,
 * execute a legacy command, download dependencies, or adopt an unsigned package.
 * A journal allows restart after the directory rename but before config commit.
 */
export function migrateProfileSkills(options: {
  legacyRoot: string;
  skillsRoot: string;
  servers: Record<string, MCPServerConfig>;
  secret: string;
  bindRuntime: (directory: string, identity: ManagedSkillIdentity) => ManagedSkillIdentity;
  saveServers: (servers: Record<string, MCPServerConfig>) => void;
}): { migrated: string[]; skipped: Array<{ name: string; reason: string }> } {
  const result: ReturnType<typeof migrateProfileSkills> = { migrated: [], skipped: [] };
  const legacyRoot = path.resolve(options.legacyRoot);
  const skillsRoot = path.resolve(options.skillsRoot);
  if (legacyRoot === skillsRoot || !fs.existsSync(legacyRoot)) return result;
  fs.mkdirSync(skillsRoot, { recursive: true });
  for (const root of [legacyRoot, skillsRoot]) {
    if (fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory()) {
      throw new Error('Skill migration roots must be real directories');
    }
  }
  const servers = structuredClone(options.servers);
  for (const [name, config] of Object.entries(servers)) {
    if (config.source !== 'local') continue;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) continue;
    const source = path.join(legacyRoot, name);
    const destination = path.join(skillsRoot, name);
    const journal = path.join(skillsRoot, `.migration-${name}.json`);
    const identity = config.managedSkill;
    // A committed migration must not run again or replace a newer installation.
    if (path.resolve(config.cwd || '.') === destination) continue;
    let staging: string | undefined;
    try {
      if (!identity || !verifyManagedSkillIdentitySignature(identity, options.secret)
        || !['bundled', 'generated'].includes(identity.origin)
        || (identity.origin === 'generated' && !identity.reviewHash)) {
        throw new Error('Legacy package has no approved identity for this profile; reinstall its official entry or review its draft');
      }
      const runtime = identity.runtime;
      if (!runtime || runtime.transport !== 'stdio' || config.transport !== 'stdio'
        || config.url || config.headers || path.resolve(config.cwd || '.') !== source
        || runtime.cwd !== source || !runtime.args.includes(path.join(source, 'index.ts'))
        || config.command !== runtime.command || JSON.stringify(config.args) !== JSON.stringify(runtime.args)
        || JSON.stringify(config.env || null) !== JSON.stringify(runtime.env || null)) {
        throw new Error('Legacy runtime configuration changed after approval');
      }
      if (fs.lstatSync(source).isSymbolicLink()) throw new Error('Legacy package must not be a link');
      const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
      if (!pkg.lumi || typeof pkg.lumi !== 'object' || Array.isArray(pkg.lumi)
        || pkg.name !== identity.packageName || String(pkg.version) !== identity.packageVersion
        || computeSkillContentDigest(source) !== identity.contentDigest) {
        throw new Error('Legacy package content changed after approval');
      }
      // The shared package stamp may belong to another profile. Our signed
      // registration plus the identical content digest are the authority.
      const proof = JSON.stringify({ source, destination, identity });
      if (fs.existsSync(journal) && (fs.lstatSync(journal).isSymbolicLink() || !fs.lstatSync(journal).isFile()
        || fs.readFileSync(journal, 'utf8') !== proof)) throw new Error('Migration journal conflicts with the approved package');
      if (fs.existsSync(destination)) {
        if (fs.lstatSync(destination).isSymbolicLink() || !fs.existsSync(journal)
          || fs.readFileSync(journal, 'utf8') !== proof
          || computeSkillContentDigest(destination) !== identity.contentDigest) {
          throw new Error('Destination already contains a different installation');
        }
      } else {
        fs.writeFileSync(journal, proof, { encoding: 'utf8', flag: fs.existsSync(journal) ? 'w' : 'wx' });
        staging = path.join(skillsRoot, `.staging-migrate-${name}-${crypto.randomUUID()}`);
        fs.cpSync(source, staging, {
          recursive: true, dereference: false, errorOnExist: true, force: false,
          filter: candidate => !['node_modules', '.git'].includes(path.basename(candidate)),
        });
        if (computeSkillContentDigest(staging) !== identity.contentDigest) throw new Error('Copied package digest differs');
        fs.renameSync(staging, destination);
        staging = undefined;
      }
      const rebound = options.bindRuntime(destination, identity);
      if (!rebound.runtime || !verifyManagedSkillIdentitySignature(rebound, options.secret)
        || rebound.contentDigest !== identity.contentDigest || rebound.reviewHash !== identity.reviewHash) {
        throw new Error('The new host runtime could not be bound to the approved package');
      }
      const installedPkg = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'));
      installedPkg.lumi = { ...installedPkg.lumi, managedSkill: rebound };
      fs.writeFileSync(path.join(destination, 'package.json'), `${JSON.stringify(installedPkg, null, 2)}\n`, 'utf8');
      if (computeSkillContentDigest(destination) !== identity.contentDigest) throw new Error('Installed package content differs after runtime binding');
      const next = { ...config, command: rebound.runtime.command, args: rebound.runtime.args,
        cwd: rebound.runtime.cwd, transport: 'stdio' as const, managedSkill: rebound };
      if (rebound.runtime.env) next.env = rebound.runtime.env;
      else delete next.env;
      delete next.cachedTools;
      delete next.cachedToolsFingerprint;
      delete next.cachedToolsAttestation;
      const previous = servers[name];
      servers[name] = next;
      try { options.saveServers(servers); }
      catch (error) { servers[name] = previous; throw error; }
      fs.rmSync(journal, { force: true });
      result.migrated.push(name);
    } catch (error: any) {
      result.skipped.push({ name, reason: String(error?.message || error) });
    } finally {
      if (staging && path.dirname(staging) === skillsRoot && path.basename(staging).startsWith('.staging-migrate-')) {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    }
  }
  return result;
}
