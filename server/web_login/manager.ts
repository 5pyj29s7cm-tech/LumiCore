import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { getDataPath } from '../config/data_path';

export type WebLoginScope = {
  userId?: string;
  domain?: string;
  orgId?: string;
};

export type WebLoginProfileInput = {
  id?: string;
  label?: string;
  loginUrl: string;
  matchHosts?: string[];
  username?: string;
  password?: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  successUrlPattern?: string;
  notes?: string;
};

export type WebLoginProfile = Omit<WebLoginProfileInput, 'password'> & {
  id: string;
  label: string;
  matchHosts: string[];
  passwordCipher?: string;
  ownerUid: string;
  domain: string;
  orgId: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  lastLoginStatus?: string;
};

export type PublicWebLoginProfile = Omit<WebLoginProfile, 'passwordCipher'> & {
  hasPassword: boolean;
};

export type LoginRunOptions = {
  profileId?: string;
  url?: string;
  headless?: boolean;
  autoSubmit?: boolean;
  waitForManualMs?: number;
};

export type WebLoginLearnOptions = LoginRunOptions & {
  url: string;
  id?: string;
  label?: string;
  username?: string;
  password?: string;
  matchHosts?: string[];
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  successUrlPattern?: string;
  notes?: string;
};

const STORE_FILE = getDataPath('web_login/profiles.json');
const SECRET_FILE = getDataPath('web_login/secret.key');
const SESSION_ROOT = getDataPath('web_login/sessions/.keep');

const COMMON_USERNAME_SELECTORS = [
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[type="email"]',
  'input[name*="email" i]',
  'input[id*="email" i]',
  'input[name*="user" i]',
  'input[id*="user" i]',
  'input[name*="account" i]',
  'input[id*="account" i]',
  'input[name*="login" i]',
  'input[id*="login" i]',
  'input[name*="phone" i]',
  'input[id*="phone" i]',
  'input[placeholder*="账号"]',
  'input[placeholder*="帐号"]',
  'input[placeholder*="手机"]',
  'input[placeholder*="邮箱"]',
  'input[placeholder*="用户名"]',
  'input[placeholder*="登录"]',
  'input[type="text"]',
];

const COMMON_SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("登录")',
  'button:has-text("登 录")',
  'button:has-text("Login")',
  'button:has-text("Log in")',
  'button:has-text("Sign in")',
  'button:has-text("Sign In")',
  'button:has-text("Continue")',
  'button:has-text("继续")',
  'button:has-text("下一步")',
  'input[value*="登录"]',
  'input[value*="Login"]',
];

function ensureStore(): void {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  fs.mkdirSync(path.dirname(SESSION_ROOT), { recursive: true });
  if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, '[]', 'utf-8');
}

function readProfiles(): WebLoginProfile[] {
  ensureStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeProfiles(profiles: WebLoginProfile[]): void {
  ensureStore();
  fs.writeFileSync(STORE_FILE, JSON.stringify(profiles, null, 2), 'utf-8');
}

function scopeDefaults(scope?: WebLoginScope) {
  const domain = scope?.domain === 'work' ? 'work' : 'personal';
  return {
    ownerUid: scope?.userId || 'anonymous',
    domain,
    orgId: domain === 'work' ? (scope?.orgId || '') : '',
  };
}

function profileMatchesScope(profile: WebLoginProfile, scope?: WebLoginScope): boolean {
  const normalized = scopeDefaults(scope);
  if (normalized.domain === 'work') {
    return profile.domain === 'work' && profile.orgId === normalized.orgId;
  }
  return profile.domain !== 'work' && profile.ownerUid === normalized.ownerUid;
}

function toSlug(value: string): string {
  return value.toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'site';
}

function normalizeUrl(value: string): URL {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw)) throw new Error('loginUrl/url must start with http:// or https://');
  return new URL(raw);
}

function inferHosts(loginUrl: string, matchHosts?: string[]): string[] {
  const url = normalizeUrl(loginUrl);
  const hosts = new Set([url.hostname.toLowerCase()]);
  for (const host of matchHosts || []) {
    const normalized = String(host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (normalized) hosts.add(normalized);
  }
  return [...hosts];
}

function getSecret(): Buffer {
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  if (fs.existsSync(SECRET_FILE)) {
    return Buffer.from(fs.readFileSync(SECRET_FILE, 'utf-8').trim(), 'base64');
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, key.toString('base64'), { encoding: 'utf-8', mode: 0o600 });
  return key;
}

function encryptSecret(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getSecret(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(cipherText?: string): string {
  if (!cipherText) return '';
  const [version, ivRaw, tagRaw, encryptedRaw] = cipherText.split(':');
  if (version !== 'v1' || !ivRaw || !tagRaw || !encryptedRaw) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', getSecret(), Buffer.from(ivRaw, 'base64'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, 'base64')),
    decipher.final(),
  ]).toString('utf-8');
}

function publicProfile(profile: WebLoginProfile): PublicWebLoginProfile {
  const { passwordCipher, ...rest } = profile;
  return { ...rest, hasPassword: Boolean(passwordCipher) };
}

export function listWebLoginProfiles(scope?: WebLoginScope): PublicWebLoginProfile[] {
  return readProfiles().filter(profile => profileMatchesScope(profile, scope)).map(publicProfile);
}

export function saveWebLoginProfile(input: WebLoginProfileInput, scope?: WebLoginScope): PublicWebLoginProfile {
  const loginUrl = normalizeUrl(input.loginUrl).toString();
  const now = new Date().toISOString();
  const profiles = readProfiles();
  const scoped = scopeDefaults(scope);
  const id = input.id?.trim() || `${toSlug(new URL(loginUrl).hostname)}-${crypto.randomBytes(3).toString('hex')}`;
  const existingIndex = profiles.findIndex(profile => profile.id === id && profileMatchesScope(profile, scope));
  const existing = existingIndex >= 0 ? profiles[existingIndex] : undefined;
  const next: WebLoginProfile = {
    ...(existing || {}),
    id,
    label: input.label?.trim() || existing?.label || new URL(loginUrl).hostname,
    loginUrl,
    matchHosts: inferHosts(loginUrl, input.matchHosts || existing?.matchHosts),
    username: input.username ?? existing?.username ?? '',
    usernameSelector: input.usernameSelector ?? existing?.usernameSelector ?? '',
    passwordSelector: input.passwordSelector ?? existing?.passwordSelector ?? '',
    submitSelector: input.submitSelector ?? existing?.submitSelector ?? '',
    successUrlPattern: input.successUrlPattern ?? existing?.successUrlPattern ?? '',
    notes: input.notes ?? existing?.notes ?? '',
    passwordCipher: input.password ? encryptSecret(input.password) : existing?.passwordCipher,
    ownerUid: scoped.ownerUid,
    domain: scoped.domain,
    orgId: scoped.orgId,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastLoginAt: existing?.lastLoginAt,
    lastLoginStatus: existing?.lastLoginStatus,
  };
  if (existingIndex >= 0) profiles[existingIndex] = next;
  else profiles.push(next);
  writeProfiles(profiles);
  return publicProfile(next);
}

export function deleteWebLoginProfile(id: string, scope?: WebLoginScope): boolean {
  const profiles = readProfiles();
  const next = profiles.filter(profile => !(profile.id === id && profileMatchesScope(profile, scope)));
  writeProfiles(next);
  return next.length !== profiles.length;
}

function getProfile(id: string, scope?: WebLoginScope): WebLoginProfile {
  const profile = readProfiles().find(item => item.id === id && profileMatchesScope(item, scope));
  if (!profile) throw new Error(`Web login profile "${id}" not found.`);
  return profile;
}

export function findWebLoginProfileForUrl(targetUrl: string, scope?: WebLoginScope): WebLoginProfile | undefined {
  const host = normalizeUrl(targetUrl).hostname.toLowerCase();
  return readProfiles()
    .filter(profile => profileMatchesScope(profile, scope))
    .find(profile => profile.matchHosts.some(match => host === match || host.endsWith(`.${match}`)));
}

function defaultProfileIdForUrl(targetUrl: string): string {
  return toSlug(normalizeUrl(targetUrl).hostname);
}

function findBrowserExecutable(): string {
  const candidates = [
    process.env.LUMI_BROWSER_EXECUTABLE || '',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error('No Chrome/Edge executable found. Set LUMI_BROWSER_EXECUTABLE to enable web login automation.');
  return found;
}

function sessionDir(profile: WebLoginProfile, scope?: WebLoginScope): string {
  const scoped = scopeDefaults(scope);
  const key = scoped.domain === 'work' ? `work-${toSlug(scoped.orgId || 'org')}` : `user-${toSlug(scoped.ownerUid)}`;
  const dir = path.join(path.dirname(SESSION_ROOT), key, toSlug(profile.id));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function openContext(profile: WebLoginProfile, scope?: WebLoginScope, headless = false): Promise<BrowserContext> {
  return chromium.launchPersistentContext(sessionDir(profile, scope), {
    executablePath: findBrowserExecutable(),
    headless,
    viewport: { width: 1360, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

async function firstVisibleMatch(page: Page, selectors: string[]): Promise<{ locator: Locator; selector: string } | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count() > 0 && await locator.isVisible({ timeout: 600 })) return { locator, selector };
    } catch {
      // Try next selector.
    }
  }
  return null;
}

async function visibleMatch(page: Page, preferredSelector: string | undefined, fallbackSelectors: string[]): Promise<{ locator: Locator; selector: string } | null> {
  if (preferredSelector) {
    const preferred = await firstVisibleMatch(page, [preferredSelector]);
    if (preferred) return preferred;
  }
  return firstVisibleMatch(page, fallbackSelectors);
}

async function firstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
  return (await firstVisibleMatch(page, selectors))?.locator || null;
}

async function loginLooksComplete(page: Page, profile: WebLoginProfile): Promise<boolean> {
  if (profile.successUrlPattern) {
    try {
      if (new RegExp(profile.successUrlPattern).test(page.url())) return true;
    } catch {
      // Ignore invalid user-provided regexp and fall through to heuristics.
    }
  }
  const password = await firstVisible(page, ['input[type="password"]']);
  if (password) return false;
  const username = await firstVisible(page, COMMON_USERNAME_SELECTORS);
  const submit = await firstVisible(page, COMMON_SUBMIT_SELECTORS);
  if (username && submit) return false;
  return true;
}

async function waitForLoginCompletion(page: Page, profile: WebLoginProfile, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(1000, waitMs);
  while (Date.now() < deadline) {
    if (await loginLooksComplete(page, profile)) return true;
    await page.waitForTimeout(1000);
  }
  return loginLooksComplete(page, profile);
}

async function hasAutofilledValue(locator: Locator | null): Promise<boolean> {
  if (!locator) return false;
  try {
    return Boolean((await locator.inputValue({ timeout: 800 })).trim());
  } catch {
    return false;
  }
}

async function fillLoginForm(page: Page, profile: WebLoginProfile, autoSubmit: boolean): Promise<{
  filledUsername: boolean;
  filledPassword: boolean;
  submitted: boolean;
  usedBrowserAutofill: boolean;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
}> {
  const password = decryptSecret(profile.passwordCipher);
  let filledUsername = false;
  let filledPassword = false;
  let submitted = false;
  let usedBrowserAutofill = false;
  let usernameSelector: string | undefined;
  let passwordSelector: string | undefined;
  let submitSelector: string | undefined;

  const usernameMatch = await visibleMatch(page, profile.usernameSelector, COMMON_USERNAME_SELECTORS);
  if (usernameMatch) {
    usernameSelector = usernameMatch.selector;
    if (profile.username) {
      await usernameMatch.locator.fill(profile.username, { timeout: 5000 });
      filledUsername = true;
    } else if (await hasAutofilledValue(usernameMatch.locator)) {
      filledUsername = true;
      usedBrowserAutofill = true;
    }
  }

  const passwordMatch = await visibleMatch(page, profile.passwordSelector, ['input[type="password"]']);
  if (passwordMatch) {
    passwordSelector = passwordMatch.selector;
    if (password) {
      await passwordMatch.locator.fill(password, { timeout: 5000 });
      filledPassword = true;
    } else if (await hasAutofilledValue(passwordMatch.locator)) {
      filledPassword = true;
      usedBrowserAutofill = true;
    }
  }

  if (autoSubmit && (filledUsername || filledPassword)) {
    const submitMatch = await visibleMatch(page, profile.submitSelector, COMMON_SUBMIT_SELECTORS);
    submitSelector = submitMatch?.selector;
    if (submitMatch) {
      await Promise.allSettled([
        page.waitForLoadState('domcontentloaded', { timeout: 12000 }),
        submitMatch.locator.click({ timeout: 5000 }),
      ]);
      submitted = true;
    } else if (passwordMatch) {
      await passwordMatch.locator.press('Enter');
      submitted = true;
    }
  }

  return { filledUsername, filledPassword, submitted, usedBrowserAutofill, usernameSelector, passwordSelector, submitSelector };
}

function updateProfileLoginStatus(
  profile: WebLoginProfile,
  status: string,
  patch: Partial<Pick<WebLoginProfile, 'usernameSelector' | 'passwordSelector' | 'submitSelector'>> = {},
): WebLoginProfile | undefined {
  const profiles = readProfiles();
  const idx = profiles.findIndex(item => item.id === profile.id && item.ownerUid === profile.ownerUid && item.domain === profile.domain && item.orgId === profile.orgId);
  if (idx < 0) return undefined;
  profiles[idx] = {
    ...profiles[idx],
    ...patch,
    lastLoginAt: new Date().toISOString(),
    lastLoginStatus: status,
    updatedAt: new Date().toISOString(),
  };
  writeProfiles(profiles);
  return profiles[idx];
}

export async function runWebLogin(options: LoginRunOptions, scope?: WebLoginScope) {
  const target = options.url ? normalizeUrl(options.url).toString() : '';
  const profile = options.profileId
    ? getProfile(options.profileId, scope)
    : findWebLoginProfileForUrl(target, scope);
  if (!profile) throw new Error('No matching web login profile found. Save one first.');

  const context = await openContext(profile, scope, options.headless === true);
  const page = context.pages()[0] || await context.newPage();
  const waitMs = Math.min(Math.max(Number(options.waitForManualMs) || 45000, 3000), 180000);
  try {
    await page.goto(target || profile.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const fill = await fillLoginForm(page, profile, options.autoSubmit !== false);
    const ok = await waitForLoginCompletion(page, profile, waitMs);
    const status = ok ? 'logged_in' : 'manual_required';
    const updatedProfile = updateProfileLoginStatus(profile, status, {
      usernameSelector: profile.usernameSelector || fill.usernameSelector || '',
      passwordSelector: profile.passwordSelector || fill.passwordSelector || '',
      submitSelector: profile.submitSelector || fill.submitSelector || '',
    }) || profile;
    return {
      status,
      profile: publicProfile(updatedProfile),
      url: page.url(),
      filledUsername: fill.filledUsername,
      filledPassword: fill.filledPassword,
      submitted: fill.submitted,
      usedBrowserAutofill: fill.usedBrowserAutofill,
      learnedSelectors: {
        usernameSelector: updatedProfile.usernameSelector || '',
        passwordSelector: updatedProfile.passwordSelector || '',
        submitSelector: updatedProfile.submitSelector || '',
      },
      note: ok
        ? 'Login/session is available in the persistent browser profile.'
        : 'Manual action may be required: captcha, QR login, 2FA, passkey, or non-standard login form. Complete it in the opened browser and run again.',
    };
  } finally {
    await context.close();
  }
}

export async function learnWebLoginSite(options: WebLoginLearnOptions, scope?: WebLoginScope) {
  const loginUrl = normalizeUrl(options.url).toString();
  const existing = options.profileId ? getProfile(options.profileId, scope) : findWebLoginProfileForUrl(loginUrl, scope);
  const profile = saveWebLoginProfile({
    id: options.id || options.profileId || existing?.id || defaultProfileIdForUrl(loginUrl),
    label: options.label || existing?.label || normalizeUrl(loginUrl).hostname,
    loginUrl,
    matchHosts: options.matchHosts || existing?.matchHosts,
    username: options.username ?? existing?.username,
    password: options.password,
    usernameSelector: options.usernameSelector ?? existing?.usernameSelector,
    passwordSelector: options.passwordSelector ?? existing?.passwordSelector,
    submitSelector: options.submitSelector ?? existing?.submitSelector,
    successUrlPattern: options.successUrlPattern ?? existing?.successUrlPattern,
    notes: [
      existing?.notes,
      options.notes,
      'Generic Lumi web login profile. Lumi may reuse encrypted credentials, browser autofill, cookies, and the local persistent session after user authorization.',
    ].filter(Boolean).join(' '),
  }, scope);
  const run = await runWebLogin({
    profileId: profile.id,
    url: loginUrl,
    headless: options.headless === true,
    autoSubmit: options.autoSubmit !== false,
    waitForManualMs: options.waitForManualMs,
  }, scope);
  return {
    ...run,
    learned: {
      profileId: profile.id,
      matchHosts: profile.matchHosts,
      encryptedPasswordStored: Boolean(options.password || profile.hasPassword),
      persistentSessionStored: true,
      browserAutofillSupported: true,
      scope: {
        domain: scopeDefaults(scope).domain,
        ownerUid: scopeDefaults(scope).ownerUid,
        orgId: scopeDefaults(scope).orgId,
      },
    },
    note: run.status === 'logged_in'
      ? 'Lumi learned this website login profile and saved the local session for future work.'
      : 'Lumi created the login profile, but the site still needs manual completion such as captcha, QR login, 2FA, passkey, or account approval.',
  };
}

function extractPlainText(raw: string, maxChars: number): string {
  let text = raw
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n\n[Truncated at ${maxChars} characters]`;
  return text || '(No text content extracted)';
}

export async function fetchWithWebLogin(url: string, scope?: WebLoginScope, profileId?: string, maxChars = 12000) {
  const target = normalizeUrl(url).toString();
  const profile = profileId ? getProfile(profileId, scope) : findWebLoginProfileForUrl(target, scope);
  if (!profile) throw new Error('No matching web login profile found for this URL.');

  const context = await openContext(profile, scope, true);
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const needsLogin = Boolean(await firstVisible(page, ['input[type="password"]']));
    if (needsLogin && profile.passwordCipher) {
      await page.goto(profile.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await fillLoginForm(page, profile, true);
      await waitForLoginCompletion(page, profile, 20000);
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    const html = await page.content();
    const title = await page.title().catch(() => '');
    return {
      profile: publicProfile(profile),
      title,
      url: page.url(),
      text: extractPlainText(html, Math.min(Math.max(maxChars, 500), 50000)),
    };
  } finally {
    await context.close();
  }
}
