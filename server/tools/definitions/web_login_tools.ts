import { ToolRegistry } from '../registry';
import {
  deleteWebLoginProfile,
  fetchWithWebLogin,
  learnWebLoginSite,
  listWebLoginProfiles,
  runWebLogin,
  saveWebLoginProfile,
  type WebLoginScope,
} from '../../web_login/manager';
import { getWebLoginSitePreset, listWebLoginSitePresets } from '../../web_login/legal_presets';
import { getMember } from '../../org/db';
import type { ToolContext } from '../types';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';

function scopeFromContext(context?: { userId?: string; domain?: string; orgId?: string }): WebLoginScope {
  return {
    userId: context?.userId || 'anonymous',
    domain: context?.domain || 'personal',
    orgId: context?.orgId || '',
  };
}

function assertCanMutateWebLoginProfile(context?: ToolContext): void {
  if (context?.domain !== 'work' && !context?.orgId) return;
  const userId = String(context?.userId || '').trim();
  const orgId = String(context?.orgId || '').trim();
  const membership = userId && orgId ? getMember(orgId, userId) : null;
  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    throw new Error('Only an organization owner or administrator can change shared website login profiles.');
  }
}

export function registerWebLoginTools(registry: ToolRegistry): void {
  registry.register({
    name: 'web_login_site_presets',
    description: 'List built-in website login presets. Presets cover legal research and filing sites such as 法信、中国裁判文书网、人民法院案例库、企查查、法蝉、Alpha; arbitrary websites should use web_login_profile_save or web_login_learn_site.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Optional preset category. Use "legal" for legal research sites.' },
      },
      required: [],
    },
    handler: async (args) => JSON.stringify({
      presets: listWebLoginSitePresets(args.category),
      note: 'Use web_login_profile_save_from_preset to create a local authorized login profile from one of these presets. Use web_login_learn_site for any other website.',
    }, null, 2),
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'web_login_profile_save_from_preset',
    description: [
      'Create or update a local authorized login profile from a built-in site preset.',
      'Useful for legal research and filing sites like 法信、中国裁判文书网、人民法院案例库、企查查、法蝉、Alpha, or 人民法院在线服务.',
      'Passwords are encrypted locally. Do not use without explicit user authorization.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        presetId: { type: 'string', description: 'Preset id, e.g. "faxin" or "china-judgments-online".' },
        id: { type: 'string', description: 'Optional profile id to update.' },
        label: { type: 'string', description: 'Optional profile label.' },
        username: { type: 'string', description: 'Optional username/email/phone.' },
        password: { type: 'string', description: 'Optional password to encrypt locally.' },
        usernameSelector: { type: 'string', description: 'Optional CSS selector for username field.' },
        passwordSelector: { type: 'string', description: 'Optional CSS selector for password field.' },
        submitSelector: { type: 'string', description: 'Optional CSS selector for submit button.' },
        successUrlPattern: { type: 'string', description: 'Optional RegExp tested against URL to decide login success.' },
        notes: { type: 'string', description: 'Additional operator notes or 2FA instructions.' },
      },
      required: ['presetId'],
    },
    handler: async (args, context) => {
      assertCanMutateWebLoginProfile(context);
      const preset = getWebLoginSitePreset(String(args.presetId || ''));
      if (!preset) throw new Error(`Unknown web login preset: ${args.presetId}`);
      const mergedNotes = [preset.notes, args.notes].filter(Boolean).join(' ');
      return JSON.stringify({
        ok: true,
        status: 'saved',
        profile: saveWebLoginProfile({
          id: args.id || preset.id,
          label: args.label || preset.label,
          loginUrl: preset.loginUrl,
          matchHosts: preset.matchHosts,
          username: args.username,
          password: args.password,
          usernameSelector: args.usernameSelector,
          passwordSelector: args.passwordSelector,
          submitSelector: args.submitSelector,
          successUrlPattern: args.successUrlPattern,
          notes: mergedNotes,
        }, scopeFromContext(context)),
        preset,
        note: args.password
          ? 'Saved from preset with encrypted credentials. Run web_login_run with this profile id to open the visible login session and complete captcha/2FA if needed.'
          : 'Saved from preset. Run web_login_run with this profile id to reuse the authorized browser session and complete captcha/2FA manually if needed.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'web.login.profile.save-preset',
      family: 'web_login',
      lane: 'web',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [
        { type: 'local_state_change', scope: 'authorized website login profile', reversible: true },
        { type: 'credential_access', scope: 'optional encrypted website credential', reversible: true },
      ],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'profile.id', 'profile.loginUrl', 'preset.id'],
        requiredValues: { ok: true, status: 'saved' },
        successStatuses: ['saved'],
        successSignals: ['the preset-backed profile was persisted in the current scope'],
        limitations: ['Profile persistence does not prove an authenticated browser session.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'web.login.profile.save-preset',
      operation: 'mutate',
      subjectArgument: 'presetId',
      limitations: ['Credentials, when provided, remain encrypted and are never returned.'],
    }),
  });

  registry.register({
    name: 'web_login_profile_list',
    description: 'List saved website login profiles for the current personal/work scope. Passwords are never returned.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async (_args, context) => JSON.stringify({
      profiles: listWebLoginProfiles(scopeFromContext(context)),
      note: 'Use web_login_run to open a login session, or url_fetch_logged_in for pages that need the saved session.',
    }, null, 2),
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'web_login_profile_save',
    description: [
      'Save or update an authorized website login profile for Lumi.',
      'Use only when the user explicitly authorizes storing credentials or a login session.',
      'Passwords are encrypted locally and are never returned by list/fetch tools.',
      'For captcha, passkeys, QR login, or 2FA, save a profile without password and run web_login_run with visible browser for manual completion.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional stable profile id to update.' },
        label: { type: 'string', description: 'Human label, e.g. Work Notion.' },
        loginUrl: { type: 'string', description: 'Login URL, must start with http:// or https://.' },
        matchHosts: { type: 'array', items: { type: 'string' }, description: 'Hostnames that should reuse this profile, e.g. ["example.com", "app.example.com"].' },
        username: { type: 'string', description: 'Username/email. Optional for QR/SSO/manual profiles.' },
        password: { type: 'string', description: 'Password to encrypt locally. Optional; omit to keep existing password.' },
        usernameSelector: { type: 'string', description: 'Optional CSS selector for username field.' },
        passwordSelector: { type: 'string', description: 'Optional CSS selector for password field.' },
        submitSelector: { type: 'string', description: 'Optional CSS selector for submit button.' },
        successUrlPattern: { type: 'string', description: 'Optional RegExp tested against URL to decide login success.' },
        notes: { type: 'string', description: 'Operator notes, setup caveats, or 2FA instructions.' },
      },
      required: ['loginUrl'],
    },
    handler: async (args, context) => {
      assertCanMutateWebLoginProfile(context);
      return JSON.stringify({
        ok: true,
        status: 'saved',
        profile: saveWebLoginProfile({
          id: args.id,
          label: args.label,
          loginUrl: String(args.loginUrl || ''),
          matchHosts: Array.isArray(args.matchHosts) ? args.matchHosts.map(String) : undefined,
          username: args.username,
          password: args.password,
          usernameSelector: args.usernameSelector,
          passwordSelector: args.passwordSelector,
          submitSelector: args.submitSelector,
          successUrlPattern: args.successUrlPattern,
          notes: args.notes,
        }, scopeFromContext(context)),
        note: 'Saved. Run web_login_run to create or refresh the browser session.',
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'web.login.profile.save',
      family: 'web_login',
      lane: 'web',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [
        { type: 'local_state_change', scope: 'authorized website login profile', reversible: true },
        { type: 'credential_access', scope: 'optional encrypted website credential', reversible: true },
      ],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'profile.id', 'profile.loginUrl'],
        requiredValues: { ok: true, status: 'saved' },
        successStatuses: ['saved'],
        successSignals: ['the authorized profile was persisted in the current scope'],
        limitations: ['Saving a profile does not log into the website.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'web.login.profile.save',
      operation: 'mutate',
      subjectArgument: 'loginUrl',
    }),
  });

  registry.register({
    name: 'web_login_learn_site',
    description: [
      'Learn an authorized login flow for any website, not just built-in presets.',
      'Creates or updates a generic login profile, saves encrypted credentials when provided, opens a real Chrome/Edge persistent session, and records reusable session/selector signals.',
      'If the browser or website has remembered credentials, Lumi can detect autofilled fields and submit; captcha, QR login, 2FA, passkeys, account switching, and third-party authorization remain manual confirmation boundaries.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Login or target URL to learn, must start with http:// or https://.' },
        profileId: { type: 'string', description: 'Optional existing profile id to update.' },
        id: { type: 'string', description: 'Optional stable profile id for a new profile. Defaults to the host name.' },
        label: { type: 'string', description: 'Human label, e.g. 抖店后台 / Google AI Studio / Company CRM.' },
        matchHosts: { type: 'array', items: { type: 'string' }, description: 'Hostnames that should reuse this profile.' },
        username: { type: 'string', description: 'Optional username/email/phone to store for this profile.' },
        password: { type: 'string', description: 'Optional password to encrypt locally. Omit for browser/session-only learning.' },
        usernameSelector: { type: 'string', description: 'Optional CSS selector for username field.' },
        passwordSelector: { type: 'string', description: 'Optional CSS selector for password field.' },
        submitSelector: { type: 'string', description: 'Optional CSS selector for submit button.' },
        successUrlPattern: { type: 'string', description: 'Optional RegExp tested against URL to decide login success.' },
        notes: { type: 'string', description: 'Operator notes, setup caveats, account ownership, or 2FA instructions.' },
        headless: { type: 'boolean', description: 'Run without showing browser. Defaults false so the user can complete verification.' },
        autoSubmit: { type: 'boolean', description: 'Submit after filling or detecting autofilled credentials. Defaults true.' },
        waitForManualMs: { type: 'number', description: 'How long to wait for manual captcha/QR/2FA completion, default 45000, max 180000.' },
      },
      required: ['url'],
    },
    handler: async (args, context) => {
      assertCanMutateWebLoginProfile(context);
      return JSON.stringify(await learnWebLoginSite({
        url: String(args.url || ''),
        profileId: args.profileId,
        id: args.id,
        label: args.label,
        matchHosts: Array.isArray(args.matchHosts) ? args.matchHosts.map(String) : undefined,
        username: args.username,
        password: args.password,
        usernameSelector: args.usernameSelector,
        passwordSelector: args.passwordSelector,
        submitSelector: args.submitSelector,
        successUrlPattern: args.successUrlPattern,
        notes: args.notes,
        headless: args.headless === true,
        autoSubmit: args.autoSubmit !== false,
        waitForManualMs: Number(args.waitForManualMs) || undefined,
      }, scopeFromContext(context)), null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'web.login.site.learn',
      family: 'web_login',
      lane: 'web',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [
        { type: 'local_state_change', scope: 'website login profile and learned selectors', reversible: true },
        { type: 'credential_access', scope: 'authorized website session and optional encrypted credential', reversible: true },
        { type: 'desktop_control', scope: 'persistent browser login session', reversible: true },
      ],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['status', 'loginState', 'profile.id', 'learned.profileId', 'url'],
        requiredValues: { status: 'logged_in', loginState: 'authenticated' },
        successStatuses: ['logged_in'],
        successSignals: ['positive authenticated-session evidence and persisted learned profile metadata'],
        limitations: ['Captcha, QR, OTP, passkey, and account authorization may leave the task awaiting the user.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'web.login.site.learn',
      operation: 'mutate',
      subjectArgument: 'url',
      limitations: ['manual_required is a partial result, not a successful login.'],
    }),
  });

  registry.register({
    name: 'web_login_profile_delete',
    description: 'Delete a saved website login profile from the current personal/work scope.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Profile id to delete.' },
      },
      required: ['id'],
    },
    handler: async (args, context) => {
      assertCanMutateWebLoginProfile(context);
      const deleted = deleteWebLoginProfile(String(args.id || ''), scopeFromContext(context));
      return JSON.stringify({
        ok: deleted,
        status: deleted ? 'deleted' : 'not_found',
        deleted,
        profileId: String(args.id || ''),
      }, null, 2);
    },
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'web.login.profile.delete',
      family: 'web_login',
      lane: 'web',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [
        { type: 'local_state_change', scope: 'website login profile and local browser session', reversible: false },
        { type: 'credential_access', scope: 'stored encrypted website credential', reversible: false },
      ],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'deleted', 'profileId'],
        requiredValues: { ok: true, status: 'deleted', deleted: true },
        successStatuses: ['deleted'],
        successSignals: ['the profile and its local persistent session were removed'],
        limitations: ['Deletion cannot recover the previous encrypted credential or browser session.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'web.login.profile.delete',
      operation: 'mutate',
      subjectArgument: 'id',
    }),
  });

  registry.register({
    name: 'web_login_run',
    description: [
      'Open a real Chrome/Edge login session for a saved profile.',
      'Lumi fills saved credentials when available, then waits for manual captcha/2FA/passkey completion if needed.',
      'The session is persisted locally for later authenticated browsing.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Saved profile id. If omitted, url is matched by host.' },
        url: { type: 'string', description: 'Optional target URL. If omitted, profile.loginUrl is opened.' },
        headless: { type: 'boolean', description: 'Run without showing browser. Defaults false so the user can complete 2FA.' },
        autoSubmit: { type: 'boolean', description: 'Submit after filling credentials. Defaults true.' },
        waitForManualMs: { type: 'number', description: 'How long to wait for manual 2FA/captcha, default 45000, max 180000.' },
        keepOpenMs: { type: 'number', description: 'How long a visible browser stays open for continued viewing and work, default 30 minutes, max 24 hours.' },
      },
      required: [],
    },
    handler: async (args, context) => JSON.stringify(await runWebLogin({
      profileId: args.profileId,
      url: args.url,
      headless: args.headless === true,
      autoSubmit: args.autoSubmit !== false,
      waitForManualMs: Number(args.waitForManualMs) || undefined,
      keepOpenMs: Number(args.keepOpenMs) || undefined,
    }, scopeFromContext(context)), null, 2),
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'web.login.session.run',
      family: 'web_login',
      lane: 'web',
      operation: 'mutate',
      risk: 'medium',
      sideEffects: [
        { type: 'credential_access', scope: 'authorized saved website session', reversible: true },
        { type: 'desktop_control', scope: 'persistent Chrome or Edge login session', reversible: true },
      ],
      verification: {
        strategy: 'state_diff',
        required: true,
        requiredFields: ['status', 'loginState', 'profile.id', 'url'],
        requiredValues: { status: 'logged_in', loginState: 'authenticated' },
        successStatuses: ['logged_in'],
        successSignals: ['the site exposed positive authenticated-session evidence'],
        limitations: ['manual_required means the browser opened but authentication is incomplete.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'web.login.session.run',
      operation: 'mutate',
      subjectArgument: 'profileId',
      limitations: ['Opening a login page is not a successful authenticated session.'],
    }),
  });

  registry.register({
    name: 'url_fetch_logged_in',
    description: 'Fetch and extract text from a URL using a saved web login profile and persisted browser session. Use this for pages where normal url_fetch says login is required.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Authenticated page URL.' },
        profileId: { type: 'string', description: 'Optional profile id. If omitted, a matching host profile is used.' },
        maxChars: { type: 'number', description: 'Maximum extracted characters, default 12000, max 50000.' },
      },
      required: ['url'],
    },
    handler: async (args, context) => JSON.stringify(await fetchWithWebLogin(
      String(args.url || ''),
      scopeFromContext(context),
      args.profileId,
      Number(args.maxChars) || 12000,
    ), null, 2),
    permission: 'user',
    securityLevel: 'safe',
  });
}
