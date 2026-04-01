import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  TelegramForumConfig,
  TelegramMessage,
  PaperclipIssueResponse,
} from "./types.js";
import type { MappingStore } from "./store.js";
import type { TelegramClient } from "./telegram.js";

/**
 * Simple sliding-window rate limiter.
 * Tracks timestamps of recent actions per key and rejects when the
 * window limit is exceeded.
 */
class RateLimiter {
  private windows = new Map<string, number[]>();
  private maxPerWindow: number;
  private windowMs: number;

  constructor(maxPerWindow: number, windowMs = 60_000) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
  }

  /** Returns true if the action is allowed, false if rate-limited. */
  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.windows.get(key);
    if (timestamps) {
      timestamps = timestamps.filter((t) => t > cutoff);
    } else {
      timestamps = [];
    }

    if (timestamps.length >= this.maxPerWindow) {
      this.windows.set(key, timestamps);
      return false;
    }

    timestamps.push(now);
    this.windows.set(key, timestamps);
    return true;
  }
}

/** Max issues + comments created per topic per minute. */
const RATE_LIMIT_PER_TOPIC = 10;

/**
 * Handles the mapping logic between Telegram messages and Paperclip issues/comments.
 */
export class MessageMapper {
  private ctx: PluginContext;
  private config: TelegramForumConfig;
  private store: MappingStore;
  private telegram: TelegramClient;
  private rateLimiter = new RateLimiter(RATE_LIMIT_PER_TOPIC);

  constructor(
    ctx: PluginContext,
    config: TelegramForumConfig,
    store: MappingStore,
    telegram: TelegramClient
  ) {
    this.ctx = ctx;
    this.config = config;
    this.store = store;
    this.telegram = telegram;
  }

  /**
   * Process an incoming Telegram message.
   * Routes to the appropriate handler based on message type.
   */
  async handleMessage(message: TelegramMessage): Promise<void> {
    // Ignore messages from bots (our own bot's replies)
    if (message.from?.is_bot) return;

    // Ignore non-text messages
    if (!message.text) return;

    // Ignore service messages (topic created, etc.)
    if (message.forum_topic_created) return;

    // Only process messages from the configured chat
    if (String(message.chat.id) !== this.config.telegramChatId) return;

    // Check for /new command
    if (message.text.startsWith("/new ")) {
      await this.handleNewCommand(message);
      return;
    }

    // Determine if this is a reply to an existing message (→ comment)
    // or a new top-level message in a topic (→ new issue)
    if (message.reply_to_message && !message.reply_to_message.forum_topic_created) {
      await this.handleReply(message);
    } else if (message.message_thread_id) {
      await this.handleTopLevelMessage(message);
    }
  }

  /**
   * Handle /new command: create a fresh issue under the topic's project.
   */
  private async handleNewCommand(message: TelegramMessage): Promise<void> {
    const rawTitle = message.text!.slice("/new ".length).trim();
    if (!rawTitle) return;

    // Dedup: skip if this message was already processed
    const chatId = String(message.chat.id);
    const existing = await this.store.getIssueByMessage(chatId, message.message_id);
    if (existing) return;

    const title = sanitizeInput(rawTitle);

    const projectId = await this.resolveProjectForTopic(message.message_thread_id);
    if (!projectId) {
      this.ctx.logger.warn("Could not resolve project for /new command", {
        threadId: message.message_thread_id,
      });
      return;
    }

    // Rate limit: prevent abuse from a single topic
    const topicKey = `topic:${message.message_thread_id ?? "general"}`;
    if (!this.rateLimiter.allow(topicKey)) {
      this.ctx.logger.warn("Rate limited /new command", {
        threadId: message.message_thread_id,
      });
      return;
    }

    const senderName = formatSenderName(message);
    const description = `Created via Telegram /new command by ${senderName}`;

    const issue = await this.createPaperclipIssue({
      title,
      description,
      projectId,
      chatId: String(message.chat.id),
      messageId: message.message_id,
    });

    if (issue) {
      await this.store.saveMessageMapping({
        telegramMessageId: message.message_id,
        telegramChatId: String(message.chat.id),
        messageThreadId: message.message_thread_id,
        paperclipIssueId: issue.id,
        paperclipIssueIdentifier: issue.identifier,
        createdAt: new Date().toISOString(),
      });

      const label = issue.identifier ?? issue.id.slice(0, 8);
      await this.telegram.sendMessage(
        this.config.telegramChatId,
        `Issue ${label} created: ${title}`,
        message.message_thread_id,
        message.message_id
      );
    }
  }

  /**
   * Handle a new top-level message in a forum topic → create a Paperclip issue.
   */
  private async handleTopLevelMessage(
    message: TelegramMessage
  ): Promise<void> {
    const chatId = String(message.chat.id);

    // Check if we already mapped this message
    const existing = await this.store.getIssueByMessage(
      chatId,
      message.message_id
    );
    if (existing) return;

    const projectId = await this.resolveProjectForTopic(
      message.message_thread_id
    );
    if (!projectId) {
      this.ctx.logger.warn("Could not resolve project for topic", {
        threadId: message.message_thread_id,
      });
      return;
    }

    // Rate limit: prevent abuse from a single topic
    const topicKey = `topic:${message.message_thread_id ?? "general"}`;
    if (!this.rateLimiter.allow(topicKey)) {
      this.ctx.logger.warn("Rate limited issue creation", {
        threadId: message.message_thread_id,
      });
      return;
    }

    const title = truncate(sanitizeInput(message.text!), 100);
    const senderName = formatSenderName(message);
    const description = `${sanitizeInput(message.text!)}\n\n---\n_Sent by ${senderName} in Telegram_`;

    const issue = await this.createPaperclipIssue({
      title,
      description,
      projectId,
      chatId,
      messageId: message.message_id,
    });

    if (issue) {
      await this.store.saveMessageMapping({
        telegramMessageId: message.message_id,
        telegramChatId: chatId,
        messageThreadId: message.message_thread_id,
        paperclipIssueId: issue.id,
        paperclipIssueIdentifier: issue.identifier,
        createdAt: new Date().toISOString(),
      });

      this.ctx.logger.info("Created issue from Telegram message", {
        issueId: issue.id,
        identifier: issue.identifier,
        messageId: message.message_id,
      });
    }
  }

  /**
   * Handle a reply to a message → post as a comment on the mapped issue.
   * Walks up the reply chain and falls back to the thread-level latest issue
   * when the direct parent message is not in the mapping store.
   */
  private async handleReply(message: TelegramMessage): Promise<void> {
    if (!message.reply_to_message) return;

    const chatId = String(message.chat.id);

    // Dedup: skip if this reply message was already processed
    const existingReply = await this.store.getIssueByMessage(chatId, message.message_id);
    if (existingReply) return;

    // Walk up the reply chain to find a mapped issue:
    // 1. Direct parent message
    // 2. Grandparent message (if Telegram included nested reply_to_message)
    // 3. Thread-level latest issue fallback
    const mapping = await this.resolveIssueForReply(message);
    if (!mapping) {
      this.ctx.logger.debug("Reply to unmapped message, no fallback found", {
        replyToId: message.reply_to_message.message_id,
        threadId: message.message_thread_id,
      });
      return;
    }

    // Rate limit: prevent abuse from a single topic
    const topicKey = `topic:${message.message_thread_id ?? "general"}`;
    if (!this.rateLimiter.allow(topicKey)) {
      this.ctx.logger.warn("Rate limited comment creation", {
        threadId: message.message_thread_id,
      });
      return;
    }

    const senderName = formatSenderName(message);
    const commentBody = `**${senderName}** (via Telegram):\n\n${sanitizeInput(message.text!)}`;

    try {
      await this.ctx.issues.createComment(
        mapping.paperclipIssueId,
        commentBody,
        this.config.paperclipCompanyId
      );

      // Save mapping for the reply message to enable dedup and threading
      await this.store.saveMessageMapping({
        telegramMessageId: message.message_id,
        telegramChatId: chatId,
        messageThreadId: message.message_thread_id,
        paperclipIssueId: mapping.paperclipIssueId,
        paperclipIssueIdentifier: mapping.paperclipIssueIdentifier,
        createdAt: new Date().toISOString(),
      });

      this.ctx.logger.info("Posted Telegram reply as comment", {
        issueId: mapping.paperclipIssueId,
        messageId: message.message_id,
      });
    } catch (err) {
      this.ctx.logger.error("Failed to create comment", {
        issueId: mapping.paperclipIssueId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Walk up the reply chain to find a mapped issue for a reply message.
   * Checks: direct parent → grandparent → thread-level latest issue.
   */
  private async resolveIssueForReply(
    message: TelegramMessage
  ): Promise<{ paperclipIssueId: string; paperclipIssueIdentifier: string | null } | null> {
    const chatId = String(message.chat.id);
    const parent = message.reply_to_message;
    if (!parent) return null;

    // 1. Direct parent
    const direct = await this.store.getIssueByMessage(chatId, parent.message_id);
    if (direct) return direct;

    // 2. Grandparent — Telegram may include reply_to_message on the parent
    if (parent.reply_to_message) {
      const grandparent = await this.store.getIssueByMessage(
        chatId,
        parent.reply_to_message.message_id
      );
      if (grandparent) return grandparent;
    }

    // 3. Thread-level fallback — find the most recently mapped issue in this thread
    if (message.message_thread_id !== undefined) {
      const threadFallback = await this.store.getLatestIssueByThread(
        message.message_thread_id
      );
      if (threadFallback) {
        this.ctx.logger.debug("Using thread-level fallback for nested reply", {
          threadId: message.message_thread_id,
          fallbackIssueId: threadFallback.paperclipIssueId,
        });
        return threadFallback;
      }
    }

    return null;
  }

  /**
   * Resolve the Paperclip project ID for a forum topic.
   * Checks static config first, then stored mappings, then auto-creates if enabled.
   */
  private async resolveProjectForTopic(
    threadId: number | undefined
  ): Promise<string | null> {
    if (threadId === undefined) return null;

    // 1. Check static config mapping
    const staticMap = this.config.topicProjectMap ?? {};
    const staticProjectId = staticMap[String(threadId)];
    if (staticProjectId) return staticProjectId;

    // 2. Check stored mapping
    const stored = await this.store.getProjectByTopic(threadId);
    if (stored) return stored.projectId;

    // 3. Auto-create if enabled
    if (this.config.autoCreateProjects !== false) {
      return this.autoCreateProject(threadId);
    }

    return null;
  }

  /**
   * Auto-create a Paperclip project for an unmapped forum topic.
   */
  private async autoCreateProject(
    threadId: number
  ): Promise<string | null> {
    try {
      const resp = await this.ctx.http.fetch(
        `${this.config.paperclipApiUrl}/api/companies/${this.config.paperclipCompanyId}/projects`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.paperclipApiKey}`,
          },
          body: JSON.stringify({
            name: `Telegram Topic ${threadId}`,
            status: "active",
          }),
        }
      );

      if (!resp.ok) {
        const body = await resp.text();
        this.ctx.logger.error("Failed to auto-create project", {
          status: resp.status,
          body,
        });
        return null;
      }

      const project = (await resp.json()) as { id: string; name: string };

      await this.store.saveTopicMapping({
        messageThreadId: threadId,
        projectId: project.id,
        projectName: project.name,
        createdAt: new Date().toISOString(),
      });

      this.ctx.logger.info("Auto-created project for topic", {
        threadId,
        projectId: project.id,
      });

      return project.id;
    } catch (err) {
      this.ctx.logger.error("Error auto-creating project", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Create a Paperclip issue via the REST API (to include originKind/originId).
   */
  private async createPaperclipIssue(input: {
    title: string;
    description: string;
    projectId: string;
    chatId: string;
    messageId: number;
  }): Promise<PaperclipIssueResponse | null> {
    try {
      const resp = await this.ctx.http.fetch(
        `${this.config.paperclipApiUrl}/api/companies/${this.config.paperclipCompanyId}/issues`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.paperclipApiKey}`,
          },
          body: JSON.stringify({
            title: input.title,
            description: input.description,
            projectId: input.projectId,
            originKind: "telegram",
            originId: `${input.chatId}:${input.messageId}`,
            status: "todo",
            priority: "medium",
          }),
        }
      );

      if (!resp.ok) {
        const body = await resp.text();
        this.ctx.logger.error("Failed to create issue", {
          status: resp.status,
          body,
        });
        return null;
      }

      return (await resp.json()) as PaperclipIssueResponse;
    } catch (err) {
      this.ctx.logger.error("Error creating issue", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

/**
 * Sanitize untrusted input from Telegram to prevent XSS and markdown injection.
 * Escapes HTML tags and dangerous markdown patterns.
 */
function sanitizeInput(text: string): string {
  return text
    // Escape HTML tags to prevent XSS
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Neutralize javascript: URLs in markdown links
    .replace(/\[([^\]]*)\]\(javascript:/gi, "[$1](unsafe:");
}

function formatSenderName(message: TelegramMessage): string {
  if (!message.from) return "Unknown";
  const parts = [sanitizeInput(message.from.first_name)];
  if (message.from.last_name) parts.push(sanitizeInput(message.from.last_name));
  if (message.from.username) parts.push(`(@${sanitizeInput(message.from.username)})`);
  return parts.join(" ");
}
