import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MessageIssueMapping, TopicProjectMapping, UserMapping } from "./types.js";

const NAMESPACE = "telegram-forum";

/**
 * Persistence layer backed by the plugin SDK's state API.
 * Stores message↔issue and topic↔project mappings.
 */
export class MappingStore {
  private ctx: PluginContext;
  private companyId: string;

  constructor(ctx: PluginContext, companyId: string) {
    this.ctx = ctx;
    this.companyId = companyId;
  }

  // ── Message ↔ Issue mappings ──────────────────────────────────────

  private messageMappingKey(
    chatId: string,
    messageId: number
  ): { scopeKind: "company"; scopeId: string; namespace: string; stateKey: string } {
    return {
      scopeKind: "company",
      scopeId: this.companyId,
      namespace: NAMESPACE,
      stateKey: `msg:${chatId}:${messageId}`,
    };
  }

  async getIssueByMessage(
    chatId: string,
    messageId: number
  ): Promise<MessageIssueMapping | null> {
    const val = await this.ctx.state.get(
      this.messageMappingKey(chatId, messageId)
    );
    return (val as MessageIssueMapping) ?? null;
  }

  async saveMessageMapping(mapping: MessageIssueMapping): Promise<void> {
    await this.ctx.state.set(
      this.messageMappingKey(
        mapping.telegramChatId,
        mapping.telegramMessageId
      ),
      mapping
    );
    // Also store a reverse lookup: issueId → message info
    await this.ctx.state.set(
      {
        scopeKind: "company",
        scopeId: this.companyId,
        namespace: NAMESPACE,
        stateKey: `issue:${mapping.paperclipIssueId}`,
      },
      mapping
    );
    // Update thread-level latest issue index for nested reply fallback.
    // Use 0 as the sentinel key for the General topic (messageThreadId === undefined).
    const threadKey = mapping.messageThreadId ?? 0;
    await this.saveThreadLatestIssue(threadKey, mapping);
  }

  async getMessageByIssue(
    issueId: string
  ): Promise<MessageIssueMapping | null> {
    const val = await this.ctx.state.get({
      scopeKind: "company",
      scopeId: this.companyId,
      namespace: NAMESPACE,
      stateKey: `issue:${issueId}`,
    });
    return (val as MessageIssueMapping) ?? null;
  }

  // ── Topic ↔ Project mappings ──────────────────────────────────────

  private topicMappingKey(
    threadId: number
  ): { scopeKind: "company"; scopeId: string; namespace: string; stateKey: string } {
    return {
      scopeKind: "company",
      scopeId: this.companyId,
      namespace: NAMESPACE,
      stateKey: `topic:${threadId}`,
    };
  }

  async getProjectByTopic(
    threadId: number
  ): Promise<TopicProjectMapping | null> {
    const val = await this.ctx.state.get(this.topicMappingKey(threadId));
    return (val as TopicProjectMapping) ?? null;
  }

  async saveTopicMapping(mapping: TopicProjectMapping): Promise<void> {
    await this.ctx.state.set(this.topicMappingKey(mapping.messageThreadId), mapping);
  }

  // ── Thread → latest issue mapping ─────────────────────────────────
  // Used as a fallback when a reply's direct parent isn't mapped
  // (nested replies, out-of-order delivery, etc.)

  async getLatestIssueByThread(
    threadId: number
  ): Promise<MessageIssueMapping | null> {
    const val = await this.ctx.state.get({
      scopeKind: "company",
      scopeId: this.companyId,
      namespace: NAMESPACE,
      stateKey: `thread-latest:${threadId}`,
    });
    return (val as MessageIssueMapping) ?? null;
  }

  async saveThreadLatestIssue(
    threadId: number,
    mapping: MessageIssueMapping
  ): Promise<void> {
    await this.ctx.state.set(
      {
        scopeKind: "company",
        scopeId: this.companyId,
        namespace: NAMESPACE,
        stateKey: `thread-latest:${threadId}`,
      },
      mapping
    );
  }

  // ── Sent-by-plugin tracking (loop prevention) ─────────────────────
  // Tracks Telegram message IDs sent by this plugin so the poller
  // can skip them and avoid creating duplicate comments.

  async markSentByPlugin(chatId: string, messageId: number): Promise<void> {
    await this.ctx.state.set(
      {
        scopeKind: "company",
        scopeId: this.companyId,
        namespace: NAMESPACE,
        stateKey: `sentByPlugin:${chatId}:${messageId}`,
      },
      true
    );
  }

  async isSentByPlugin(chatId: string, messageId: number): Promise<boolean> {
    const val = await this.ctx.state.get({
      scopeKind: "company",
      scopeId: this.companyId,
      namespace: NAMESPACE,
      stateKey: `sentByPlugin:${chatId}:${messageId}`,
    });
    return val === true;
  }

  // ── User mappings (Telegram ↔ Paperclip) ──────────────────────────

  async setUserMapping(
    telegramUserId: string,
    paperclipUserId: string,
    telegramDisplayName: string | null = null
  ): Promise<void> {
    const mapping: UserMapping = {
      telegramUserId,
      paperclipUserId,
      telegramDisplayName,
      createdAt: new Date().toISOString(),
    };
    // Forward: Telegram userId → Paperclip userId
    await this.ctx.state.set(
      {
        scopeKind: "company",
        scopeId: this.companyId,
        namespace: NAMESPACE,
        stateKey: `user:${telegramUserId}`,
      },
      mapping
    );
    // Reverse: Paperclip userId → Telegram userId
    await this.ctx.state.set(
      {
        scopeKind: "company",
        scopeId: this.companyId,
        namespace: NAMESPACE,
        stateKey: `puser:${paperclipUserId}`,
      },
      mapping
    );
  }

  async getUserMapping(
    telegramUserId: string
  ): Promise<UserMapping | null> {
    const val = await this.ctx.state.get({
      scopeKind: "company",
      scopeId: this.companyId,
      namespace: NAMESPACE,
      stateKey: `user:${telegramUserId}`,
    });
    return (val as UserMapping) ?? null;
  }

  async getUserMappingByPaperclipId(
    paperclipUserId: string
  ): Promise<UserMapping | null> {
    const val = await this.ctx.state.get({
      scopeKind: "company",
      scopeId: this.companyId,
      namespace: NAMESPACE,
      stateKey: `puser:${paperclipUserId}`,
    });
    return (val as UserMapping) ?? null;
  }

  // ── Plugin-initiated status change tracking ──────────────────────
  // Tracks issue IDs where the plugin itself changed the status (e.g. /close)
  // so the issue.updated event handler can skip the resulting notification.

  async markPluginStatusChange(issueId: string): Promise<void> {
    await this.ctx.state.set(
      {
        scopeKind: "company",
        scopeId: this.companyId,
        namespace: NAMESPACE,
        stateKey: `pluginStatusChange:${issueId}`,
      },
      true
    );
  }

  async isPluginStatusChange(issueId: string): Promise<boolean> {
    const val = await this.ctx.state.get({
      scopeKind: "company",
      scopeId: this.companyId,
      namespace: NAMESPACE,
      stateKey: `pluginStatusChange:${issueId}`,
    });
    return val === true;
  }

  async clearPluginStatusChange(issueId: string): Promise<void> {
    await this.ctx.state.set(
      {
        scopeKind: "company",
        scopeId: this.companyId,
        namespace: NAMESPACE,
        stateKey: `pluginStatusChange:${issueId}`,
      },
      null
    );
  }

  // ── Polling offset persistence ────────────────────────────────────

  async getPollingOffset(): Promise<number | undefined> {
    const val = await this.ctx.state.get({
      scopeKind: "company",
      scopeId: this.companyId,
      namespace: NAMESPACE,
      stateKey: "polling-offset",
    });
    return val as number | undefined;
  }

  async savePollingOffset(offset: number): Promise<void> {
    await this.ctx.state.set(
      {
        scopeKind: "company",
        scopeId: this.companyId,
        namespace: NAMESPACE,
        stateKey: "polling-offset",
      },
      offset
    );
  }
}
