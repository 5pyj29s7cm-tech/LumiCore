import { CN_ACTION_CONTRACT_COPY } from '../../regions/messages/action_contract_copy';
import { hasMixedStatusExecutionIntent } from "../normalized_action_intent";
import { compact } from "../action_contract_support";
import type { LumiActionContract } from './contracts';
import { withDefaults } from './contracts';

export function isNamedPersistentWorkTaskStatusQuery(text: string): boolean {
  const value = compact(text);
  const namesExactTask = /(?:\u4efb\u52a1|task)\s*[\u201c"']([^\u201d"']{1,140})[\u201d"']/iu.test(value);
  const namesPersistentLedger = /(?:\u6301\u4e45\u72b6\u6001|\u4efb\u52a1\u8d26\u672c|\u6301\u4e45\u4efb\u52a1)|\b(?:persistent task|task ledger)\b/iu.test(value);
  const asksStatus = /(?:\u67e5\u8be2|\u67e5\u770b|\u72b6\u6001|\u8fdb\u5ea6)|\b(?:query|status|progress)\b/iu.test(value);
  const createsTask = /(?:\u521b\u5efa|\u65b0\u5efa|\u6dfb\u52a0).{0,12}(?:\u6301\u4e45)?\u4efb\u52a1|\b(?:create|add)\b.{0,20}\b(?:persistent\s+)?task\b/iu.test(value);
  const namesTaskId = /\bwt_task_[A-Za-z0-9_-]+\b/u.test(value);
  return (namesExactTask || namesTaskId) && namesPersistentLedger && asksStatus
    && !createsTask && !hasMixedStatusExecutionIntent(value);
}

export function extensionRegistryToolForAction(text: string): string | null {
  // i18n-allow: Multilingual signed-extension input recognition; not user-visible copy.
  const subject = /(?:\bext_[a-z0-9_.-]+\b|\b(?:signed\s+)?(?:extension|plugin)\b|\bopenai[-\s]?compatible\s+provider\b|\bcustom\s+(?:model\s+)?provider\b|\bprovider\s+registry\b|(?:Lumi\s*)?(?:签名扩展|扩展插件|插件扩展|插件|扩展|OpenAI\s*兼容(?:模型|Provider|提供商)?|自定义(?:模型)?\s*Provider|Provider\s*注册表))/iu.test(text);
  if (!subject) return null;
  // i18n-allow: Multilingual signed-extension rollback input recognition; not user-visible copy.
  if (/(?:回滚|恢复.{0,12}(?:版本|修订)|\brollback\b|\brevert\b)/iu.test(text)) return 'extension_registry_rollback';
  // i18n-allow: Multilingual signed-extension disable input recognition; not user-visible copy.
  if (/(?:停用|禁用|关闭|卸载|\bdisable\b|\bdeactivate\b|\buninstall\b)/iu.test(text)) return 'extension_registry_disable';
  // i18n-allow: Multilingual signed-extension receipt input recognition; not user-visible copy.
  if (/(?:回执|审计|记录|\breceipts?\b|\baudit\b)/iu.test(text)) return 'extension_registry_receipts';
  // i18n-allow: Multilingual signed-extension compatibility input recognition; not user-visible copy.
  if (/(?:测试|探测|健康检查|兼容性|\btest\b|\bprobe\b|\bhealth\s*check\b|\bcompatibility\b)/iu.test(text)) return 'extension_registry_test';
  // i18n-allow: Multilingual signed-extension install input recognition; not user-visible copy.
  if (/(?:安装|注册|接入|启用|激活|添加|\binstall\b|\bregister\b|\bactivate\b|\badd\b)/iu.test(text)) return 'extension_registry_install';
  // i18n-allow: Multilingual signed-extension list input recognition; not user-visible copy.
  if (/(?:列出|查看|显示|有哪些|清单|\blist\b|\bshow\b|\binspect\b)/iu.test(text)) return 'extension_registry_list';
  return null;
}

export function buildSimpleDesktopOpenContract(): LumiActionContract {
  return withDefaults({
    kind: 'desktop_operation',
    label: 'Desktop target launch/open',
    coreAction: 'Open or focus exactly the desktop app, file, folder, or URL named by the user',
    preparationIsNotCompletion: ['only listing installed apps', 'opening a different fallback app', 'planning a larger task inside the app'],
    requiredEvidence: ['successful desktop_open or browser_open_task receipt for the requested target', 'or matching active-window/running-process evidence'],
    preferredTools: ['desktop_list_apps', 'desktop_open', 'browser_open_task', 'desktop_active_window', 'desktop_running_processes'],
    verificationTools: ['desktop_active_window', 'desktop_running_processes'],
    nextStep: 'Resolve the exact requested target, open it once, and verify the matching process or active window when needed.',
    caution: 'Do not reinterpret a launch request as content creation, and do not substitute a different application unless the user explicitly asks for a fallback.',
  });
}

export function buildVisualModelAvailabilityContract(): LumiActionContract {
  return withDefaults({
    kind: 'desktop_operation',
    label: 'Live visual-perception availability check',
    coreAction: 'Run one real current-screen perception request through the configured visual model and report whether it returned usable visual analysis.',
    preparationIsNotCompletion: [
      'reading model settings',
      'searching files or directories',
      'capturing an image without obtaining visual analysis',
    ],
    requiredEvidence: ['a successful current-turn OCR or visual-analysis receipt containing usable analysis text'],
    preferredTools: ['ocr_screen', 'ocr_region'],
    verificationTools: ['ocr_screen', 'ocr_region'],
    nextStep: 'Run one bounded visual probe and report the provider/account blocker naturally if it does not return analysis.',
    caution: 'File discovery, screenshots, and unrelated successful tools do not prove that the visual model is available.',
  });
}

export function buildMediaPlaybackContract(): LumiActionContract {
  return withDefaults({
    kind: 'desktop_operation',
    label: 'Verified music playback',
    coreAction: 'Open or focus the requested music player and start playback in that exact player.',
    preparationIsNotCompletion: [
      'listing installed applications',
      'opening or focusing the music player',
      'dispatching a generic keyboard shortcut without observing playback state afterwards',
    ],
    requiredEvidence: [
      'matching player window/open evidence',
      'a verified playback receipt, or a playback action followed by visible playing-state evidence',
    ],
    preferredTools: ['computer_use', 'desktop_list_apps', 'desktop_open', 'desktop_active_window', 'desktop_ui_snapshot', 'ocr_screen'],
    verificationTools: ['computer_use', 'desktop_ui_snapshot', 'ocr_screen'],
    nextStep: 'Use computer_use with the exact player, song and performer to own the playback action and its read-only progress verification. It can focus, search and play as needed, and returns a verified playback receipt. Do not spend the turn repeatedly listing windows or capturing raw screenshots; raw image bytes are not perception. Once verified, report that receipt without restarting or toggling playback.',
    caution: 'A successful Space/media-key dispatch proves input delivery only; it cannot distinguish play from pause.',
  });
}

export function buildCurrentAppMutationContract(): LumiActionContract {
  return withDefaults({
    kind: 'desktop_operation',
    label: CN_ACTION_CONTRACT_COPY.currentAppMutation.label,
    coreAction: CN_ACTION_CONTRACT_COPY.currentAppMutation.coreAction,
    preparationIsNotCompletion: [...CN_ACTION_CONTRACT_COPY.currentAppMutation.preparationIsNotCompletion],
    requiredEvidence: [...CN_ACTION_CONTRACT_COPY.currentAppMutation.requiredEvidence],
    preferredTools: [
      'wps_create_document_with_text',
      'desktop_active_window',
      'desktop_ui_snapshot',
      'desktop_ui_focus',
      'desktop_ui_click',
      'desktop_ui_invoke',
      'desktop_ui_type',
      'desktop_clipboard_write',
      'desktop_keyboard_press',
      'ocr_screen',
      'desktop_capture_screen',
      'computer_use',
    ],
    verificationTools: ['desktop_active_window', 'desktop_ui_snapshot', 'ocr_screen', 'desktop_capture_screen'],
    nextStep: CN_ACTION_CONTRACT_COPY.currentAppMutation.nextStep,
    caution: CN_ACTION_CONTRACT_COPY.currentAppMutation.caution,
  });
}

export function buildDesktopOperationContract(): LumiActionContract {
  return withDefaults({
    kind: 'desktop_operation',
    label: CN_ACTION_CONTRACT_COPY.desktopOperation.label,
    coreAction: CN_ACTION_CONTRACT_COPY.desktopOperation.coreAction,
    preparationIsNotCompletion: [...CN_ACTION_CONTRACT_COPY.desktopOperation.preparationIsNotCompletion],
    requiredEvidence: [...CN_ACTION_CONTRACT_COPY.desktopOperation.requiredEvidence],
    preferredTools: ['desktop_list_apps', 'desktop_open', 'desktop_active_window', 'desktop_ui_snapshot', 'desktop_capture_screen', 'computer_use'],
    verificationTools: ['desktop_active_window', 'desktop_ui_snapshot', 'desktop_capture_screen', 'desktop_running_processes'],
    nextStep: CN_ACTION_CONTRACT_COPY.desktopOperation.nextStep,
    caution: CN_ACTION_CONTRACT_COPY.desktopOperation.caution,
  });
}
