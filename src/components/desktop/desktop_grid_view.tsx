import React from 'react';
import { motion } from 'motion/react';
import { ChevronRight, Bell } from 'lucide-react';
import { GlassCard } from "../SharedUI";
import { DesktopDeviceWidget } from "../DesktopDeviceWidget";
import type { DesktopShellViewInput } from './DesktopShellView';

export function renderDesktopGrid({ isWallpaperMode, desktopIconAreaHeight, desktopIcons, getDefaultDesktopIconPosition, t, openWindows, chatOpen, focusedWindow, launchExternalCapability, toggleWindow, lang, socket, notifications, unreadCount }: Pick<DesktopShellViewInput, "isWallpaperMode" | "desktopIconAreaHeight" | "desktopIcons" | "getDefaultDesktopIconPosition" | "t" | "openWindows" | "chatOpen" | "focusedWindow" | "launchExternalCapability" | "toggleWindow" | "lang" | "socket" | "notifications" | "unreadCount">) {
  return (
<div
        inert={isWallpaperMode ? true : undefined}
        aria-hidden={isWallpaperMode ? true : undefined}
        className={`lumi-desktop-grid relative z-10 w-full h-full overflow-y-auto custom-scrollbar px-3 pb-24 pt-14 transition-all duration-1000 sm:px-6 sm:pt-16 md:p-12 md:pt-20 lg:p-16 ${isWallpaperMode ? 'opacity-0 blur-sm pointer-events-none' : 'opacity-100'}`}
      >
        <div className="lumi-desktop-grid-layout flex flex-col xl:flex-row justify-between items-start gap-6 xl:gap-12">
            <div className="lumi-desktop-icon-canvas relative flex-1 w-full" style={{ margin: 0, padding: 0, minHeight: desktopIconAreaHeight }}>
              {desktopIcons.map((def, i) => {
                const { x, y } = getDefaultDesktopIconPosition(i);
                const label = def.label || (def.labelKey ? (t as any)[def.labelKey] || def.labelKey : def.id);
                const windowId = def.windowId || '';
                const isIconOpen = Boolean(windowId) && (openWindows.includes(windowId) || (windowId === 'command-center' && chatOpen));
                const isIconFocused = Boolean(windowId) && (focusedWindow === windowId || (windowId === 'command-center' && chatOpen));
                const handleClick = () => {
                  if (def.externalLaunch) {
                    void launchExternalCapability(def.externalLaunch.capability, def.externalLaunch.action);
                    return;
                  }
                  if (windowId) toggleWindow(windowId);
                };
                return (
                  <motion.div
                    key={def.id}
                    data-lumi-target={windowId || def.id}
                    onDoubleClick={def.externalLaunch ? event => { event.preventDefault(); event.stopPropagation(); } : handleClick}
                    onClick={event => {
                      if (def.externalLaunch && event.detail > 1) return;
                      handleClick();
                    }}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    style={{ position: 'absolute', left: x, top: y }}
                    className={`desktop-icon group z-10 select-none cursor-pointer ${isIconOpen ? 'desktop-icon-open' : ''} ${isIconFocused ? 'desktop-icon-focused' : ''}`}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e: React.KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); }
                    }}
                  >
                    <div className={`desktop-icon-img bg-gradient-to-br ${def.colorClass} shadow-[0_10px_20px_-5px_rgba(0,0,0,0.5)]`}>
                      <div className="text-white group-hover:rotate-12 transition-transform">
                        {def.icon}
                      </div>
                    </div>
                    <span className="desktop-icon-label">{label}</span>
                  </motion.div>
                );
              })}
            </div>

            <div className="lumi-desktop-widget-rail flex flex-col gap-6 w-full lg:w-96">
              <DesktopDeviceWidget lang={lang} socket={socket} onOpen={() => toggleWindow('devices')} />

              {/* Notification Preview */}
              {false && notifications.filter(n => !n.read).length > 0 && (
                <GlassCard className="p-5 rounded-[2rem] space-y-2 border-white/5 bg-black/30 backdrop-blur-3xl cursor-pointer hover:bg-white/[0.06] transition-all" onClick={() => toggleWindow('notifications')}>
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-black uppercase tracking-widest text-white/55 flex items-center gap-2">
                      <Bell size={12} className="text-amber-400" /> {t.recent || 'Recent'} ({unreadCount} {t.unread || 'unread'})
                    </h4>
                    <ChevronRight size={12} className="text-white/45" />
                  </div>
                  <div className="space-y-1">
                    {notifications.filter(n => !n.read).slice(0, 3).map(n => (
                      <div key={n.id} className="text-[12px] text-white/50 truncate">
                        <span className="text-white/70 font-bold">{n.title}</span> — {n.message}
                      </div>
                    ))}
                  </div>
                </GlassCard>
              )}

            </div>
        </div>
      </div>
  );
}
