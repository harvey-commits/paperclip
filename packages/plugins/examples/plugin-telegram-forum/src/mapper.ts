import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
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

    // Loop prevention: skip messages that were sent by this plugin
    const chatId = String(message.chat.id);
    if (await this.store.isSentByPlugin(chatId, message.message_id)) {
      this.ctx.logger.debug("Skipping message sent by plugin (loop prevention)", {
        messageId: message.message_id,
      });
      return;
    }

    // Check for /whoami command
    if (message.text.startsWith("/whoami")) {
      await this.handleWhoamiCommand(message);
      return;
    }

    // Check for /new command
    if (message.text.startsWith("/new ")) {
      await this.handleNewCommand(message);
      return;
    }

    // Check for /status command
    if (message.text === "/status" || message.text.startsWith("/status ")) {
      await this.handleStatusCommand(message);
      return;
    }

    // Check for /assign command
    if (message.text.startsWith("/assign ")) {
      await this.handleAssignCommand(message);
      return;
    }

    // Check for /close command
    if (message.text === "/close" || message.text.startsWith("/close ")) {
      await this.handleCloseCommand(message);
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
   * Handle /whoami command: look up the sender's Telegram-to-Paperclip mapping
   * and reply with their Paperclip userId and display name, or "not mapped yet".
   */
  private async handleWhoamiCommand(message: TelegramMessage): Promise<void> {
    const topicKey = `topic:${message.message_thread_id ?? "general"}`;
    if (!this.rateLimiter.allow(topicKey)) return;

    if (!message.from) {
      await this.telegram.sendMessage(
        this.config.telegramChatId,
        "Could not identify your Telegram account.",
        message.message_thread_id,
        message.message_id
      );
      return;
    }

    const telegramUserId = String(message.from.id);
    const mapping = await this.store.getUserMapping(telegramUserId);

    let reply: string;
    if (mapping) {
      const displayParts = [`Paperclip userId: ${mapping.paperclipUserId}`];
      if (mapping.telegramDisplayName) {
        displayParts.push(`Display name: ${mapping.telegramDisplayName}`);
      }
      reply = `You are mapped!\n${displayParts.join("\n")}`;
    } else {
      reply = `Not mapped yet. Your Telegram ID is ${telegramUserId}.`;
    }

    await this.telegram.sendMessage(
      this.config.telegramChatId,
      reply,
      message.message_thread_id,
      message.message_id
    );
  }

  /**
   * Check that the Telegram sender has a valid user mapping.
   * Returns true if authorized, false (and sends error reply) if not.
   */
  private async requireUserMapping(
    message: TelegramMessage
  ): Promise<boolean> {
    if (!message.from) {
      await this.telegram.sendMessage(
        this.config.telegramChatId,
        "Could not identify your Telegram account.",
        message.message_thread_id,
        message.message_id
      );
      return false;
    }

    const telegramUserId = String(message.from.id);
    const mapping = await this.store.getUserMapping(telegramUserId);
    if (mapping) return true;

    await this.telegram.sendMessage(
      this.config.telegramChatId,
      "You must be linked to a Paperclip account to use this command. Use /whoami to check your mapping.",
      message.message_thread_id,
      message.message_id
    );
    return false;
  }

  /**
   * Resolve the Paperclip userId for a Telegram message sender.
   * Returns null if the user is not mapped.
   */
  private async resolveUserId(
    message: TelegramMessage
  ): Promise<string | null> {
    if (!message.from) return null;

    const telegramUserId = String(message.from.id);
    const mapping = await this.store.getUserMapping(telegramUserId);
    if (mapping) return mapping.paperclipUserId;

    this.ctx.logger.warn("No user mapping for Telegram user", {
      telegramUserId,
      telegramName: message.from.first_name,
    });
    return null;
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
    const createdByUserId = await this.resolveUserId(message);
    const assigneeAgentId = this.resolveAgentForTopic(message.message_thread_id);

    const issue = await this.createPaperclipIssue({
      title,
      description,
      projectId,
      chatId: String(message.chat.id),
      messageId: message.message_id,
      createdByUserId,
      assigneeAgentId,
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
      const confirmationId = await this.telegram.sendMessage(
        this.config.telegramChatId,
        `Issue ${label} created: ${title}`,
        message.message_thread_id,
        message.message_id
      );

      // Save mapping for the confirmation message so replies to it
      // resolve to the issue via direct parent lookup
      if (confirmationId !== null) {
        await this.store.markSentByPlugin(this.config.telegramChatId, confirmationId);
        await this.store.saveMessageMapping({
          telegramMessageId: confirmationId,
          telegramChatId: String(message.chat.id),
          messageThreadId: message.message_thread_id,
          paperclipIssueId: issue.id,
          paperclipIssueIdentifier: issue.identifier,
          createdAt: new Date().toISOString(),
        });
      }
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

    // Check for an existing open issue in this thread before creating a new one.
    // If found, append the message as a comment instead.
    const threadMapping = await this.store.getLatestIssueByThread(message.message_thread_id!);
    if (threadMapping) {
      try {
        const existingIssue = await this.ctx.issues.get(
          threadMapping.paperclipIssueId,
          this.config.paperclipCompanyId
        );
        if (existingIssue && existingIssue.status !== "done" && existingIssue.status !== "cancelled") {
          const senderName = formatSenderName(message);
          const userId = await this.resolveUserId(message);
          const commentBody = `**${senderName}** (via Telegram):\n\n${sanitizeInput(message.text!)}`;

          await this.createPaperclipComment(
            threadMapping.paperclipIssueId,
            commentBody,
            userId
          );

          await this.store.saveMessageMapping({
            telegramMessageId: message.message_id,
            telegramChatId: chatId,
            messageThreadId: message.message_thread_id,
            paperclipIssueId: threadMapping.paperclipIssueId,
            paperclipIssueIdentifier: threadMapping.paperclipIssueIdentifier,
            createdAt: new Date().toISOString(),
          });

          this.ctx.logger.info("Appended Telegram message as comment to existing issue", {
            issueId: threadMapping.paperclipIssueId,
            identifier: threadMapping.paperclipIssueIdentifier,
            messageId: message.message_id,
          });
          return;
        }
      } catch (err) {
        this.ctx.logger.warn("Failed to check existing issue, falling through to create new", {
          issueId: threadMapping.paperclipIssueId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const title = truncate(sanitizeInput(message.text!), 100);
    const senderName = formatSenderName(message);
    const description = `${sanitizeInput(message.text!)}\n\n---\n_Sent by ${senderName} in Telegram_`;
    const createdByUserId = await this.resolveUserId(message);
    const assigneeAgentId = this.resolveAgentForTopic(message.message_thread_id);

    const issue = await this.createPaperclipIssue({
      title,
      description,
      projectId,
      chatId,
      messageId: message.message_id,
      createdByUserId,
      assigneeAgentId,
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
    const userId = await this.resolveUserId(message);
    const commentBody = `**${senderName}** (via Telegram):\n\n${sanitizeInput(message.text!)}`;

    try {
      await this.createPaperclipComment(
        mapping.paperclipIssueId,
        commentBody,
        userId
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
   * Handle an issue.comment.created event by pushing the comment to Telegram.
   * Skips issues not originating from Telegram and prevents loops.
   */
  async handleCommentCreated(event: PluginEvent): Promise<void> {
    // Skip events from plugins to prevent loops
    if (event.actorType === "plugin") return;

    const issueId = event.entityId;
    if (!issueId) return;

    // Fetch the issue to check origin
    const issue = await this.ctx.issues.get(issueId, this.config.paperclipCompanyId);
    if (!issue) return;

    // Only sync comments on Telegram-originated issues
    if (issue.originKind !== "telegram" || !issue.originId) return;

    // Parse originId: "{chatId}:{messageId}"
    const colonIdx = issue.originId.indexOf(":");
    if (colonIdx === -1) return;
    const originChatId = issue.originId.slice(0, colonIdx);
    const originMessageId = Number(issue.originId.slice(colonIdx + 1));
    if (!originChatId || Number.isNaN(originMessageId)) return;

    // Verify the origin chat matches our configured chat
    if (originChatId !== this.config.telegramChatId) return;

    // Extract comment body from the event payload
    const payload = event.payload as Record<string, unknown> | undefined;
    const commentBody = (payload as { body?: string } | undefined)?.body
      ?? (payload as { comment?: { body?: string } } | undefined)?.comment?.body;
    if (!commentBody) {
      this.ctx.logger.debug("No comment body in event payload, skipping", {
        issueId,
      });
      return;
    }

    // Resolve author name for the Telegram message
    let authorName = "Agent";
    if (event.actorType === "agent" && event.actorId) {
      const agent = await this.ctx.agents.get(
        event.actorId,
        this.config.paperclipCompanyId
      );
      if (agent) authorName = agent.name;
    } else if (event.actorType === "user") {
      authorName = "User";
    }

    // Format message for Telegram (keep markdown Telegram-compatible)
    const formattedText = `${authorName}:\n\n${commentBody}`;

    // Look up the mapping to get thread info for the reply
    const mapping = await this.store.getMessageByIssue(issueId);
    const messageThreadId = mapping?.messageThreadId;

    // Send as a reply to the original message in the thread
    const sentMessageId = await this.telegram.sendMessage(
      this.config.telegramChatId,
      formattedText,
      messageThreadId,
      originMessageId
    );

    // Track the sent message for loop prevention and reply resolution
    if (sentMessageId !== null) {
      await this.store.markSentByPlugin(this.config.telegramChatId, sentMessageId);
      await this.store.saveMessageMapping({
        telegramMessageId: sentMessageId,
        telegramChatId: this.config.telegramChatId,
        messageThreadId,
        paperclipIssueId: issueId,
        paperclipIssueIdentifier: issue.identifier,
        createdAt: new Date().toISOString(),
      });
      this.ctx.logger.info("Pushed comment to Telegram", {
        issueId,
        sentMessageId,
        threadId: messageThreadId,
      });
    }
  }

  /**
   * Handle /status command: look up the linked issue and reply with its current state.
   */
  private async handleStatusCommand(message: TelegramMessage): Promise<void> {
    const topicKey = `topic:${message.message_thread_id ?? "general"}`;
    if (!this.rateLimiter.allow(topicKey)) return;

    const mapping = await this.resolveIssueForCommand(message);
    if (!mapping) {
      await this.telegram.sendMessage(
        this.config.telegramChatId,
        "No linked issue found in this thread.",
        message.message_thread_id,
        message.message_id
      );
      return;
    }

    try {
      const issue = await this.ctx.issues.get(
        mapping.paperclipIssueId,
        this.config.paperclipCompanyId
      );
      if (!issue) {
        await this.telegram.sendMessage(
          this.config.telegramChatId,
          "Issue not found.",
          message.message_thread_id,
          message.message_id
        );
        return;
      }

      const label = issue.identifier ?? issue.id.slice(0, 8);
      const lines = [
        `${label}: ${issue.title}`,
        `Status: ${issue.status}`,
        `Priority: ${issue.priority}`,
      ];
      if (issue.assigneeAgentId) {
        const agent = await this.ctx.agents.get(
          issue.assigneeAgentId,
          this.config.paperclipCompanyId
        );
        lines.push(`Assignee: ${agent?.name ?? issue.assigneeAgentId}`);
      }

      await this.telegram.sendMessage(
        this.config.telegramChatId,
        lines.join("\n"),
        message.message_thread_id,
        message.message_id
      );
    } catch (err) {
      this.ctx.logger.error("Failed to handle /status command", {
        issueId: mapping.paperclipIssueId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Handle /assign command: reassign the linked issue to a named agent.
   */
  private async handleAssignCommand(message: TelegramMessage): Promise<void> {
    const topicKey = `topic:${message.message_thread_id ?? "general"}`;
    if (!this.rateLimiter.allow(topicKey)) return;

    // Authorization: require a valid user mapping
    if (!(await this.requireUserMapping(message))) return;

    const rawArg = message.text!.slice("/assign ".length).trim();
    const agentName = rawArg.replace(/^@/, "");
    if (!agentName) {
      await this.telegram.sendMessage(
        this.config.telegramChatId,
        "Usage: /assign @agent-name",
        message.message_thread_id,
        message.message_id
      );
      return;
    }

    const mapping = await this.resolveIssueForCommand(message);
    if (!mapping) {
      await this.telegram.sendMessage(
        this.config.telegramChatId,
        "No linked issue found in this thread.",
        message.message_thread_id,
        message.message_id
      );
      return;
    }

    try {
      const agents = await this.ctx.agents.list({
        companyId: this.config.paperclipCompanyId,
      });
      const nameLower = agentName.toLowerCase();
      const match = agents.find(
        (a) =>
          a.name.toLowerCase() === nameLower ||
          a.urlKey?.toLowerCase() === nameLower
      );
      if (!match) {
        await this.telegram.sendMessage(
          this.config.telegramChatId,
          `Agent "${sanitizeInput(agentName)}" not found.`,
          message.message_thread_id,
          message.message_id
        );
        return;
      }

      await this.ctx.issues.update(
        mapping.paperclipIssueId,
        { assigneeAgentId: match.id },
        this.config.paperclipCompanyId
      );

      const label = mapping.paperclipIssueIdentifier ?? mapping.paperclipIssueId.slice(0, 8);
      await this.telegram.sendMessage(
        this.config.telegramChatId,
        `${label} assigned to ${match.name}.`,
        message.message_thread_id,
        message.message_id
      );
    } catch (err) {
      this.ctx.logger.error("Failed to handle /assign command", {
        issueId: mapping.paperclipIssueId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Handle /close command: mark the linked issue as done.
   */
  private async handleCloseCommand(message: TelegramMessage): Promise<void> {
    const topicKey = `topic:${message.message_thread_id ?? "general"}`;
    if (!this.rateLimiter.allow(topicKey)) return;

    // Authorization: require a valid user mapping
    if (!(await this.requireUserMapping(message))) return;

    const mapping = await this.resolveIssueForCommand(message);
    if (!mapping) {
      await this.telegram.sendMessage(
        this.config.telegramChatId,
        "No linked issue found in this thread.",
        message.message_thread_id,
        message.message_id
      );
      return;
    }

    try {
      const senderName = formatSenderName(message);

      await this.ctx.issues.update(
        mapping.paperclipIssueId,
        { status: "done" },
        this.config.paperclipCompanyId
      );

      // Track this status change as plugin-initiated for loop prevention
      await this.store.markPluginStatusChange(mapping.paperclipIssueId);

      const label = mapping.paperclipIssueIdentifier ?? mapping.paperclipIssueId.slice(0, 8);
      await this.telegram.sendMessage(
        this.config.telegramChatId,
        `${label} closed.`,
        message.message_thread_id,
        message.message_id
      );

      // Post a closing comment via API (best-effort — don't fail the command)
      try {
        await this.createPaperclipComment(
          mapping.paperclipIssueId,
          `Closed via Telegram /close command by ${senderName}.`,
          await this.resolveUserId(message)
        );
      } catch (commentErr) {
        this.ctx.logger.warn("Failed to post closing comment", {
          issueId: mapping.paperclipIssueId,
          error: commentErr instanceof Error ? commentErr.message : String(commentErr),
        });
      }
    } catch (err) {
      this.ctx.logger.error("Failed to handle /close command", {
        issueId: mapping.paperclipIssueId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Handle an issue.updated event by pushing status change notifications to Telegram.
   * Only notifies on meaningful transitions (done, blocked, in_progress).
   * Skips plugin-initiated changes to avoid notification loops.
   */
  async handleIssueUpdated(event: PluginEvent): Promise<void> {
    // Skip events from plugins to prevent loops
    if (event.actorType === "plugin") return;

    const issueId = event.entityId;
    if (!issueId) return;

    // Check payload for status change
    const payload = event.payload as Record<string, unknown> | undefined;
    const newStatus = (payload as { status?: string } | undefined)?.status
      ?? (payload as { changes?: { status?: string } } | undefined)?.changes?.status;
    if (!newStatus) return;

    // Only notify on meaningful transitions
    const notifyStatuses = ["done", "blocked", "in_progress"];
    if (!notifyStatuses.includes(newStatus)) return;

    // Extra loop prevention: skip if this was a plugin-initiated status change (/close)
    if (await this.store.isPluginStatusChange(issueId)) {
      await this.store.clearPluginStatusChange(issueId);
      return;
    }

    // Fetch the issue to check origin
    const issue = await this.ctx.issues.get(issueId, this.config.paperclipCompanyId);
    if (!issue) return;

    // Only sync for Telegram-originated issues
    if (issue.originKind !== "telegram" || !issue.originId) return;

    // Parse originId
    const colonIdx = issue.originId.indexOf(":");
    if (colonIdx === -1) return;
    const originChatId = issue.originId.slice(0, colonIdx);
    const originMessageId = Number(issue.originId.slice(colonIdx + 1));
    if (!originChatId || Number.isNaN(originMessageId)) return;

    if (originChatId !== this.config.telegramChatId) return;

    // Resolve actor name
    let actorName = "System";
    if (event.actorType === "agent" && event.actorId) {
      const agent = await this.ctx.agents.get(
        event.actorId,
        this.config.paperclipCompanyId
      );
      if (agent) actorName = agent.name;
    } else if (event.actorType === "user") {
      actorName = "User";
    }

    const label = issue.identifier ?? issue.id.slice(0, 8);
    const statusLabel = newStatus === "in_progress" ? "in progress" : newStatus;
    const text = `${label} marked as ${statusLabel} by ${actorName}`;

    // Look up the mapping to get thread info
    const mapping = await this.store.getMessageByIssue(issueId);
    const messageThreadId = mapping?.messageThreadId;

    const sentMessageId = await this.telegram.sendMessage(
      this.config.telegramChatId,
      text,
      messageThreadId,
      originMessageId
    );

    if (sentMessageId !== null) {
      await this.store.markSentByPlugin(this.config.telegramChatId, sentMessageId);
      await this.store.saveMessageMapping({
        telegramMessageId: sentMessageId,
        telegramChatId: this.config.telegramChatId,
        messageThreadId,
        paperclipIssueId: issueId,
        paperclipIssueIdentifier: issue.identifier,
        createdAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Resolve the linked issue for a command message.
   * If the command is a reply → walk the reply chain.
   * Otherwise → use the thread-level latest issue.
   */
  private async resolveIssueForCommand(
    message: TelegramMessage
  ): Promise<{ paperclipIssueId: string; paperclipIssueIdentifier: string | null } | null> {
    if (message.reply_to_message && !message.reply_to_message.forum_topic_created) {
      return this.resolveIssueForReply(message);
    }
    if (message.message_thread_id !== undefined) {
      return this.store.getLatestIssueByThread(message.message_thread_id);
    }
    return null;
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
   * Resolve the Paperclip agent ID for a forum topic from static config.
   * Returns null if no mapping exists (issue will be created without an assignee).
   */
  private resolveAgentForTopic(threadId: number | undefined): string | null {
    if (threadId === undefined) return this.config.defaultAgentId ?? null;
    const agentMap = this.config.topicAgentMap ?? {};
    return agentMap[String(threadId)] ?? this.config.defaultAgentId ?? null;
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
      const resp = await fetch(
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
   * Passes createdByUserId when a user mapping exists for the Telegram sender.
   */
  private async createPaperclipIssue(input: {
    title: string;
    description: string;
    projectId: string;
    chatId: string;
    messageId: number;
    createdByUserId: string | null;
    assigneeAgentId?: string | null;
  }): Promise<PaperclipIssueResponse | null> {
    try {
      const issueBody: Record<string, unknown> = {
        title: input.title,
        description: input.description,
        projectId: input.projectId,
        originKind: "telegram",
        originId: `${input.chatId}:${input.messageId}`,
        status: "todo",
        priority: "medium",
      };
      if (input.createdByUserId) {
        issueBody.createdByUserId = input.createdByUserId;
      }
      if (input.assigneeAgentId) {
        issueBody.assigneeAgentId = input.assigneeAgentId;
      }

      const resp = await fetch(
        `${this.config.paperclipApiUrl}/api/companies/${this.config.paperclipCompanyId}/issues`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.paperclipApiKey}`,
          },
          body: JSON.stringify(issueBody),
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

  /**
   * Create a comment on a Paperclip issue via the REST API.
   * Uses HTTP fetch to allow passing userId for attribution.
   */
  private async createPaperclipComment(
    issueId: string,
    body: string,
    userId: string | null
  ): Promise<void> {
    const commentBody: Record<string, unknown> = { body };
    if (userId) {
      commentBody.authorUserId = userId;
    }

    const resp = await fetch(
      `${this.config.paperclipApiUrl}/api/issues/${issueId}/comments`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.paperclipApiKey}`,
        },
        body: JSON.stringify(commentBody),
      }
    );

    if (!resp.ok) {
      const respBody = await resp.text();
      throw new Error(`Failed to create comment (${resp.status}): ${respBody}`);
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
