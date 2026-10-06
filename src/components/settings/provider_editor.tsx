import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "../ui/button";
import { useApp } from "@/contexts/AppContext";
import { uiMessage } from "../../i18n/uiMessages";
import { useServerCredentials, useProviderModel, ModelSettingsStatus } from './model_operations';
import { SettingsDisclosure } from './components';

export function LLMProviderRow(props: Parameters<typeof LLMProviderEditor>[0]) {
  const { user } = useApp();
  return user ? <LLMProviderEditor key={JSON.stringify([user.uid, user.role, props.providerId, props.serverKey])} {...props} /> : null;
}

export function LLMProviderEditor({ icon, label, providerId, models, placeholder, disabled = false, serverKey, t }: {
  icon: React.ReactNode; label: string; providerId: string; models: string[];
  placeholder: string; disabled?: boolean; serverKey: string; t?: any;
}) {
  const { aiConfig } = useApp();
  const [keyValue, setKeyValue] = useState(''), [showKey, setShowKey] = useState(false);
  const { status, loadError, reload, operation, changeKeys } = useServerCredentials(`lumi_${providerId}_key`, t);
  const serverConfigured = Boolean(status?.[serverKey]);
  const { model, changeModel: handleModelChange, testModel, resetTest, testState, testMessage } = useProviderModel(providerId, models[0] || '', JSON.stringify([serverConfigured, keyValue, operation.busy]));
  const changeKey = (remove: boolean) => {
    if (disabled || (!remove && !keyValue.trim())) return;
    resetTest();
    return changeKeys({ [serverKey]: remove ? '' : keyValue.trim() }, remove, () => setKeyValue(''));
  };
  const handleTest = () => { if (!disabled && !operation.busy && serverConfigured && !keyValue.trim()) { operation.reset(); void testModel(); } };

  return (
    <SettingsDisclosure
      icon={icon}
      label={label}
      defaultOpen={aiConfig.provider === providerId}
      badges={<>
        {serverConfigured && <span className="rounded-full border border-green-500/20 bg-green-500/10 px-2 py-0.5 text-[11px] font-semibold text-green-400">{t?.configured || uiMessage('settings.configured.d7f5ed6e15')}</span>}
        {aiConfig.provider === providerId && <span className="rounded-full border border-celestial-saturn/20 bg-celestial-saturn/10 px-2 py-0.5 text-[11px] font-semibold text-celestial-saturn">{t?.activeBadge || uiMessage('settings.active.0aac32bf1d')}</span>}
      </>}
    >
      {!status ? <ModelSettingsStatus error={loadError} retry={reload} /> : <div className="space-y-3">
      <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
        <div className="relative flex-1">
          <input
            disabled={disabled || operation.busy}
            type={showKey ? 'text' : 'password'}
            value={keyValue}
            onChange={e => { setKeyValue(e.target.value); operation.reset(); resetTest(); }}
            onKeyDown={e => e.key === 'Enter' && changeKey(false)}
            placeholder={serverConfigured && !keyValue ? (t?.keySavedOnServer || uiMessage('settings.key-saved-on-server.1ca0422100')) : placeholder}
            className="h-11 w-full rounded-lg border border-white/10 bg-black/30 px-3 pr-14 font-mono text-sm text-white outline-none transition-colors focus:border-celestial-saturn/50 disabled:opacity-50"
          />
          <div className="absolute right-1.5 top-1.5 flex gap-1">
            <button type="button" onClick={() => setShowKey(!showKey)}
              className="h-8 rounded-md border border-white/5 bg-white/5 px-2 text-[11px] font-semibold text-white/60 hover:bg-white/10">
              {showKey ? (t?.hide || uiMessage('settings.hide.d2e660d104')) : (t?.show || uiMessage('settings.show.520bd3e959'))}
            </button>
          </div>
        </div>
        <Button
          onClick={() => changeKey(false)}
          disabled={disabled || operation.busy || !keyValue.trim()}
          className="h-11 rounded-lg bg-celestial-saturn px-4 text-xs font-semibold text-black transition-all hover:bg-celestial-saturn/90 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {t?.save || uiMessage('settings.save.ec8e6d5819')}
        </Button>
        <Button
          onClick={() => changeKey(true)}
          disabled={disabled || operation.busy || (!keyValue && !serverConfigured)}
          className="h-11 rounded-lg border border-red-500/20 bg-red-500/10 px-4 text-xs font-semibold text-red-400 transition-all hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-20"
        >
          {t?.remove || uiMessage('settings.remove.78190c6054')}
        </Button>
        <Button
          onClick={handleTest}
          disabled={disabled || operation.busy || !serverConfigured || Boolean(keyValue.trim()) || !model.trim() || testState === 'testing'}
          className="h-11 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 text-xs font-semibold text-emerald-300 transition-all hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-20"
        >
          {testState === 'testing' ? <Loader2 size={16} className="animate-spin" /> : uiMessage('settings.test.9408c1ff3a')}
        </Button>
      </div>
      <label className="grid gap-2 sm:grid-cols-[92px_minmax(0,1fr)] sm:items-center">
        <span className="text-xs font-semibold text-white/50">{uiMessage('settings.model.44c0cd4289')}</span>
        <span>
          <input
            disabled={disabled || operation.busy}
            value={model}
            onChange={event => { operation.reset(); void handleModelChange(event.target.value); }}
            list={`provider-models-${providerId}`}
            className="h-10 w-full rounded-lg border border-white/10 bg-black/30 px-3 font-mono text-xs text-white outline-none focus:border-celestial-saturn/50"
          />
          <datalist id={`provider-models-${providerId}`}>
            {models.map(option => <option key={option} value={option} />)}
          </datalist>
        </span>
      </label>
      {(operation.message || testMessage) && (
        <p className={`text-xs ${(operation.message ? operation.state : testState) === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>
          {operation.message || testMessage}
        </p>
      )}
      </div>}
    </SettingsDisclosure>
  );
}
