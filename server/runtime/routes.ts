// Route aggregator — mounts all shared routes on the API router
import { Router } from "express";
import { Server } from "socket.io";
import { mountPersonalityRoutes } from "../routes/personality_routes";
import { mountMcpRoutes } from "../routes/mcp_routes";
import { mountDeviceRoutes } from "../routes/device_routes";
import { mountSystemRoutes } from "../routes/system_routes";
import { mountChatRoutes } from "../routes/chat_routes";
import { mountPreferencesRoutes } from "../routes/preferences_routes";
import { mountInteractionsRoutes } from "../routes/interactions_routes";
import { mountAuthRoutes } from "../routes/auth";
import { mountMemoryRoutes } from "../routes/memory_routes";
import { mountConversationRoutes } from "../routes/conversations";
import { mountAgentRoutes } from "../routes/agent_routes";
import { mountSkillRoutes } from "../routes/skill_routes";
import { mountMarketplaceRoutes } from "../routes/marketplace_routes";
import { mountMiscRoutes } from "../routes/misc_routes";
import { mountContactsRoutes } from "../routes/contacts_routes";
import { mountBranchConnectionRoutes } from "../routes/branch_routes";
import { mountNotificationRoutes } from "../routes/notifications";
import { autonomyRoutes } from "../routes/autonomy_routes";
import { mountExploreRoutes, mountPlanRoutes } from "../routes/plan_explore_routes";
import { mountCommandCenterPlanRoutes } from "../routes/command_center_plan_routes";
import { mountTaskRegressionEvidenceRoutes } from "../evidence/task_truth_snapshot_route";

interface RouteContext {
  apiRouter: Router;
  jwtSecret: string;
  llm: {
    getDeepSeek: any; getGemini: any; getOpenAI: any; getAnthropic: any; getQwen: any; getArk: any; getGlm: any;
    getOllama?: any; getLmStudio?: any; getXiaomi?: any; getKimi?: any; getRelay?: any;
  };
  getCookieOptions: () => { httpOnly: true; secure: boolean; sameSite: "none" | "lax"; maxAge: number };
  io: Server;
}

export function mountAllRoutes({ apiRouter, jwtSecret, llm, getCookieOptions, io }: RouteContext) {
  const llmGetters = {
    getDeepSeek: llm.getDeepSeek,
    getGemini: llm.getGemini,
    getOpenAI: llm.getOpenAI,
    getAnthropic: llm.getAnthropic,
    getQwen: llm.getQwen,
    getOllama: llm.getOllama,
    getLmStudio: llm.getLmStudio,
    getArk: llm.getArk,
    getXiaomi: llm.getXiaomi,
    getKimi: llm.getKimi,
    getGlm: llm.getGlm,
    getRelay: llm.getRelay,
  };

  // Personality, MCP, Device management
  mountPersonalityRoutes(apiRouter, jwtSecret, llmGetters);
  mountMcpRoutes(apiRouter);
  mountDeviceRoutes(apiRouter, jwtSecret);

  // System routes (health, tools, llm, settings, stats, ecosystem, modules)
  mountSystemRoutes(apiRouter, jwtSecret, io, llm);

  // AI Chat
  mountChatRoutes(apiRouter, jwtSecret, llmGetters);

  // Auth
  mountAuthRoutes(apiRouter, jwtSecret, getCookieOptions);

  // Agents
  mountAgentRoutes(apiRouter, jwtSecret, llmGetters);

  // Preferences & Interactions
  mountPreferencesRoutes(apiRouter, jwtSecret);
  mountInteractionsRoutes(apiRouter, jwtSecret);

  // Memory & Conversation
  mountMemoryRoutes(apiRouter, jwtSecret, llmGetters);
  mountConversationRoutes(apiRouter, jwtSecret);

  // Skills & Marketplace
  mountSkillRoutes(apiRouter, jwtSecret, llmGetters, io);
  mountMarketplaceRoutes(apiRouter, jwtSecret, io, llmGetters);

  // Contacts
  mountContactsRoutes(apiRouter, jwtSecret);

  // Branch connection (employee→company)
  mountBranchConnectionRoutes(apiRouter, jwtSecret);

  // Notifications
  mountNotificationRoutes(apiRouter);

  // System Exploration & Plans
  mountExploreRoutes(apiRouter);
  mountPlanRoutes(apiRouter);
  mountCommandCenterPlanRoutes(apiRouter);

  // Autonomy
  apiRouter.use('/autonomy', autonomyRoutes());

  // This mounts nothing unless an isolated regression child process presents
  // the complete startup proof. It is absent from normal desktop/production.
  mountTaskRegressionEvidenceRoutes(apiRouter);

  // Misc (founder vision, feedback, admin config, Org chat)
  mountMiscRoutes(apiRouter, jwtSecret, llmGetters);
}
