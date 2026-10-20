import type { OfficialApiModelCatalog as LumiOfficialCatalog } from "../../../server/llm/official_api";
import { formatUiMessage, uiMessage, type UiMessageKey } from "../../i18n/uiMessages";
import { LUMI_OFFICIAL_BASE_URL, normalizeLumiOfficialBaseUrl, LUMI_OFFICIAL_PROVIDER_ID as SHARED_LUMI_OFFICIAL_PROVIDER_ID, type LumiModelRoleId } from "../../../shared/model_provider_capabilities";

// `relay` is the persisted provider id used by the runtime. The settings UI
// presents the documented Lumi endpoint as the official provider while the
// secret itself remains in the server credential store.
export const LUMI_OFFICIAL_PROVIDER_ID = SHARED_LUMI_OFFICIAL_PROVIDER_ID;

export const LUMI_OFFICIAL_API_LABEL_KEY = 'settings.lumi-official-api-label.a1b2c3d4e5' as const;

export const LUMI_OFFICIAL_SUPPORTED_KEY = 'settings.lumi-official-capability-supported.b2c3d4e5f6' as const;

export const LUMI_OFFICIAL_UNAVAILABLE_KEY = 'settings.lumi-official-capability-unavailable.c3d4e5f6a7' as const;

export const LUMI_OFFICIAL_APPLY_LABEL_KEY = 'settings.lumi-official-apply-label.f1a2b3c4d5' as const;

export const LUMI_OFFICIAL_APPLY_DESCRIPTION_KEY = 'settings.lumi-official-apply-description.a2b3c4d5e6' as const;

export const LUMI_OFFICIAL_APPLY_NOT_CONFIGURED_KEY = 'settings.lumi-official-apply-not-configured.b3c4d5e6f7' as const;

export const LUMI_OFFICIAL_APPLY_SUCCESS_KEY = 'settings.lumi-official-apply-success.c4d5e6f7a8' as const;

export const LUMI_OFFICIAL_APPLY_PARTIAL_KEY = 'settings.lumi-official-apply-partial.d5e6f7a8b9' as const;

export const LUMI_OFFICIAL_APPLY_FAILED_KEY = 'settings.lumi-official-apply-failed.e6f7a8b9c0' as const;

export const LUMI_OFFICIAL_ADAPTER_UNAVAILABLE_KEY = 'settings.lumi-official-adapter-unavailable.a8b9c0d1e2' as const;

export const LUMI_OFFICIAL_CONFIG_NOT_READY_KEY = 'settings.lumi-official-config-not-ready.b9c0d1e2f3' as const;

export const LUMI_RELAY_BASE_URL_PLACEHOLDER = LUMI_OFFICIAL_BASE_URL;

export function officialModelOptions(
  catalog: LumiOfficialCatalog | null,
  role: LumiModelRoleId,
  fallback: string[],
): string[] {
  const live = catalog?.byRole?.[role];
  return catalog ? (Array.isArray(live) ? live : []) : fallback;
}

export function readStoredRelayBaseUrl(): string {
  try {
    const stored = String(localStorage.getItem('lumi_relay_url') || '').trim();
    const normalized = normalizeLumiOfficialBaseUrl(stored);
    if (stored !== normalized) localStorage.setItem('lumi_relay_url', normalized);
    return normalized;
  } catch {
    return '';
  }
}

export function lumiOfficialApiLabel(t?: any): string {
  return uiMessage(LUMI_OFFICIAL_API_LABEL_KEY, t?.langCode === 'en' ? 'en' : 'zh');
}

export function lumiOfficialCapabilityNote(t: any, capabilityKey: UiMessageKey): string {
  const locale = t?.langCode === 'en' ? 'en' : 'zh';
  return formatUiMessage(LUMI_OFFICIAL_UNAVAILABLE_KEY, {
    value0: uiMessage(capabilityKey, locale),
  }, locale);
}

/**
 * The official-API endpoint returns stable machine reasons for skipped roles.
 * Keep those protocol values out of the visible settings panel while retaining
 * an explicit fallback for a server-provided diagnostic that is safe to show.
 */
export function lumiOfficialRoleReason(reason: string | undefined, locale: 'en' | 'zh'): string {
  if (!reason) return '';
  if (reason === 'adapter_not_available') {
    return uiMessage(LUMI_OFFICIAL_ADAPTER_UNAVAILABLE_KEY, locale);
  }
  if (reason === 'official_api_not_configured') {
    return uiMessage(LUMI_OFFICIAL_CONFIG_NOT_READY_KEY, locale);
  }
  return reason;
}

export function LumiOfficialCapabilityBadge({ t, supported, capabilityKey }: { t: any; supported: boolean; capabilityKey: UiMessageKey }) {
  const locale = t?.langCode === 'en' ? 'en' : 'zh';
  return (
    <div className={`mt-3 rounded-xl border px-3 py-2 text-xs leading-relaxed ${
      supported
        ? 'border-cyan-300/15 bg-cyan-300/[0.06] text-cyan-100/65'
        : 'border-amber-300/15 bg-amber-300/[0.06] text-amber-100/65'
    }`}>
      {supported
        ? formatUiMessage(LUMI_OFFICIAL_SUPPORTED_KEY, { value0: lumiOfficialApiLabel(t) }, locale)
        : lumiOfficialCapabilityNote(t, capabilityKey)}
    </div>
  );
}
