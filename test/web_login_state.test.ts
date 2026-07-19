import { describe, expect, it } from 'vitest';
import {
  classifyLoginPageSnapshot,
  shouldAutoSubmitLoginForm,
  webLoginProfileAllowsUrl,
} from '../server/web_login/manager';

describe('web login page state classification', () => {
  it('does not mistake a captcha page for a completed login', () => {
    const result = classifyLoginPageSnapshot({
      url: 'https://example.com/security/challenge',
      title: 'Security verification',
      leadingText: 'Enter the verification code',
      hasChallengeControl: true,
    });

    expect(result.state).toBe('verification_required');
  });

  it('lets visible verification evidence override an overly broad success URL pattern', () => {
    const result = classifyLoginPageSnapshot({
      url: 'https://example.com/security/challenge',
      explicitSuccess: true,
      hasChallengeControl: true,
    });

    expect(result.state).toBe('verification_required');
  });

  it('keeps a visible credential form in login-required state', () => {
    const result = classifyLoginPageSnapshot({
      url: 'https://example.com/login',
      hasUsernameField: true,
      hasPasswordField: true,
      hasSubmitControl: true,
    });

    expect(result.state).toBe('login_required');
  });

  it('accepts explicit success and visible account evidence', () => {
    expect(classifyLoginPageSnapshot({
      url: 'https://example.com/cases',
      explicitSuccess: true,
    }).state).toBe('authenticated');

    expect(classifyLoginPageSnapshot({
      url: 'https://example.com/dashboard',
      hasAuthenticatedControl: true,
    }).state).toBe('authenticated');
  });

  it('reports accessible pages without account evidence as uncertain', () => {
    const result = classifyLoginPageSnapshot({
      url: 'https://example.com/article/1',
      title: 'Article',
      leadingText: 'Public or account content',
    });

    expect(result.state).toBe('uncertain');
  });

  it('does not treat navigation away from login as proof of authentication', () => {
    const result = classifyLoginPageSnapshot({
      url: 'https://example.com/terms',
      title: 'Accept updated terms',
      navigatedAwayFromLogin: true,
    });

    expect(result.state).toBe('uncertain');
    expect(result.reason).toContain('no positive authenticated-session signal');
  });

  it('binds saved credentials to exact authorized hosts and their subdomains', () => {
    const profile = { matchHosts: ['example.com', 'https://login.partner.test/path'] };

    expect(webLoginProfileAllowsUrl(profile, 'https://example.com/login')).toBe(true);
    expect(webLoginProfileAllowsUrl(profile, 'https://accounts.example.com/login')).toBe(true);
    expect(webLoginProfileAllowsUrl(profile, 'https://login.partner.test/sso')).toBe(true);
    expect(webLoginProfileAllowsUrl(profile, 'https://example.com.evil.test/login')).toBe(false);
    expect(webLoginProfileAllowsUrl(profile, 'https://evil.test/login')).toBe(false);
  });

  it('never auto-submits after a captcha, OTP, QR, or passkey challenge is detected', () => {
    expect(shouldAutoSubmitLoginForm(true, true, {
      state: 'verification_required',
      reason: 'Challenge visible',
    })).toBe(false);
    expect(shouldAutoSubmitLoginForm(true, true, {
      state: 'login_required',
      reason: 'Credential form visible',
    })).toBe(true);
  });
});
