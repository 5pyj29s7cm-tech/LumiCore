import fs from "fs";
import path from "path";
import { loadKeys } from "../../config/keys";
import type { MCPServerConfig } from './contracts';
import { resolveDirectSkillDirectory } from './package_sources';
import { PENDING_SKILL_MARKER } from './security';

export function isProcessBacked(config: MCPServerConfig): boolean {
    const transportType = config.transport || (config.url
      ? (config.url.startsWith('wss://') || config.url.startsWith('ws://') ? 'ws' : 'http')
      : 'stdio');
    return transportType === 'stdio';
  }
export function isInstallationPending(name: string, config: MCPServerConfig): boolean {
    if (config.installationState === 'pending') return true;
    if (config.source !== 'local') return false;
    try {
      return fs.existsSync(path.join(resolveDirectSkillDirectory(name), PENDING_SKILL_MARKER));
    } catch {
      return true;
    }
  }
export function isMissingRequiredApiKey(config: MCPServerConfig): boolean {
    if (!config.requiresApiKey || !config.apiKeyEnv) return false;
    const fromEnv = process.env[config.apiKeyEnv]?.trim();
    if (fromEnv) return false;
    try {
      return !loadKeys()[config.apiKeyEnv]?.trim();
    } catch {
      return true;
    }
  }
