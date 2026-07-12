import { describe, expect, it } from 'vitest';
import { classifyLoginPageSnapshot } from '../server/web_login/manager';

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
});
