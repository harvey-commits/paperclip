import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclip.telegram-forum";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Telegram Forum Integration",
  description:
    "Syncs Telegram forum topics to Paperclip issue tracking. " +
    "Top-level messages become issues, replies become comments, and /new creates fresh issues.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "projects.read",
    "issues.create",
    "issues.read",
    "issue.comments.create",
    "issue.comments.read",
    "events.subscribe",
    "http.outbound",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      telegramBotToken: {
        type: "string",
        title: "Telegram Bot Token",
        description: "Bot API token from @BotFather",
      },
      telegramChatId: {
        type: "string",
        title: "Telegram Chat ID",
        description: "Chat ID of the forum supergroup",
      },
      paperclipApiUrl: {
        type: "string",
        title: "Paperclip API URL",
        description: "Base URL for the Paperclip API",
      },
      paperclipApiKey: {
        type: "string",
        title: "Paperclip API Key",
        description: "API key for Paperclip authentication",
      },
      paperclipCompanyId: {
        type: "string",
        title: "Paperclip Company ID",
        description: "Company ID to create issues under",
      },
      topicProjectMap: {
        type: "object",
        title: "Topic → Project Mapping",
        description:
          "Static mapping of message_thread_id to Paperclip project ID. " +
          "Unmapped topics auto-create projects when autoCreateProjects is true.",
        additionalProperties: { type: "string" },
      },
      autoCreateProjects: {
        type: "boolean",
        title: "Auto-create Projects",
        description: "Automatically create projects for unmapped forum topics",
        default: true,
      },
      pollingIntervalMs: {
        type: "number",
        title: "Polling Interval (ms)",
        description: "How often to poll Telegram for updates",
        default: 2000,
      },
    },
    required: [
      "telegramBotToken",
      "telegramChatId",
      "paperclipApiUrl",
      "paperclipApiKey",
      "paperclipCompanyId",
    ],
  },
};

export default manifest;
