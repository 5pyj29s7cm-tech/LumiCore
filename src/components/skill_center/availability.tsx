import { formatUiMessage, uiMessage } from "../../i18n/uiMessages";
import { getSkillSettingsTarget } from "../../../shared/model_service_settings";
import type { SkillAvailability, MarketplaceSkill, InstalledSkill } from './contracts';

export const AVAILABILITY_CLASSES: Record<SkillAvailability['tone'], string> = {
  green: 'bg-green-500/10 text-green-300 border-green-500/15',
  amber: 'bg-amber-500/10 text-amber-300 border-amber-500/15',
  cyan: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/15',
  red: 'bg-red-500/10 text-red-300 border-red-500/15',
  white: 'bg-white/[0.055] text-white/55 border-white/[0.08]',
};

function normalizeSkillKey(value?: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/^skill-/, '')
    .replace(/^lumi official:\s*/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function findInstalledSkillForMarket(skill: MarketplaceSkill, installedSkills: InstalledSkill[]): InstalledSkill | undefined {
  if (skill.installSource === 'bundled' && skill.officialIdentityStatus !== 'verified') return undefined;
  const candidates = new Set([
    normalizeSkillKey(skill.id),
    normalizeSkillKey(skill.name),
  ]);
  return installedSkills.find(installed => candidates.has(normalizeSkillKey(installed.name)));
}

export function getSkillSettingsSectionLabel(settingsSection: string, locale: 'en' | 'zh'): string {
  if (settingsSection === 'ai-providers') return uiMessage('settings.ai-providers.38c3f21901', locale);
  if (settingsSection === 'data-sources') return uiMessage('settings.data-sources.9f7efbc2df', locale);
  if (settingsSection === 'applications') return uiMessage('settings.applications.36d70e9597', locale);
  return uiMessage('settings.tools.145e2645a6', locale);
}

export function getApiKeyConfigurationDetail(
  skill: MarketplaceSkill,
  lang: 'en' | 'zh',
  fallbackMessage:
    | 'skill-center.configure-value0-after-install-before.18059ad8fc'
    | 'skill-center.configure-value0-before-real-calls.041e3cf5db',
): string {
  const locale = lang === 'zh' ? 'zh' : 'en';
  const settingsTarget = getSkillSettingsTarget(skill.apiKeyEnv);
  if (settingsTarget) {
    return formatUiMessage('skill-center.value0-is-managed-in-value1-settings.41f04ac801', {
      value0: settingsTarget.label,
      value1: getSkillSettingsSectionLabel(settingsTarget.settingsSection, locale),
    }, locale);
  }
  return formatUiMessage(fallbackMessage, { value0: skill.apiKeyEnv || '' }, locale);
}

export function getDisplayAvailability(
  skill: MarketplaceSkill,
  installedSkills: InstalledSkill[],
  savedKeys: Record<string, boolean>,
  lang: 'en' | 'zh',
): SkillAvailability {
  if (skill.officialIdentityStatus === 'conflict') {
    return {
      label: 'Local identity conflict',
      detail: skill.conflictReason || 'A same-name local package or configuration does not match this official Skill.',
      tone: 'red',
    };
  }
  if (skill.runtimeInstallable === false) {
    return {
      label: 'Reviewed external MCP required',
      detail: 'This entry depends on an external executable that is not bound to the official Skill runtime.',
      tone: 'amber',
    };
  }
  const installedSkill = findInstalledSkillForMarket(skill, installedSkills);
  if (installedSkill) return getInstalledSkillAvailability(installedSkill, lang, true);
  if (skill.installed) {
    return {
      label: uiMessage('skill-center.installed-not-connected.7f99bc5091', (lang === 'zh') ? 'zh' : 'en'),
      detail: uiMessage('skill-center.installed-but-it-has-not.61d5e176ff', (lang === 'zh') ? 'zh' : 'en'),
      tone: 'amber',
    };
  }
  if ((skill.requiresApiKey && skill.apiKeyEnv && !savedKeys[skill.apiKeyEnv]) || skill.requiresSetup) {
    return {
      label: uiMessage('skill-center.needs-configuration.d8fbbeff8a', (lang === 'zh') ? 'zh' : 'en'),
      detail: skill.requiresApiKey && skill.apiKeyEnv
        ? getApiKeyConfigurationDetail(skill, lang, 'skill-center.configure-value0-before-real-calls.041e3cf5db')
        : (skill.setupNote || (uiMessage('skill-center.requires-local-dependencies-or-account.87aec9deaa', (lang === 'zh') ? 'zh' : 'en'))),
      tone: 'amber',
    };
  }
  return {
    label: uiMessage('skill-center.installable.04d1cd9917', (lang === 'zh') ? 'zh' : 'en'),
    detail: uiMessage('skill-center.available-in-the-hall-only.f6dd8e70ac', (lang === 'zh') ? 'zh' : 'en'),
    tone: 'white',
  };
}

export function getInstalledSkillAvailability(skill: InstalledSkill, lang: 'en' | 'zh', catalog = false): SkillAvailability {
  if (skill.broken) {
    return {
      label: uiMessage('skill-center.needs-repair.53833da009', (lang === 'zh') ? 'zh' : 'en'),
      detail: uiMessage('skill-center.local-package-is-incomplete-and.071c55d928', (lang === 'zh') ? 'zh' : 'en'),
      tone: 'red',
      installedSkill: skill,
    };
  }
  if (skill.startupError || (skill.enabled && !skill.usable)) {
    return {
      label: uiMessage('skill-center.installed-not-connected.7f99bc5091', (lang === 'zh') ? 'zh' : 'en'),
      detail: skill.startupError || uiMessage(catalog ? 'skill-center.installed-but-its-local-service.0372816817' : 'skill-center.the-local-service-is-not.9ec540d4f3', lang),
      tone: 'amber',
      installedSkill: skill,
    };
  }
  if (skill.usable) {
    return {
      label: uiMessage('skill-center.callable.b5f5a3c5c6', (lang === 'zh') ? 'zh' : 'en'),
      detail: uiMessage(catalog ? 'skill-center.connected-to-lumi-and-available.e7eedbc8db' : 'skill-center.connected-to-lumi-and-available.e8472f7e6b', lang),
      tone: 'green',
      installedSkill: skill,
    };
  }
  return {
    label: uiMessage('skill-center.installed-disabled.46156ea2d0', (lang === 'zh') ? 'zh' : 'en'),
    detail: uiMessage('skill-center.the-skill-exists-locally-but.197bdb9ca7', (lang === 'zh') ? 'zh' : 'en'),
    tone: 'white',
    installedSkill: skill,
  };
}

export function getInstallActionText(installed: boolean, lang: 'en' | 'zh', t: any): string {
  if (installed) return t.installedStatus || uiMessage('skill-center.installed.7730eadf9a', lang);
  return t.installBtn || uiMessage('skill-center.install.8a47f50b4d', lang);
}

export function hasSkillRuntimeIssue(skill: InstalledSkill): boolean {
  return !!skill.broken || !!skill.startupError
    || (!!skill.healthStatus && ['crashed', 'failed', 'restarting'].includes(skill.healthStatus))
    || (skill.enabled && !skill.connected);
}
