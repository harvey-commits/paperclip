import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { TelegramForumConfig, TelegramUpdate } from "./types.js";
import { TelegramClient, startPolling } from "./telegram.js";
import { MappingStore } from "./store.js";
import { MessageMapper } from "./mapper.js";

const PLUGIN_NAME = "telegram-forum";

let stopPolling: (() => void) | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    const rawConfig = await ctx.config.get();
    const config = rawConfig as unknown as TelegramForumConfig;

    // Validate required config
    if (!config.telegramBotToken || !config.telegramChatId || !config.paperclipCompanyId) {
      ctx.logger.warn(
        `${PLUGIN_NAME}: missing required config (telegramBotToken, telegramChatId, or paperclipCompanyId). ` +
          "Plugin will start but polling is disabled."
      );
      return;
    }

    const telegram = new TelegramClient(ctx, config.telegramBotToken);
    const store = new MappingStore(ctx, config.paperclipCompanyId);
    const mapper = new MessageMapper(ctx, config, store, telegram);

    // Load static topic→project mappings into the store if provided
    if (config.topicProjectMap) {
      for (const [threadId, projectId] of Object.entries(config.topicProjectMap)) {
        const existing = await store.getProjectByTopic(Number(threadId));
        if (!existing) {
          await store.saveTopicMapping({
            messageThreadId: Number(threadId),
            projectId,
            projectName: `Mapped Topic ${threadId}`,
            createdAt: new Date().toISOString(),
          });
        }
      }
    }

    // Subscribe to issue events for potential future bidirectional sync
    ctx.events.on("issue.comment.created", async (event) => {
      // Phase 2: push agent comments back to Telegram
      ctx.logger.debug("Issue comment created (bidirectional sync TBD)", {
        issueId: event.entityId,
      });
    });

    // Handle incoming updates
    async function handleUpdate(update: TelegramUpdate): Promise<void> {
      if (update.message) {
        await mapper.handleMessage(update.message);
      }
    }

    // Start polling
    ctx.logger.info(`${PLUGIN_NAME}: starting Telegram polling`, {
      chatId: config.telegramChatId,
      intervalMs: config.pollingIntervalMs ?? 2000,
    });

    stopPolling = startPolling(telegram, config, handleUpdate, ctx.logger, store);

    ctx.logger.info(`${PLUGIN_NAME} plugin setup complete`);
  },

  async onHealth() {
    return {
      status: stopPolling ? "ok" : "degraded",
      message: stopPolling
        ? "Telegram polling active"
        : "Polling not started (check config)",
    };
  },

  async onConfigChanged(newConfig) {
    // For config changes, the host will restart the worker
    // so we don't need to handle dynamic reconfiguration
  },

  async onShutdown() {
    if (stopPolling) {
      stopPolling();
      stopPolling = null;
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
