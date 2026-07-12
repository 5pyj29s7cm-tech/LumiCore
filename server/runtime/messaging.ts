// Messaging integrations (Feishu, WeCom, etc.)
import { Router } from "express";
import { createMessagingRoutes, createWeComRoutes } from "../messaging";
import { createWeChatRoutes } from "../messaging/wechat-routes";
import { getMessagingConfig } from "../messaging/config";
import { personalityRegistry } from "../personality";
import { queryMemories } from "../memory";
import { loadEmotionalState } from "../personality/state";
import { messagingConnectionManager } from "../messaging/connections";
import type { MessagingRouteOptions } from "../messaging/routes";

export function setupMessaging(
  apiRouter: Router,
  llm: {
    getDeepSeek: any; getGemini: any; getOpenAI: any; getAnthropic: any; getQwen: any;
    getArk?: any; getOllama?: any; getLmStudio?: any; getXiaomi?: any; getKimi?: any;
    getGlm?: any; getRelay?: any;
  },
) {
  const cfg = getMessagingConfig();
  const llmGetters = {
    getDeepSeek: llm.getDeepSeek,
    getGemini: llm.getGemini,
    getOpenAI: llm.getOpenAI,
    getAnthropic: llm.getAnthropic,
    getQwen: llm.getQwen,
    getArk: llm.getArk,
    getOllama: llm.getOllama,
    getLmStudio: llm.getLmStudio,
    getXiaomi: llm.getXiaomi,
    getKimi: llm.getKimi,
    getGlm: llm.getGlm,
    getRelay: llm.getRelay,
  };
  const routeOptions: MessagingRouteOptions = {
    llmGetters,
    personalityRegistry,
    queryMemories,
    loadEmotionalState,
    onConfigChanged: async () => {
      messagingConnectionManager.configure(getMessagingConfig(), routeOptions);
      await messagingConnectionManager.restart();
    },
    getConnectionStatus: platform => messagingConnectionManager.status(platform),
    sendProactive: (platform, chatId, text) => messagingConnectionManager.sendProactive(platform, chatId, text),
  };
  messagingConnectionManager.configure(cfg, routeOptions);

  // Always mount messaging routes so UI can save config even before env vars are set
  // Feishu
  apiRouter.use("/", createMessagingRoutes(cfg.feishu, routeOptions));
  console.log(cfg.feishu.enabled ? `[Feishu] Mounted (${cfg.feishu.transport})` : '[Feishu] Mounted (not configured)');

  // WeCom
  apiRouter.use("/", createWeComRoutes(cfg.wecom, routeOptions));
  console.log(cfg.wecom.enabled ? `[WeCom] Mounted (${cfg.wecom.mode})` : '[WeCom] Mounted (not configured)');

  // WeChat ClawBot — always mounted so UI can manage QR login + config
  apiRouter.use("/", createWeChatRoutes(cfg.wechat, {
    llmGetters,
    personalityRegistry,
    queryMemories,
    loadEmotionalState,
  }));
  console.log(cfg.wechat?.botToken && cfg.wechat?.botId ? '[WeChat] Active' : '[WeChat] Mounted (not configured)');
}

export function startMessagingConnections(): Promise<void> {
  return messagingConnectionManager.start();
}

export function stopMessagingConnections(): Promise<void> {
  return messagingConnectionManager.stop();
}
