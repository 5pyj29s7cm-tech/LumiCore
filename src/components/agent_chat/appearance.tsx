

export function getSelectedTextWithin(container?: HTMLElement | null): string {
  if (typeof window === 'undefined') return '';
  const selection = window.getSelection?.();
  const text = selection?.toString().trim() || '';
  if (!selection || !text) return '';
  if (!container) return text;
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  if ((anchor && container.contains(anchor)) || (focus && container.contains(focus))) return text;
  return '';
}


export const CHAT_NEUTRAL_THEME = {
  id: 'neutral',
  label: 'Neutral',
  saturn: '#e5e7eb',
  glow: '#f8fafc',
  nebula: '#cbd5e1',
  mars: '#f87171',
  background: 'linear-gradient(145deg, rgba(10,12,16,0.96) 0%, rgba(4,6,10,0.98) 48%, rgba(1,2,5,1) 100%)',
  panel: 'linear-gradient(180deg, rgba(18,20,26,0.86) 0%, rgba(7,9,14,0.94) 100%)',
  panelBorder: 'rgba(255, 255, 255, 0.14)',
  panelShadow: '0 26px 80px rgba(0, 0, 0, 0.34), 0 0 0 1px rgba(255,255,255,0.04)',
  header: 'linear-gradient(90deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))',
  progress: 'linear-gradient(90deg, rgba(255,255,255,0.07), rgba(0,0,0,0.18))',
  agentBubble: 'linear-gradient(180deg, rgba(255,255,255,0.075), rgba(255,255,255,0.045))',
  userBubble: 'linear-gradient(135deg, rgba(255,255,255,0.105), rgba(255,255,255,0.055))',
  inputPanel: 'linear-gradient(90deg, rgba(255,255,255,0.06), rgba(0,0,0,0.30))',
  input: 'rgba(6, 8, 12, 0.76)',
} as const;


export const CHAT_LIGHT_THEME = {
  id: 'light',
  label: 'Light',
  saturn: '#167a5f',
  glow: '#0ea5a3',
  nebula: '#2563eb',
  mars: '#dc2626',
  background: 'radial-gradient(circle at 18% 12%, rgba(22,122,95,0.10) 0%, transparent 30%), radial-gradient(circle at 82% 18%, rgba(37,99,235,0.07) 0%, transparent 34%), linear-gradient(145deg, #fbfcf8 0%, #f4f7f2 48%, #eef3ef 100%)',
  panel: 'linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(255,255,255,0.90) 100%)',
  panelBorder: 'rgba(30, 66, 49, 0.13)',
  panelShadow: '0 26px 80px rgba(31, 46, 39, 0.10), 0 0 0 1px rgba(255,255,255,0.72)',
  header: 'linear-gradient(90deg, rgba(255,255,255,0.94), rgba(242,248,244,0.88))',
  progress: 'linear-gradient(90deg, rgba(22,122,95,0.09), rgba(255,255,255,0.82))',
  agentBubble: 'linear-gradient(180deg, rgba(255,255,255,0.98), rgba(249,252,249,0.95))',
  userBubble: 'linear-gradient(135deg, rgba(232,246,240,0.98), rgba(242,248,255,0.92))',
  inputPanel: 'linear-gradient(90deg, rgba(255,255,255,0.95), rgba(246,250,247,0.92))',
  input: 'rgba(255,255,255,0.98)',
} as const;
