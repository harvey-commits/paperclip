import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  TelegramForumConfig,
  TelegramGetUpdatesResult,
  TelegramUpdate,
} from "./types.js";
import type { MappingStore } from "./store.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";

/**
 * Minimal Telegram Bot API client using the plugin SDK's HTTP client.
 * Uses long polling via getUpdates.
 */
export class TelegramClient {
  private token: string;
  private ctx: PluginContext;

  constructor(ctx: PluginContext, token: string) {
    this.ctx = ctx;
    this.token = token;
  }

  private url(method: string): string {
    return `${TELEGRAM_API_BASE}/bot${this.token}/${method}`;
  }

  /**
   * Fetch updates from Telegram using long polling.
   * @param offset - Pass the last update_id + 1 to acknowledge previous updates.
   * @param timeout - Long poll timeout in seconds (0 = short poll).
   */
  async getUpdates(offset?: number, timeout = 30): Promise<TelegramUpdate[]> {
    const params = new URLSearchParams();
    if (offset !== undefined) params.set("offset", String(offset));
    params.set("timeout", String(timeout));
    params.set("allowed_updates", JSON.stringify(["message"]));

    const resp = await this.ctx.http.fetch(
      `${this.url("getUpdates")}?${params.toString()}`
    );

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Telegram getUpdates failed (${resp.status}): ${body}`);
    }

    const data = (await resp.json()) as TelegramGetUpdatesResult;
    if (!data.ok) {
      throw new Error("Telegram getUpdates returned ok=false");
    }
    return data.result;
  }

  /**
   * Send a text message to a chat, optionally in a specific topic thread.
   */
  async sendMessage(
    chatId: string,
    text: string,
    messageThreadId?: number,
    replyToMessageId?: number
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
    };
    if (messageThreadId !== undefined) {
      body.message_thread_id = messageThreadId;
    }
    if (replyToMessageId !== undefined) {
      body.reply_to_message_id = replyToMessageId;
    }

    const resp = await this.ctx.http.fetch(this.url("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const respBody = await resp.text();
      this.ctx.logger.error("sendMessage failed", {
        status: resp.status,
        body: respBody,
      });
    }
  }
}

/**
 * Start a polling loop that fetches Telegram updates and calls the handler.
 * Returns a stop function to cancel the loop.
 */
export function startPolling(
  client: TelegramClient,
  config: TelegramForumConfig,
  handler: (update: TelegramUpdate) => Promise<void>,
  logger: PluginContext["logger"],
  store?: MappingStore
): () => void {
  let running = true;
  let offset: number | undefined;
  const intervalMs = config.pollingIntervalMs ?? 2000;

  async function poll() {
    // Load persisted offset on startup
    if (store) {
      try {
        offset = await store.getPollingOffset();
        if (offset !== undefined) {
          logger.info("Restored polling offset from store", { offset });
        }
      } catch (err) {
        logger.error("Failed to load polling offset", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    while (running) {
      try {
        const updates = await client.getUpdates(offset, 30);
        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            await handler(update);
          } catch (err) {
            logger.error("Error handling update", {
              updateId: update.update_id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // Persist offset after each successful batch
        if (store && offset !== undefined) {
          try {
            await store.savePollingOffset(offset);
          } catch (err) {
            logger.error("Failed to save polling offset", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        logger.error("Polling error", {
          error: err instanceof Error ? err.message : String(err),
        });
        // Back off on error
        await sleep(intervalMs * 2);
      }
    }
  }

  poll();

  return () => {
    running = false;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
