import { LazyPanelFallback } from "./window_shell";
import { Spotlight } from "./launcher";
import { Suspense } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Rocket, Zap, X, User as UserIcon, Search, Volume2, VolumeX, Minimize2, Minus, Square, Bell, Sparkles } from 'lucide-react';
import { BatteryIndicator } from "../DesktopShellAuxiliary";
import { WorkModeSwitch } from "../org/WorkModeSwitch";
import { uiMessage } from "../../i18n/uiMessages";
import { NotificationCenter } from "./surface_components";
import type { DesktopShellViewInput } from './DesktopShellView';

export function renderShellChrome({ viewMode, isWallpaperMode, handleTopbarPointerDown, toggleWindow, t, setShowOnboarding, tutorialLabel, workDomain, switchDomain, orgConnection, activeTab, openSurface, closeSurface, chatOpen, knowledgeOpen, memoryLabOpen, sanctuaryOpen, openCommandCenter, setIsSearchOpen, setIsNotificationPanelOpen, isNotificationPanelOpen, unreadCount, socket, lang, toggleMute, isMuted, toggleWallpaperMode, time, enterDesktopWidgetMode, handleWindowMinimize, handleWindowMaximize, isCompactWindowMode, handleWindowClose, resolvedAppearanceMode, openProactiveChat, isSearchOpen, allAppEntries, dockPositionClassName, dockApps, openWindows, focusedWindow, minimizedWindows, user, onLogin }: Pick<DesktopShellViewInput, "viewMode" | "isWallpaperMode" | "handleTopbarPointerDown" | "toggleWindow" | "t" | "setShowOnboarding" | "tutorialLabel" | "workDomain" | "switchDomain" | "orgConnection" | "activeTab" | "openSurface" | "closeSurface" | "chatOpen" | "knowledgeOpen" | "memoryLabOpen" | "sanctuaryOpen" | "openCommandCenter" | "setIsSearchOpen" | "setIsNotificationPanelOpen" | "isNotificationPanelOpen" | "unreadCount" | "socket" | "lang" | "toggleMute" | "isMuted" | "toggleWallpaperMode" | "time" | "enterDesktopWidgetMode" | "handleWindowMinimize" | "handleWindowMaximize" | "isCompactWindowMode" | "handleWindowClose" | "resolvedAppearanceMode" | "openProactiveChat" | "isSearchOpen" | "allAppEntries" | "dockPositionClassName" | "dockApps" | "openWindows" | "focusedWindow" | "minimizedWindows" | "user" | "onLogin">) {
  return (
<div className="fixed inset-0 z-[100] pointer-events-none">
        {/* Top Status Bar */}
        <div
          data-tauri-drag-region
          data-theme-scope={viewMode === 'world' ? 'dark' : undefined}
          inert={isWallpaperMode ? true : undefined}
          aria-hidden={isWallpaperMode ? true : undefined}
          onPointerDown={(event) => void handleTopbarPointerDown(event)}
          className={`lumi-shell-topbar absolute top-0 inset-x-0 h-10 glass-dark border-b border-white/5 flex items-center px-6 pointer-events-auto backdrop-blur-md transition-all duration-1000 ${isWallpaperMode ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
        >
          <div className="lumi-shell-topbar-left flex min-w-0 items-center gap-6">
            <button data-lumi-target="home" onClick={() => toggleWindow('home')} className="flex items-center gap-2 group transition-all">
               <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-celestial-mars to-celestial-saturn flex items-center justify-center p-1 group-hover:rotate-12 transition-transform shadow-lg shadow-celestial-saturn/20">
                 <Rocket size={14} className="text-white" />
               </div>
               <span className="lumi-shell-brand-label text-xs font-black tracking-widest uppercase text-white/60">{t.lumiCore || 'LumiCore'}</span>
            </button>
            <div className="lumi-shell-optional h-4 w-px bg-white/10" />
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowOnboarding(true)}
                className="lumi-shell-tutorial flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-black uppercase tracking-widest text-white/50 transition-colors hover:bg-white/10 hover:text-white"
                title={tutorialLabel}
              >
                <Sparkles size={12} />
                <span className="lumi-shell-tutorial-label">{tutorialLabel}</span>
              </button>
            </div>
          </div>

          <div className="lumi-shell-topbar-center flex items-center justify-center">
            <WorkModeSwitch
              domain={workDomain}
              onSelectDomain={switchDomain}
              connected={orgConnection?.connected ?? false}
              organizationOpen={activeTab === 'org'}
              onOpenOrganization={() => openSurface('org')}
              onCloseOrganization={() => closeSurface('command-center')}
              commandCenterOpen={chatOpen || knowledgeOpen || memoryLabOpen || sanctuaryOpen}
              onOpenCommandCenter={() => openCommandCenter('office')}
            />
          </div>

          <div className="lumi-shell-topbar-right flex min-w-0 items-center gap-6 justify-end">
            <div className="lumi-shell-status-actions flex items-center gap-4 text-white/55">
               <div className="flex items-center gap-1" onClick={() => setIsSearchOpen(true)}><Search size={14} className="hover:text-white transition-colors cursor-pointer" /></div>
               <button
                 onClick={() => setIsNotificationPanelOpen(prev => !prev)}
                 className={`flex items-center gap-1 relative transition-colors ${isNotificationPanelOpen ? 'text-white' : 'hover:text-white'}`}
                 aria-expanded={isNotificationPanelOpen}
                 aria-label={t.notificationsLabel || 'Notifications'}
               >
                  <Bell size={14} />
                  {unreadCount > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 rounded-full bg-red-500 text-xs font-black flex items-center justify-center text-white">
                     {unreadCount > 9 ? '9+' : unreadCount}
                   </span>
                 )}
               </button>
               {/* Server connection status */}
               <span
                 className={`w-2 h-2 rounded-full ${socket?.connected ? 'bg-green-400 shadow-[0_0_6px] shadow-green-400/60' : 'bg-red-400 animate-pulse'}`}
                  title={socket?.connected ? (uiMessage('desktop-ui.service-connected.23cf85600c', (lang === 'zh') ? 'zh' : 'en')) : (uiMessage('desktop-ui.service-disconnected.0511526fe1', (lang === 'zh') ? 'zh' : 'en'))}
               />
               {/* Volume mute toggle */}
                <button onClick={toggleMute} className="flex items-center gap-1 hover:text-white transition-colors" title={isMuted ? (uiMessage('desktop-ui.unmute.acb9917a71', (lang === 'zh') ? 'zh' : 'en')) : (uiMessage('desktop-ui.mute.060982be3f', (lang === 'zh') ? 'zh' : 'en'))}>
                 {isMuted ? <VolumeX size={14} className="text-red-400" /> : <Volume2 size={14} />}
               </button>
               {/* Battery — real via navigator.getBattery() */}
               <span className="lumi-shell-battery"><BatteryIndicator lang={lang} /></span>
               <button
                 onClick={toggleWallpaperMode}
                 className={`lumi-shell-wallpaper h-6 px-2 rounded-md border transition-all flex items-center gap-1 text-[12px] font-bold uppercase tracking-wider ${
                   isWallpaperMode
                     ? 'bg-celestial-saturn/20 text-celestial-saturn border-celestial-saturn/30'
                     : 'bg-white/5 border-white/5 text-white/55 hover:bg-white/10 hover:text-white'
                 }`}
                  title={isWallpaperMode ? (uiMessage('desktop-ui.exit-wallpaper-mode.9b9dd6514d', (lang === 'zh') ? 'zh' : 'en')) : (uiMessage('desktop-ui.wallpaper-mode.eb93c52005', (lang === 'zh') ? 'zh' : 'en'))}
               >
                 <Zap size={10} className={isWallpaperMode ? 'animate-pulse' : ''} />
                 <span className="lumi-shell-wallpaper-label">{isWallpaperMode ? 'Fusion' : 'Wallpaper'}</span>
               </button>
            </div>

            <time
              dateTime={time.toISOString()}
              className="lumi-shell-clock px-3 py-1 text-[12px] font-black tabular-nums text-white/80"
            >
              {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>

            {/* Window Controls */}
            <div className="lumi-shell-window-controls flex items-center gap-1 ml-2">
              <button
                onClick={() => void enterDesktopWidgetMode()}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-white/55 hover:text-white hover:bg-white/10 transition-colors"
                title={uiMessage('desktop-ui.desktop-widget.2a3b83969d', (lang === 'zh') ? 'zh' : 'en')}
              >
                <Minimize2 size={14} />
              </button>
              <button
                onClick={handleWindowMinimize}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-white/55 hover:text-white hover:bg-white/10 transition-colors"
                title={uiMessage('desktop-ui.minimize.17dd85f90b', (lang === 'zh') ? 'zh' : 'en')}
              >
                <Minus size={14} />
              </button>
              <button
                onClick={handleWindowMaximize}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-white/55 hover:text-white hover:bg-white/10 transition-colors"
                title={uiMessage(
                  isCompactWindowMode
                    ? 'desktop-ui.maximize.17e771fac7'
                    : 'desktop-ui.compact-window.6b67a41d2e',
                  (lang === 'zh') ? 'zh' : 'en',
                )}
                aria-pressed={isCompactWindowMode}
              >
                <Square size={12} />
              </button>
              <button
                onClick={handleWindowClose}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-white/55 hover:text-white hover:bg-red-500/80 transition-colors"
                title={uiMessage('desktop-ui.close.6cf4a7773a', (lang === 'zh') ? 'zh' : 'en')}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        </div>

        <AnimatePresence>
          {isNotificationPanelOpen && !isWallpaperMode && (
            <>
              <motion.button
                type="button"
                aria-label={uiMessage('desktop-ui.close-notifications.e2705e5af4', (lang === 'zh') ? 'zh' : 'en')}
                className="fixed inset-x-0 bottom-0 top-10 z-[101] cursor-default pointer-events-auto bg-transparent"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setIsNotificationPanelOpen(false)}
              />
              <motion.div
                initial={{ opacity: 0, y: -18, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -18, scale: 0.98 }}
                transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
                className={`fixed right-6 top-12 z-[102] h-[min(560px,calc(100vh-4.5rem))] w-[430px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border shadow-2xl pointer-events-auto ${
                  resolvedAppearanceMode === 'light'
                    ? 'border-emerald-900/10 bg-white/95 shadow-slate-900/10'
                    : 'border-white/10 bg-zinc-950/95 shadow-black/50'
                }`}
                onClick={(e) => e.stopPropagation()}
              >
                <Suspense fallback={<LazyPanelFallback label={t.loading || 'Loading'} />}>
                  <NotificationCenter
                    onChatMessage={openProactiveChat}
                  />
                </Suspense>
              </motion.div>
            </>
          )}
        </AnimatePresence>

        {/* Global Search */}
        <AnimatePresence>
          {isSearchOpen && !isWallpaperMode && (
            <Spotlight
              isOpen={isSearchOpen}
              onClose={() => setIsSearchOpen(false)}
              onSelect={toggleWindow}
              apps={allAppEntries}
              t={t}
            />
          )}
        </AnimatePresence>

        {/* Bottom Taskbar / Dock */}
        <div
          data-theme-scope={viewMode === 'world' ? 'dark' : undefined}
          className={`lumi-dock absolute bottom-6 ${dockPositionClassName} z-50 h-16 max-w-[calc(100vw-2rem)] overflow-x-auto overflow-y-hidden px-4 glass-dark rounded-[2.5rem] border border-white/10 flex items-center gap-2 shadow-2xl backdrop-blur-2xl transition-all duration-1000 ${
            isWallpaperMode || chatOpen || knowledgeOpen || activeTab === 'org'
              ? 'opacity-0 pointer-events-none'
              : 'opacity-100 pointer-events-auto'
          }`}
        >
          <AnimatePresence>
            {dockApps.map(app => {
              const isActive = openWindows.includes(app.id) || (app.id === 'command-center' && chatOpen);
              return (
              <motion.button
                key={app.id}
                data-lumi-target={app.id}
                aria-label={app.label}
                layoutId={`dock-${app.id}`}
                onClick={() => toggleWindow(app.id)}
                className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all group relative ${
                  isActive
                    ? `bg-gradient-to-br ${app.id === focusedWindow || app.id === 'command-center' ? app.color : 'from-white/10 to-white/5'} text-white shadow-lg ${minimizedWindows.includes(app.id) ? 'opacity-40 translate-y-2' : ''}`
                    : 'bg-white/5 text-white/40 hover:bg-white/10'
                }`}
              >
                {app.icon}
                {isActive && (
                  <motion.div
                    layoutId={`indicator-${app.id}`}
                    className={`absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-full ${minimizedWindows.includes(app.id) ? 'w-3 h-0.5 bg-white/40' : 'w-1 h-1 bg-white'}`}
                  />
                )}
                {/* Taskbar Preview Tooltip */}
                {isActive && !minimizedWindows.includes(app.id) && (
                   <div className="absolute -top-28 left-1/2 -translate-x-1/2 w-36 bg-black/90 border border-white/10 rounded-xl overflow-hidden opacity-0 group-hover:opacity-100 transition-all duration-200 pointer-events-none shadow-2xl">
                      <div className="p-3 flex items-center gap-2 border-b border-white/5">
                        <div className="w-6 h-6 rounded-lg bg-white/10 flex items-center justify-center">
                          <span className="scale-75">{app.icon}</span>
                        </div>
                        <span className="text-xs font-bold text-white/80 truncate">{app.label}</span>
                      </div>
                      <div className="px-3 py-2">
                        <p className="text-[12px] text-white/55 leading-tight">
                          {focusedWindow === app.id ? (t.activeFocused || 'Active — focused') : (t.openInBackground || 'Open in background')}
                        </p>
                      </div>
                   </div>
                )}
                <div className="absolute -top-12 left-1/2 -translate-x-1/2 px-3 py-1 bg-black/80 rounded-lg text-xs font-black uppercase text-white opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                  {app.label}
                </div>
              </motion.button>
              );
            })}
          </AnimatePresence>
          {user ? (
            <button
              onClick={() => toggleWindow('profile')}
              className="w-12 h-12 rounded-2xl overflow-hidden border-2 border-white/10 hover:border-celestial-saturn/50 bg-white/5 flex items-center justify-center transition-all group"
            >
              {user.photoURL ? (
                <img src={user.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <UserIcon size={20} className="text-white/40 group-hover:text-white/80 transition-colors" />
              )}
            </button>
          ) : (
            <button
              onClick={onLogin}
              className="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 text-white/40 hover:text-white hover:bg-white/10 hover:border-celestial-saturn/30 transition-all flex items-center justify-center group"
            >
              <UserIcon size={20} className="group-hover:text-celestial-saturn transition-colors" />
            </button>
          )}
        </div>
      </div>
  );
}
