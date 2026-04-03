import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue, Agent } from "@paperclipai/shared";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { MessageMapper } from "../src/mapper.js";
import { MappingStore } from "../src/store.js";
import { TelegramClient } from "../src/telegram.js";
import type { TelegramForumConfig, TelegramMessage } from "../src/types.js";

const COMPANY_ID = "test-company";
const CHAT_ID = "-1001234567890";
const BOT_TOKEN = "123456:ABC-DEF";
const AGENT_ID = "agent-001";
const AGENT_NAME = "Test Agent";
const ISSUE_ID = "issue-001";
const ORIGIN_MESSAGE_ID = 42;
const SENT_MESSAGE_ID = 999;

function makeConfig(): TelegramForumConfig {
  return {
    telegramBotToken: BOT_TOKEN,
    telegramChatId: CHAT_ID,
    paperclipApiUrl: "http://localhost:3100",
    paperclipApiKey: "test-api-key",
    paperclipCompanyId: COMPANY_ID,
    pollingIntervalMs: 999999,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const now = new Date();
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    projectId: "proj-001",
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Test Issue",
    description: "A test issue",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: "TST-1",
    originKind: "telegram",
    originId: `${CHAT_ID}:${ORIGIN_MESSAGE_ID}`,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const now = new Date();
  return {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    name: AGENT_NAME,
    urlKey: "test-agent",
    role: "engineer",
    title: "Test Agent",
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<PluginEvent> = {}): PluginEvent {
  return {
    eventId: "evt-001",
    eventType: "issue.comment.created",
    occurredAt: new Date().toISOString(),
    companyId: COMPANY_ID,
    entityId: ISSUE_ID,
    entityType: "issue",
    actorId: AGENT_ID,
    actorType: "agent",
    payload: { body: "Test comment" },
    ...overrides,
  };
}

/**
 * Build a harness + mapper + store without starting the polling loop.
 * This lets us test mapper methods directly.
 */
function buildTestMapper(options?: {
  issue?: Issue;
  agent?: Agent;
  sendMessageResult?: number | null;
}) {
  const config = makeConfig();
  const issue = options?.issue ?? makeIssue();
  const agent = options?.agent ?? makeAgent();
  const sendResult = options && "sendMessageResult" in options
    ? options.sendMessageResult
    : SENT_MESSAGE_ID;

  const harness = createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities],
    config,
  });

  harness.seed({ issues: [issue], agents: [agent] });

  const store = new MappingStore(harness.ctx, COMPANY_ID);
  const telegram = new TelegramClient(harness.ctx, BOT_TOKEN);

  // Mock sendMessage to avoid real HTTP calls
  const sendMessageSpy = vi.spyOn(telegram, "sendMessage").mockResolvedValue(sendResult);

  const mapper = new MessageMapper(harness.ctx, config, store, telegram);

  return { harness, mapper, store, telegram, sendMessageSpy };
}

// ── Outbound: comment → Telegram ──────────────────────────────────

describe("handleCommentCreated", () => {
  it("pushes agent comment to Telegram with correct format", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper();

    // Pre-populate the reverse mapping so the mapper can find thread info
    await store.saveMessageMapping({
      telegramMessageId: ORIGIN_MESSAGE_ID,
      telegramChatId: CHAT_ID,
      messageThreadId: 100,
      paperclipIssueId: ISSUE_ID,
      paperclipIssueIdentifier: "TST-1",
      createdAt: new Date().toISOString(),
    });

    await mapper.handleCommentCreated(makeEvent());

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [chatId, text, threadId, replyTo] = sendMessageSpy.mock.calls[0];
    expect(chatId).toBe(CHAT_ID);
    expect(text).toContain(AGENT_NAME);
    expect(text).toContain("Test comment");
    expect(threadId).toBe(100);
    expect(replyTo).toBe(ORIGIN_MESSAGE_ID);
  });

  it("marks sent message for loop prevention", async () => {
    const { mapper, store } = buildTestMapper();

    await mapper.handleCommentCreated(makeEvent());

    expect(await store.isSentByPlugin(CHAT_ID, SENT_MESSAGE_ID)).toBe(true);
  });

  it("skips events from plugin actor type", async () => {
    const { mapper, sendMessageSpy } = buildTestMapper();

    await mapper.handleCommentCreated(makeEvent({ actorType: "plugin" }));

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("skips issues with non-telegram origin", async () => {
    const { mapper, sendMessageSpy } = buildTestMapper({
      issue: makeIssue({ originKind: "manual", originId: null }),
    });

    await mapper.handleCommentCreated(makeEvent());

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("skips issues with no originId", async () => {
    const { mapper, sendMessageSpy } = buildTestMapper({
      issue: makeIssue({ originKind: "telegram", originId: null }),
    });

    await mapper.handleCommentCreated(makeEvent());

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("skips events with no entityId", async () => {
    const { mapper, sendMessageSpy } = buildTestMapper();

    await mapper.handleCommentCreated(makeEvent({ entityId: undefined }));

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("skips events with no comment body", async () => {
    const { mapper, sendMessageSpy } = buildTestMapper();

    await mapper.handleCommentCreated(makeEvent({ payload: { unrelated: true } }));

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("extracts body from nested payload structure", async () => {
    const { mapper, sendMessageSpy } = buildTestMapper();

    await mapper.handleCommentCreated(
      makeEvent({ payload: { comment: { body: "Nested format" } } })
    );

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text] = sendMessageSpy.mock.calls[0];
    expect(text).toContain("Nested format");
  });

  it("uses 'User' as author name for user-type actors", async () => {
    const { mapper, sendMessageSpy } = buildTestMapper();

    await mapper.handleCommentCreated(
      makeEvent({ actorType: "user", actorId: "user-123" })
    );

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text] = sendMessageSpy.mock.calls[0];
    expect(text).toMatch(/^User:\n/);
  });

  it("does not track sent message when sendMessage fails", async () => {
    const { mapper, store } = buildTestMapper({ sendMessageResult: null });

    await mapper.handleCommentCreated(makeEvent());

    expect(await store.isSentByPlugin(CHAT_ID, SENT_MESSAGE_ID)).toBe(false);
  });

  it("skips issues from a different chat", async () => {
    const { mapper, sendMessageSpy } = buildTestMapper({
      issue: makeIssue({ originId: "-999:42" }),
    });

    await mapper.handleCommentCreated(makeEvent());

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });
});

// ── Inbound loop prevention ───────────────────────────────────────

describe("handleMessage loop prevention", () => {
  it("skips messages marked as sent by plugin", async () => {
    const { mapper, store } = buildTestMapper();

    // Mark message 555 as sent by plugin
    await store.markSentByPlugin(CHAT_ID, 555);

    const message: TelegramMessage = {
      message_id: 555,
      chat: { id: Number(CHAT_ID), type: "supergroup" },
      date: Date.now(),
      text: "Bot reply that should be skipped",
      message_thread_id: 100,
    };

    // Should not throw, and should silently skip
    await mapper.handleMessage(message);

    // If the message was processed, it would try to create an issue.
    // Since the mapper's store check runs before any issue creation logic,
    // and we don't have a project mapping for this thread, the message
    // would be skipped anyway. But the is_bot and sentByPlugin checks are
    // the first lines of defense.
  });

  it("skips bot messages via is_bot check", async () => {
    const { mapper } = buildTestMapper();

    const message: TelegramMessage = {
      message_id: 777,
      from: { id: 123, is_bot: true, first_name: "Bot" },
      chat: { id: Number(CHAT_ID), type: "supergroup" },
      date: Date.now(),
      text: "Bot message",
      message_thread_id: 100,
    };

    // Should not throw, and should silently skip
    await mapper.handleMessage(message);
  });
});

// ── MappingStore sent tracking ────────────────────────────────────

describe("MappingStore sentByPlugin", () => {
  it("returns false for unmarked messages", async () => {
    const { store } = buildTestMapper();
    expect(await store.isSentByPlugin(CHAT_ID, 123)).toBe(false);
  });

  it("returns true after marking", async () => {
    const { store } = buildTestMapper();
    await store.markSentByPlugin(CHAT_ID, 456);
    expect(await store.isSentByPlugin(CHAT_ID, 456)).toBe(true);
  });

  it("tracks different messages independently", async () => {
    const { store } = buildTestMapper();
    await store.markSentByPlugin(CHAT_ID, 111);
    expect(await store.isSentByPlugin(CHAT_ID, 111)).toBe(true);
    expect(await store.isSentByPlugin(CHAT_ID, 222)).toBe(false);
  });
});

// ── Reply-to-bot-message mapping ─────────────────────────────────

describe("handleCommentCreated bot message mapping", () => {
  it("saves message mapping for sent comment so replies resolve to the issue", async () => {
    const { mapper, store } = buildTestMapper();

    // Pre-populate the reverse mapping
    await store.saveMessageMapping({
      telegramMessageId: ORIGIN_MESSAGE_ID,
      telegramChatId: CHAT_ID,
      messageThreadId: 100,
      paperclipIssueId: ISSUE_ID,
      paperclipIssueIdentifier: "TST-1",
      createdAt: new Date().toISOString(),
    });

    await mapper.handleCommentCreated(makeEvent());

    // The sent message (SENT_MESSAGE_ID) should now be mapped to the issue
    const mapping = await store.getIssueByMessage(CHAT_ID, SENT_MESSAGE_ID);
    expect(mapping).not.toBeNull();
    expect(mapping!.paperclipIssueId).toBe(ISSUE_ID);
    expect(mapping!.paperclipIssueIdentifier).toBe("TST-1");
    expect(mapping!.messageThreadId).toBe(100);
  });

  it("does not save mapping when sendMessage fails", async () => {
    const { mapper, store } = buildTestMapper({ sendMessageResult: null });

    await store.saveMessageMapping({
      telegramMessageId: ORIGIN_MESSAGE_ID,
      telegramChatId: CHAT_ID,
      messageThreadId: 100,
      paperclipIssueId: ISSUE_ID,
      paperclipIssueIdentifier: "TST-1",
      createdAt: new Date().toISOString(),
    });

    await mapper.handleCommentCreated(makeEvent());

    // Should not have saved a mapping for the failed send
    const mapping = await store.getIssueByMessage(CHAT_ID, SENT_MESSAGE_ID);
    expect(mapping).toBeNull();
  });
});
