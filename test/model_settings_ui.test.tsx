// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { useLocalModelConfig } from '../src/hooks/useLocalModelConfig';
import { extractSourceExpression } from './source_expression';
import { apiJson } from '../src/services/apiClient';
import { LUMI_OFFICIAL_DEFAULT_MODELS } from '../shared/model_provider_capabilities';
import { mediaGenerationCopy } from '../src/i18n/locales/mediaGeneration';
const fixture = vi.hoisted(() => ({ net: vi.fn(), update: vi.fn(), save: vi.fn(), connect: vi.fn() }));
vi.mock('../src/services/apiClient', async () => ({ apiJson: (await import('./source_expression')).extractSourceExpression('src/services/apiClient.ts', 'apiJson', { apiFetch: fixture.net }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
const reply = (data: any = { detected: false, models: [] }, status = 200) => ({ ok: status < 400, status, json: async () => data });
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; }
const button = (name: string) => screen.getByRole('button', { name });
beforeEach(() => { localStorage.clear(); fixture.net.mockResolvedValue(reply()); fixture.update.mockResolvedValue(true); fixture.save.mockResolvedValue(undefined); fixture.connect.mockResolvedValue({ latencyMs: 7, model: 'model-a' }); vi.stubGlobal('fetch', fixture.net); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetAllMocks(); });

function settingsRow(providerId: string, context: any = { aiConfig: { provider: providerId } }) {
  const deps: any = {
    React, useState: React.useState, useEffect: React.useEffect, useRef: React.useRef, useCallback: React.useCallback, AbortController, AbortSignal, useLocalModelConfig, localStorage, apiFetch: fixture.net,
    useApp: () => ({ user: { uid: 'synthetic-owner', role: 'admin' }, ...context, updateAIConfig: fixture.update }), uiMessage: (key: string) => key.split('.')[1], formatUiMessage: (key: string) => key.split('.')[1],
    runModelConnectionTest: fixture.connect, getSavedKeyStatus: async () => ({ OPENAI_API_KEY: true }), saveServerKeys: fixture.save,
    SettingsDisclosure: ({ children, badges }: any) => <div>{badges}{children}</div>, Button: (props: any) => <button {...props} />,
    Cpu: () => null, Loader2: () => null, CheckCircle: () => null,
  };
  for (const name of ['useModelOperation', 'useServerCredentials', 'ModelSettingsStatus', 'useProviderModel', 'LLMProviderEditor']) {
    try { deps[name] = extractSourceExpression('src/components/Settings.tsx', name, deps); } catch { /* Baselines can predate shared hooks. */ }
  }
  const Row = extractSourceExpression('src/components/Settings.tsx', providerId === 'openai' ? 'LLMProviderRow' : 'LocalLLMProviderRow', deps);
  return () => <Row providerId={providerId} label={providerId} endpoint={'/api/' + providerId + '/config'} storageKey={'lumi_' + providerId + '_url'} defaultUrl="http://localhost:1" defaultModel="model-a" accent="amber" models={['model-a']} serverKey="OPENAI_API_KEY" placeholder="key" />;
}

it.each(['ollama', 'lmstudio'])('settings %s rejects late address loads and obsolete detection results', async providerId => {
  const Row = settingsRow(providerId);
  const pending = deferred(), old = deferred(); fixture.net.mockReturnValueOnce(pending.promise).mockReturnValueOnce(old.promise);
  const view = render(<Row />);
  const input = screen.getByPlaceholderText('http://localhost:1'); fireEvent.change(input, { target: { value: 'http://localhost:2' } });
  await act(async () => pending.resolve(reply({ baseUrl: 'http://localhost:1', detected: true, models: ['model-a'] })));
  expect(input).toHaveProperty('value', 'http://localhost:2'); expect(button('use')).toHaveProperty('disabled', true);
  fireEvent.click(button('detect')); fireEvent.change(input, { target: { value: 'http://localhost:3' } });
  fixture.net.mockResolvedValueOnce(reply({ baseUrl: 'http://localhost:3', detected: true, models: ['model-a', 'Whisper', 42] })); fireEvent.click(button('detect'));
  await waitFor(() => expect(button('use')).toHaveProperty('disabled', false));
  await act(async () => old.resolve(reply({ baseUrl: 'http://localhost:2', detected: false, models: [] })));
  expect(input).toHaveProperty('value', 'http://localhost:3'); expect(button('use')).toHaveProperty('disabled', false); expect(screen.queryByText('Whisper')).toBeNull();
  fireEvent.click(button('use')); expect(fixture.update).toHaveBeenCalledExactlyOnceWith({ provider: providerId, model: 'model-a' });
  view.unmount(); expect(fixture.net.mock.calls.every(([, init]) => init.signal?.aborted)).toBe(true);
});

it.each(['openai', 'ollama', 'lmstudio'].flatMap(provider => [false, true].map(firstSaved => ({ provider, firstSaved }))))('$provider isolates drafts and connection tests (first save=$firstSaved)', async ({ provider, firstSaved }) => {
  fixture.net.mockResolvedValue(reply({ detected: true, models: ['model-a'] })); const Row = settingsRow(provider), view = render(<Row />);
  await waitFor(() => expect(button('test')).toHaveProperty('disabled', false));
  const input = screen.getByRole('combobox');
  const first = deferred(), second = deferred(); fixture.update.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  fireEvent.change(input, { target: { value: 'model-b' } }); fireEvent.change(input, { target: { value: 'model-c' } });
  await act(async () => first.resolve(firstSaved)); expect(input).toHaveProperty('value', 'model-c');
  await act(async () => second.resolve(false)); expect(input).toHaveProperty('value', firstSaved ? 'model-b' : 'model-a');
  const old = deferred(); fixture.connect.mockReturnValueOnce(old.promise); act(() => { fireEvent.click(button('test')); fireEvent.click(button('test')); }); expect(fixture.connect).toHaveBeenCalledOnce();
  fireEvent.change(input, { target: { value: 'model-d' } }); await waitFor(() => expect(fixture.update).toHaveBeenCalledTimes(3));
  const next = deferred(), testButton = button('test'); fixture.connect.mockReturnValueOnce(next.promise); fireEvent.click(testButton);
  await act(async () => old.resolve(firstSaved ? Promise.reject(new Error('obsolete failure')) : { latencyMs: 10 }));
  expect(screen.queryByText('live-call-passed-value0-ms')).toBeNull(); expect(screen.queryByText('obsolete failure')).toBeNull(); expect(testButton).toHaveProperty('disabled', true); expect(fixture.connect.mock.calls[0][3].aborted).toBe(true);
  await act(async () => next.resolve({ latencyMs: 11 })); await screen.findByText('live-call-passed-value0-ms');
  const pending = deferred(); fixture.connect.mockReturnValueOnce(pending.promise); fireEvent.click(button('test')); view.unmount();
  await act(async () => pending.resolve({ latencyMs: 12 })); expect(fixture.connect.mock.calls.at(-1)![3].aborted).toBe(true);
});

function modelPage(name: string, context: any = {}) {
  const deps: any = { React, useState: React.useState, useEffect: React.useEffect, useRef: React.useRef, useCallback: React.useCallback, AbortController, AbortSignal, localStorage, toast,
    apiFetch: fixture.net, apiJson, runModelConnectionTest: fixture.connect, useApp: () => ({ updateAIConfig: fixture.update, ...context }),
    uiMessage: (key: string) => key.split('.')[1], formatUiMessage: (key: string) => key.split('.')[1],
    LUMI_OFFICIAL_PROVIDER_ID: 'relay', LUMI_OFFICIAL_DEFAULT_MODELS, mediaGenerationCopy,
    useLumiOfficialCatalog: () => context.officialCatalog !== undefined ? context.officialCatalog : ({ byRole: {
      image_generation: [LUMI_OFFICIAL_DEFAULT_MODELS.image_generation],
      image_edit: [LUMI_OFFICIAL_DEFAULT_MODELS.image_edit],
      video_generation: [LUMI_OFFICIAL_DEFAULT_MODELS.video_generation],
      image_to_video: [LUMI_OFFICIAL_DEFAULT_MODELS.image_to_video],
    } }),
    officialModelOptions: (catalog: any, role: string, fallback: any) => catalog?.byRole[role] || fallback, lumiOfficialApiLabel: () => 'Lumi',
    LumiOfficialCapabilityBadge: () => null, SettingsSection: ({ children }: any) => <div>{children}</div>, Button: (props: any) => <button {...props} />,
    GenerationModelInput: ({ id, value, onChange }: any) => <input aria-label={id} value={value} onChange={event => onChange(event.target.value)} />,
    ...Object.fromEntries(['Globe', 'Search', 'BrainCircuit', 'Sparkle', 'Save', 'Zap', 'Loader2'].map(icon => [icon, () => null])),
  };
  for (const key of ['matchesModelSettings', 'ModelSettingsStatus', 'useModelOperation', 'useModelSettings', 'DEFAULT_GENERATION_PREFERENCES', 'GENERATION_MODEL_OPTIONS', 'IMAGE_GENERATION_PROVIDERS', 'VIDEO_GENERATION_PROVIDERS', 'WORLD_MODEL_OPTIONS', 'DEFAULT_RETRIEVAL_MODEL_PREFERENCES', 'EMBEDDING_MODEL_PROVIDERS', 'RERANK_MODEL_PROVIDERS', 'EMBEDDING_MODELS', 'RERANK_MODELS', 'retrievalProviderLabel', 'REASONING_MODEL_OPTIONS']) {
    try { deps[key] = extractSourceExpression('src/components/Settings.tsx', key, deps); } catch (error) { if (!['matchesModelSettings', 'ModelSettingsStatus', 'useModelOperation', 'useModelSettings'].includes(key)) throw error; }
  }
  const Page = extractSourceExpression('src/components/Settings.tsx', name, deps);
  return { Page: () => <Page t={{}} providerStatus={{}} />, defaults: deps };
}
const modelPages = [
  ['GenerativeModelsPage', 'DEFAULT_GENERATION_PREFERENCES', 'generation-relay-image-edit-model', 'save-model-roles'],
  ['WorldActionModelPage', '', 'world-model-openai', 'save-desktop-action-model'],
  ['RetrievalModelSettings', 'DEFAULT_RETRIEVAL_MODEL_PREFERENCES', 'embedding-openai-model', 'save'],
];
it.each(modelPages)('%s preserves edited drafts after an obsolete save and suppresses closed loads', async (name, defaultKey, inputId, saveLabel) => {
  const { Page, defaults } = modelPage(name, { visionConfig: { provider: 'openai', model: 'current-vision' } });
  const stored = defaultKey ? defaults[defaultKey] : { provider: 'openai', model: 'world-a', models: {} };
  fixture.net.mockResolvedValueOnce(reply(stored)); const view = render(<Page />), input = await screen.findByLabelText(inputId);
  const old = deferred(); fixture.net.mockReturnValueOnce(old.promise); act(() => { fireEvent.click(button(saveLabel)); fireEvent.click(button(saveLabel)); });
  expect(fixture.net).toHaveBeenCalledTimes(2); fireEvent.change(input, { target: { value: 'new-draft' } });
  await act(async () => old.resolve(reply(stored))); expect(input).toHaveProperty('value', 'new-draft'); expect(toast.success).not.toHaveBeenCalled(); expect(fixture.net.mock.calls[1][1].signal.aborted).toBe(true);
  view.unmount(); const loading = deferred(); fixture.net.mockReturnValueOnce(loading.promise); render(<Page />).unmount(); await act(async () => loading.resolve(reply({ error: 'obsolete load' }, 503))); expect(toast.error).not.toHaveBeenCalled();
});

it.each(['saved', 'rejected', 'edited', 'closed'])('retrieval test locks the save/test chain and honors %s saves', async outcome => {
  const { Page, defaults } = modelPage('RetrievalModelSettings'); const stored = defaults.DEFAULT_RETRIEVAL_MODEL_PREFERENCES;
  fixture.net.mockResolvedValueOnce(reply(stored)); const view = render(<Page />); await screen.findByLabelText('embedding-openai-model');
  const pending = deferred(); fixture.net.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(reply({ ok: true, embedding: { latencyMs: 7 }, rerank: { enabled: false } }));
  act(() => { fireEvent.click(button('test')); fireEvent.click(button('test')); fireEvent.click(button('save')); }); expect(fixture.net).toHaveBeenCalledTimes(2);
  if (outcome === 'edited') fireEvent.change(screen.getByLabelText('embedding-openai-model'), { target: { value: 'new-embedding' } });
  if (outcome === 'closed') view.unmount();
  await act(async () => pending.resolve(reply(outcome === 'rejected' ? { ok: false, error: 'save rejected' } : stored)));
  expect(fixture.net).toHaveBeenCalledTimes(outcome === 'saved' ? 3 : 2);
  if (outcome === 'saved') await screen.findByText('Embedding 7 ms · Rerank disabled');
  if (outcome === 'rejected') await screen.findByText('save rejected');
  if (outcome === 'edited') expect(screen.getByLabelText('embedding-openai-model')).toHaveProperty('value', 'new-embedding');
});

it('world tests track the current inherited vision model and ignore obsolete responses', async () => {
  const context = { visionConfig: { provider: 'openai', model: 'current-vision' } }, { Page } = modelPage('WorldActionModelPage', context);
  fixture.net.mockResolvedValueOnce(reply({ provider: 'inherit_vision', model: '', models: {}, resolved: { provider: 'openai', model: 'stale-vision' } }));
  const view = render(<Page />); await screen.findByText('openai / current-vision'); const old = deferred(); fixture.connect.mockReturnValueOnce(old.promise); fireEvent.click(button('test-effective-model'));
  expect(fixture.connect.mock.calls[0].slice(0, 3)).toEqual(['vision', 'openai', 'current-vision']);
  context.visionConfig = { provider: 'qwen', model: 'next-vision' }; view.rerender(<Page />); const next = deferred(); fixture.connect.mockReturnValueOnce(next.promise); fireEvent.click(button('test-effective-model'));
  await act(async () => old.resolve({ latencyMs: 8 })); expect(button('test-effective-model')).toHaveProperty('disabled', true); expect(fixture.connect.mock.calls[0][3].aborted).toBe(true); expect(screen.queryByText('world-model-call-passed-value0-ms')).toBeNull();
  await act(async () => next.resolve({ latencyMs: 9 })); await screen.findByText('world-model-call-passed-value0-ms');
});

it.each(['ReasoningRoleSettings', 'VisionRoleSettings', 'ServiceProviderSettings', 'LocalProviderSettings'])('%s exposes retry instead of unconfirmed model controls', name => {
  const role = name === 'VisionRoleSettings' ? 'vision' : 'llm', reload = vi.fn();
  const config = { ready: false, loadError: 'preferences unavailable', provider: 'openai', model: 'stale', models: {}, fallbackCandidates: [], selectionMode: 'pinned' };
  const context = { aiConfig: config, visionConfig: config, reloadModelPreferences: reload }, { Page } = modelPage(name, context), view = render(<Page />);
  expect(screen.getByRole('alert').textContent).toBe('preferences unavailable'); expect(screen.queryAllByRole('combobox')).toHaveLength(0); expect(screen.queryByRole('button', { name: 'test' })).toBeNull(); expect(screen.queryByRole('button', { name: 'save' })).toBeNull();
  fireEvent.click(button('retry')); expect(reload).toHaveBeenCalledExactlyOnceWith(role); config.loadError = ''; view.rerender(<Page />); expect(screen.queryByRole('button', { name: 'retry' })).toBeNull(); expect(screen.queryAllByRole('combobox')).toHaveLength(0);
});

it('blocks inherited world-model tests until vision preferences have loaded', async () => {
  const reload = vi.fn(), context = { visionConfig: { ready: false, loadError: 'vision unavailable', provider: 'openai', model: 'stale' }, reloadModelPreferences: reload }, { Page } = modelPage('WorldActionModelPage', context);
  fixture.net.mockResolvedValueOnce(reply({ provider: 'inherit_vision', model: '', models: {} })); const view = render(<Page />); await screen.findByText('vision unavailable'); expect(screen.queryByRole('button', { name: 'test-effective-model' })).toBeNull(); fireEvent.click(button('retry')); expect(reload).toHaveBeenCalledExactlyOnceWith('vision');
  context.visionConfig = { ready: true, loadError: '', provider: 'openai', model: 'confirmed' }; view.rerender(<Page />); fireEvent.click(button('test-effective-model')); await screen.findByText('world-model-call-passed-value0-ms'); expect(fixture.connect.mock.calls[0].slice(0, 3)).toEqual(['vision', 'openai', 'confirmed']);
});

it.each(['saved', 'rejected', 'edited', 'closed', 'pinned'])('reasoning tests use the edited route after confirmation (%s)', async outcome => {
  const context = { aiConfig: { provider: 'openai', model: 'old-model', selectionMode: outcome === 'pinned' ? 'pinned' : 'ordered_fallback', fallbackCandidates: [{ provider: 'ollama', model: 'backup' }], allowCloudFallback: false } };
  const { Page } = modelPage('ReasoningRoleSettings', context), view = render(<Page />), input = screen.getByLabelText('reasoning-role-openai');
  fireEvent.change(input, { target: { value: 'new-model' } });
  const saved = deferred(), testLabel = outcome === 'pinned' ? 'test' : 'test-effective-model'; fixture.update.mockReturnValueOnce(saved.promise); act(() => { fireEvent.click(button(testLabel)); fireEvent.click(button(testLabel)); });
  if (outcome === 'pinned') { await screen.findByText('live-call-passed-value0-ms · model-a'); expect(fixture.update).not.toHaveBeenCalled(); expect(fixture.connect.mock.calls[0].slice(0, 3)).toEqual(['llm', 'openai', 'new-model']); return; }
  expect(fixture.update).toHaveBeenCalledExactlyOnceWith({ model: 'new-model', selectionMode: 'ordered_fallback', fallbackCandidates: [{ provider: 'ollama', model: 'backup' }], allowCloudFallback: false }); expect(fixture.connect).not.toHaveBeenCalled();
  if (outcome === 'edited') fireEvent.change(input, { target: { value: 'newer-draft' } });
  if (outcome === 'closed') view.unmount();
  await act(async () => { if (outcome === 'saved') { context.aiConfig = { ...context.aiConfig, model: 'new-model' }; view.rerender(<Page />); } saved.resolve(outcome !== 'rejected'); });
  expect(fixture.connect).toHaveBeenCalledTimes(outcome === 'saved' ? 1 : 0);
  if (outcome === 'saved') { await screen.findByText('live-call-passed-value0-ms · model-a'); expect(fixture.connect.mock.calls[0][0]).toBe('llm/route'); }
});

it('reasoning preserves newer edits across configuration refresh and a pending save confirmation', async () => {
  const context = { aiConfig: { provider: 'openai', model: 'old', selectionMode: 'ordered_fallback', fallbackCandidates: [], allowCloudFallback: false } };
  const { Page } = modelPage('ReasoningRoleSettings', context), view = render(<Page />), input = screen.getByLabelText('reasoning-role-openai');
  fireEvent.change(input, { target: { value: 'first' } }); const save = deferred(); fixture.update.mockReturnValueOnce(save.promise); fireEvent.click(button('save'));
  fireEvent.change(input, { target: { value: 'new-draft' } }); context.aiConfig = { ...context.aiConfig, fallbackCandidates: [] }; view.rerender(<Page />); expect(input).toHaveProperty('value', 'new-draft');
  await act(async () => { context.aiConfig = { ...context.aiConfig, model: 'first' }; view.rerender(<Page />); save.resolve(true); }); expect(input).toHaveProperty('value', 'new-draft');
});

it('generation provider changes preserve each role and its saved models', async () => {
  const { Page, defaults } = modelPage('GenerativeModelsPage'), stored = defaults.DEFAULT_GENERATION_PREFERENCES;
  fixture.net.mockImplementation(async (_url: string, init: any) => reply(init?.body ? JSON.parse(init.body) : stored)); render(<Page />); await screen.findByLabelText('generation-relay-image-edit-model');
  const selects = screen.getAllByRole('combobox');
  for (const [index, provider] of ['openai', 'minimax', 'minimax'].entries()) fireEvent.change(selects[index], { target: { value: provider } });
  fireEvent.click(button('save-model-roles')); await waitFor(() => expect(toast.success).toHaveBeenCalledOnce());
  const draft = JSON.parse(fixture.net.mock.calls[1][1].body); expect(draft.image).toMatchObject({ provider: 'openai', model: stored.image.models.openai }); expect(draft.video).toMatchObject({ provider: 'minimax', model: stored.video.models.minimax }); expect(draft.imageToVideo).toMatchObject({ provider: 'minimax', model: defaults.VIDEO_GENERATION_PROVIDERS.minimax.models[0] }); expect(draft.imageEdit).toEqual(stored.imageEdit);
  fireEvent.change(selects[0], { target: { value: 'auto' } }); fireEvent.click(button('save-model-roles')); await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2)); expect(JSON.parse(fixture.net.mock.calls[2][1].body).image).toEqual(stored.image);
});

it.each(modelPages)('%s blocks unknown settings after a failed read and retries before saving', async (name, defaultKey, inputId, saveLabel) => {
  const context = { user: { uid: 'a' }, visionConfig: { provider: 'openai', model: 'current-vision' } }, { Page, defaults } = modelPage(name, context);
  const stored = defaultKey ? defaults[defaultKey] : { provider: 'openai', model: 'world-a', models: {} };
  fixture.net.mockResolvedValueOnce(reply({ error: 'read denied' }, 403)); const view = render(<Page />); await screen.findByRole('alert'); expect(screen.queryByRole('button', { name: saveLabel })).toBeNull();
  const retry = deferred(); fixture.net.mockReturnValueOnce(retry.promise); fireEvent.click(button('retry')); expect(screen.queryByLabelText(inputId)).toBeNull();
  await act(async () => retry.resolve(reply(stored))); await screen.findByLabelText(inputId);
  fixture.net.mockResolvedValueOnce(reply({ ...stored, [defaultKey ? Object.keys(stored)[0] : 'models']: [] })); fireEvent.click(button(saveLabel)); await waitFor(() => expect(toast.error).toHaveBeenCalled()); expect(toast.success).not.toHaveBeenCalled(); expect(screen.getByLabelText(inputId)).toBeTruthy();
  fixture.net.mockResolvedValueOnce(reply({ error: 'new account offline' }, 503)); context.user = { uid: 'b' }; view.rerender(<Page />); await screen.findByRole('alert'); expect(screen.queryByRole('button', { name: saveLabel })).toBeNull(); expect(screen.queryByLabelText(inputId)).toBeNull();
});

it('provider rows follow confirmed account models without importing stale browser choices', async () => {
  localStorage.setItem('lumi_llm_models', JSON.stringify({ openai: 'foreign' }));
  const context = { user: { uid: 'a' }, aiConfig: { provider: 'openai', models: { openai: 'a-model' } } }, Row = settingsRow('openai', context), view = render(<Row />);
  await waitFor(() => expect(button('test')).toHaveProperty('disabled', false)); const input = screen.getByRole('combobox'); expect(input).toHaveProperty('value', 'a-model');
  const old = deferred(); fixture.update.mockReturnValueOnce(old.promise); fireEvent.change(input, { target: { value: 'a-draft' } });
  context.user = { uid: 'b' }; context.aiConfig.models = { openai: 'b-model' }; view.rerender(<Row />); const nextInput = await screen.findByRole('combobox'); expect(nextInput).toHaveProperty('value', 'b-model');
  await act(async () => old.resolve(false)); expect(nextInput).toHaveProperty('value', 'b-model');
});


it.each(['unavailable', 'unknown'] as const)('generation refuses to save when the official catalog is %s', async status => {
  const officialCatalog = status === 'unavailable' ? null : { byRole: { image_generation: [], image_edit: [], video_generation: [], image_to_video: [] } };
  const { Page, defaults } = modelPage('GenerativeModelsPage', { officialCatalog });
  fixture.net.mockResolvedValueOnce(reply(defaults.DEFAULT_GENERATION_PREFERENCES));
  render(<Page />); await screen.findByLabelText('generation-relay-image-edit-model');
  fireEvent.click(button('save-model-roles'));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(status === 'unavailable' ? mediaGenerationCopy('zh').modelCatalogUnavailable : mediaGenerationCopy('zh').modelUnavailable));
  expect(fixture.net).toHaveBeenCalledTimes(1); expect(toast.success).not.toHaveBeenCalled();
});
