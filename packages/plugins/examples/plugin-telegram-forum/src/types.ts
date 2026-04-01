/**
 * Configuration accepted by the Telegram Forum plugin.
 * Provided via plugin instance config.
 */
export interface TelegramForumConfig {
  /** Telegram Bot API token */
  telegramBotToken: string;
  /** Telegram chat ID for the forum supergroup */
  telegramChatId: string;
  /** Paperclip API base URL */
  paperclipApiUrl: string;
  /** Paperclip API key for authentication */
  paperclipApiKey: string;
  /** Paperclip company ID to create issues under */
  paperclipCompanyId: string;
  /**
   * Static topic-to-project mapping.
   * Keys are message_thread_id strings, values are Paperclip project IDs.
   * Topics not in this map will auto-create projects if autoCreateProjects is true.
   */
  topicProjectMap?: Record<string, string>;
  /** Whether to auto-create projects for unmapped topics. Defaults to true. */
  autoCreateProjects?: boolean;
  /** Polling interval in milliseconds. Defaults to 2000. */
  pollingIntervalMs?: number;
}

/** A stored mapping between a Telegram message and a Paperclip issue. */
export interface MessageIssueMapping {
  telegramMessageId: number;
  telegramChatId: string;
  messageThreadId: number | undefined;
  paperclipIssueId: string;
  paperclipIssueIdentifier: string | null;
  createdAt: string;
}

/** A stored mapping between a Telegram topic and a Paperclip project. */
export interface TopicProjectMapping {
  messageThreadId: number;
  projectId: string;
  projectName: string;
  createdAt: string;
}

/** Subset of Telegram Bot API Update object. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/** Subset of Telegram Bot API Message object. */
export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  message_thread_id?: number;
  reply_to_message?: TelegramMessage;
  text?: string;
  is_topic_message?: boolean;
  forum_topic_created?: {
    name: string;
    icon_color: number;
    icon_custom_emoji_id?: string;
  };
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
}

/** Result from getUpdates API call. */
export interface TelegramGetUpdatesResult {
  ok: boolean;
  result: TelegramUpdate[];
}

/** Paperclip issue creation response (subset of fields we need). */
export interface PaperclipIssueResponse {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
}

/** A stored mapping between a Telegram user and a Paperclip user. */
export interface UserMapping {
  telegramUserId: string;
  paperclipUserId: string;
  telegramDisplayName: string | null;
  createdAt: string;
}

/** Result from Telegram sendMessage API call. */
export interface TelegramSendMessageResult {
  ok: boolean;
  result: {
    message_id: number;
    chat: TelegramChat;
    text?: string;
  };
}
