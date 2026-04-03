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
  /**
   * Static topic-to-agent mapping.
   * Keys are message_thread_id strings, values are Paperclip agent IDs.
   * Issues created from mapped topics will be auto-assigned to the specified agent.
   */
  topicAgentMap?: Record<string, string>;
  /**
   * Fallback agent ID for topics without a specific mapping in topicAgentMap.
   * Issues created from unmapped topics will be assigned to this agent.
   */
  defaultAgentId?: string;
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

/** Telegram Bot API PhotoSize object. */
export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

/** Telegram Bot API Document object. */
export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** Telegram Bot API Audio object. */
export interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** Telegram Bot API Video object. */
export interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** Telegram Bot API Voice object. */
export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

/** Telegram Bot API VideoNote object. */
export interface TelegramVideoNote {
  file_id: string;
  file_unique_id: string;
  length: number;
  duration: number;
  file_size?: number;
}

/** Result from Telegram getFile API call. */
export interface TelegramGetFileResult {
  ok: boolean;
  result?: {
    file_id: string;
    file_unique_id: string;
    file_size?: number;
    file_path?: string;
  };
  description?: string;
}

/** Extracted file information from a Telegram message. */
export interface TelegramFileInfo {
  fileId: string;
  fileName: string;
  mimeType: string;
  fileSize?: number;
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
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  video?: TelegramVideo;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  video_note?: TelegramVideoNote;
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
