// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ config: vi.fn(), saveConfig: vi.fn() }));
vi.mock('../src/services/memoryAvatarPortraitService', () => ({ memoryAvatarPortraitService: fixture }));
import { MemoryAvatarPortraitSettings } from '../src/components/MemoryAvatarPortraitSettings';
const config = { provider: 'did', configured: false, available: false, cloudAllowed: true };
beforeEach(() => { fixture.config.mockReset().mockResolvedValue(config); fixture.saveConfig.mockReset().mockResolvedValue({ ...config, configured: true, available: true }); });
afterEach(cleanup);
describe('private talking portrait settings', () => {
  it('allows first-time setup and clears the draft key after a confirmed save', async () => {
    render(<MemoryAvatarPortraitSettings ownerId="owner" locale="en" />);
    await screen.findByText('No service key configured');
    const input = screen.getByLabelText('D-ID API key') as HTMLInputElement;
    expect(input.disabled).toBe(false); expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: 'fixture-user:fixture-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    await screen.findByText('Settings saved');
    expect(input.value).toBe('');
    expect(fixture.saveConfig).toHaveBeenCalledWith({ apiKey: 'fixture-user:fixture-password', cloudConsent: true }, expect.any(AbortSignal));
    expect(screen.queryByText('fixture-user:fixture-password')).toBeNull();
  });
  it('does not replay a failed configuration write or claim it saved', async () => {
    fixture.saveConfig.mockRejectedValueOnce(new Error('Save receipt lost'));
    render(<MemoryAvatarPortraitSettings ownerId="owner" locale="en" />);
    await screen.findByText('No service key configured');
    fireEvent.change(screen.getByLabelText('D-ID API key'), { target: { value: 'fixture:key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('Settings saved')).toBeNull(); expect(fixture.saveConfig).toHaveBeenCalledOnce();
  });
  it('removes the previous account draft immediately and ignores its late save receipt', async () => {
    let saved!: (value: any) => void;
    fixture.saveConfig.mockReturnValueOnce(new Promise(resolve => { saved = resolve; }));
    const view = render(<MemoryAvatarPortraitSettings ownerId="owner-a" locale="en" />);
    await screen.findByText('No service key configured');
    fireEvent.change(screen.getByLabelText('D-ID API key'), { target: { value: 'fixture:private-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    view.rerender(<MemoryAvatarPortraitSettings ownerId="owner-b" locale="en" />);
    expect((screen.getByLabelText('D-ID API key') as HTMLInputElement).value).toBe('');
    await act(async () => { saved({ ...config, configured: true, available: true }); });
    expect(fixture.saveConfig.mock.calls[0][1].aborted).toBe(true);
    expect(screen.queryByText('Settings saved')).toBeNull();
    expect(screen.getByText('No service key configured')).toBeTruthy();
  });
  it('blocks cloud setup in strict mode while allowing removal of the saved key', async () => {
    fixture.config.mockResolvedValueOnce({ ...config, configured: true, cloudAllowed: false });
    render(<MemoryAvatarPortraitSettings ownerId="owner" locale="en" />);
    await screen.findByText('Service key saved');
    expect((screen.getByLabelText('D-ID API key') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    await vi.waitFor(() => expect(fixture.saveConfig).toHaveBeenCalledWith({ clearKey: true, cloudConsent: true }, expect.any(AbortSignal)));
  });
});
