import { describe, expect, it, vi, afterEach } from "vitest";
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
const PROJECT_ID = "proj-general";
const SENT_MESSAGE_ID = 999;

function makeConfig(overrides?: Partial<TelegramForumConfig>): TelegramForumConfig {
  return {
    telegramBotToken: BOT_TOKEN,
    telegramChatId: CHAT_ID,
    paperclipApiUrl: "http://localhost:3100",
    paperclipApiKey: "test-api-key",
    paperclipCompanyId: COMPANY_ID,
    pollingIntervalMs: 999999,
    // Map general topic (sentinel "0") to a known project
    topicProjectMap: { "0": PROJECT_ID },
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const now = new Date();
  return {
    id: "issue-general-001",
    companyId: COMPANY_ID,
    projectId: PROJECT_ID,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "General topic issue",
    description: "From general topic",
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
    issueNumber: 10,
    identifier: "TST-10",
    originKind: "telegram",
    originId: `${CHAT_ID}:200`,
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

function buildTestMapper(options?: {
  issue?: Issue;
  agent?: Agent;
  sendMessageResult?: number | null;
  configOverrides?: Partial<TelegramForumConfig>;
}) {
  const config = makeConfig(options?.configOverrides);
  const issue = options?.issue ?? makeIssue();
  const agent = options?.agent ?? makeAgent();
  const sendResult =
    options && "sendMessageResult" in options
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

  const sendMessageSpy = vi
    .spyOn(telegram, "sendMessage")
    .mockResolvedValue(sendResult);

  const mapper = new MessageMapper(harness.ctx, config, store, telegram);

  return { harness, mapper, store, telegram, sendMessageSpy };
}

/** A general topic message — no message_thread_id. */
function makeGeneralMessage(
  overrides: Partial<TelegramMessage> = {}
): TelegramMessage {
  return {
    message_id: 200,
    from: {
      id: 99001,
      is_bot: false,
      first_name: "Alice",
      username: "alicesmith",
    },
    chat: { id: Number(CHAT_ID), type: "supergroup" },
    date: Date.now(),
    text: "Hello from general topic",
    // No message_thread_id — this is the key property of general topic messages
    ...overrides,
  };
}

// ── General topic: incoming message routing ──────────────────────

describe("general topic incoming messages", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates an issue from a general topic message (no message_thread_id)", async () => {
    const { mapper, store } = buildTestMapper();

    const createdIssue = {
      id: "new-issue-gen",
      identifier: "TST-20",
      title: "Hello from general topic",
      status: "todo",
    };

    // Mock fetch for issue creation
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(createdIssue), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await mapper.handleMessage(makeGeneralMessage());

    // Issue creation fetch should have been called
    expect(fetchSpy).toHaveBeenCalled();
    const fetchCall = fetchSpy.mock.calls[0];
    expect(fetchCall[0]).toContain("/api/companies/");
    expect(fetchCall[0]).toContain("/issues");

    // Message mapping should be saved with messageThreadId === undefined
    const mapping = await store.getIssueByMessage(CHAT_ID, 200);
    expect(mapping).not.toBeNull();
    expect(mapping!.paperclipIssueId).toBe("new-issue-gen");
    expect(mapping!.messageThreadId).toBeUndefined();
  });

  it("appends as comment when an open issue exists in the general topic thread", async () => {
    const issue = makeIssue({ id: "existing-gen", identifier: "TST-10", status: "in_progress" });
    const { mapper, store } = buildTestMapper({ issue });

    // Pre-populate the thread-latest index for general topic (key 0)
    await store.saveMessageMapping({
      telegramMessageId: 100,
      telegramChatId: CHAT_ID,
      messageThreadId: undefined, // general topic
      paperclipIssueId: "existing-gen",
      paperclipIssueIdentifier: "TST-10",
      createdAt: new Date().toISOString(),
    });

    // Mock fetch for comment creation
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "comment-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await mapper.handleMessage(
      makeGeneralMessage({ message_id: 201, text: "Follow-up in general" })
    );

    // Should have posted a comment, not created a new issue
    expect(fetchSpy).toHaveBeenCalled();
    const fetchCall = fetchSpy.mock.calls[0];
    expect(fetchCall[0]).toContain("/comments");

    // New message should be mapped to the existing issue
    const mapping = await store.getIssueByMessage(CHAT_ID, 201);
    expect(mapping).not.toBeNull();
    expect(mapping!.paperclipIssueId).toBe("existing-gen");
  });

  it("saves thread-latest index for general topic messages", async () => {
    const { store } = buildTestMapper();

    // Save a mapping with undefined messageThreadId (general topic)
    await store.saveMessageMapping({
      telegramMessageId: 300,
      telegramChatId: CHAT_ID,
      messageThreadId: undefined,
      paperclipIssueId: "issue-gen-latest",
      paperclipIssueIdentifier: "TST-30",
      createdAt: new Date().toISOString(),
    });

    // Thread-latest lookup with sentinel 0 should return the mapping
    const latest = await store.getLatestIssueByThread(0);
    expect(latest).not.toBeNull();
    expect(latest!.paperclipIssueId).toBe("issue-gen-latest");
  });
});

// ── General topic: outgoing response routing ─────────────────────

describe("general topic outgoing responses", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends comment to Telegram without message_thread_id for general topic issues", async () => {
    const issue = makeIssue({
      id: "issue-gen-out",
      identifier: "TST-11",
      originKind: "telegram",
      originId: `${CHAT_ID}:200`,
    });
    const { mapper, store, sendMessageSpy } = buildTestMapper({ issue });

    // Pre-populate mapping with undefined messageThreadId (general topic)
    await store.saveMessageMapping({
      telegramMessageId: 200,
      telegramChatId: CHAT_ID,
      messageThreadId: undefined,
      paperclipIssueId: "issue-gen-out",
      paperclipIssueIdentifier: "TST-11",
      createdAt: new Date().toISOString(),
    });

    const event: PluginEvent = {
      eventId: "evt-gen-001",
      eventType: "issue.comment.created",
      occurredAt: new Date().toISOString(),
      companyId: COMPANY_ID,
      entityId: "issue-gen-out",
      entityType: "issue",
      actorId: AGENT_ID,
      actorType: "agent",
      payload: { body: "Reply from agent" },
    };

    await mapper.handleCommentCreated(event);

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [chatId, text, threadId, replyTo] = sendMessageSpy.mock.calls[0];
    expect(chatId).toBe(CHAT_ID);
    expect(text).toContain("Reply from agent");
    // messageThreadId should be undefined (not passed) for general topic
    expect(threadId).toBeUndefined();
    expect(replyTo).toBe(200);
  });

  it("sends status update to general topic without message_thread_id", async () => {
    const issue = makeIssue({
      id: "issue-gen-status",
      identifier: "TST-12",
      status: "done",
      originKind: "telegram",
      originId: `${CHAT_ID}:200`,
    });
    const { mapper, store, sendMessageSpy } = buildTestMapper({ issue });

    await store.saveMessageMapping({
      telegramMessageId: 200,
      telegramChatId: CHAT_ID,
      messageThreadId: undefined,
      paperclipIssueId: "issue-gen-status",
      paperclipIssueIdentifier: "TST-12",
      createdAt: new Date().toISOString(),
    });

    const event: PluginEvent = {
      eventId: "evt-gen-002",
      eventType: "issue.updated",
      occurredAt: new Date().toISOString(),
      companyId: COMPANY_ID,
      entityId: "issue-gen-status",
      entityType: "issue",
      actorId: AGENT_ID,
      actorType: "agent",
      payload: { status: "done" },
    };

    await mapper.handleIssueUpdated(event);

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, , threadId] = sendMessageSpy.mock.calls[0];
    expect(threadId).toBeUndefined();
  });
});

// ── General topic: commands ──────────────────────────────────────

describe("general topic commands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("/status works in the general topic", async () => {
    const issue = makeIssue({ id: "issue-gen-cmd", identifier: "TST-13", status: "in_progress" });
    const { mapper, store, sendMessageSpy } = buildTestMapper({ issue });

    // Seed thread-latest for general topic
    await store.saveMessageMapping({
      telegramMessageId: 200,
      telegramChatId: CHAT_ID,
      messageThreadId: undefined,
      paperclipIssueId: "issue-gen-cmd",
      paperclipIssueIdentifier: "TST-13",
      createdAt: new Date().toISOString(),
    });

    await mapper.handleMessage(
      makeGeneralMessage({ message_id: 501, text: "/status" })
    );

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text, threadId] = sendMessageSpy.mock.calls[0];
    expect(text).toContain("TST-13");
    expect(text).toContain("in_progress");
    // Should reply in general topic (no thread ID)
    expect(threadId).toBeUndefined();
  });

  it("/new creates an issue in the general topic project", async () => {
    const { mapper, store } = buildTestMapper();

    const createdIssue = {
      id: "new-gen-issue",
      identifier: "TST-21",
      title: "General topic task",
      status: "todo",
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(createdIssue), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await mapper.handleMessage(
      makeGeneralMessage({ message_id: 502, text: "/new General topic task" })
    );

    expect(fetchSpy).toHaveBeenCalled();

    // Verify the issue creation request includes the general topic project
    const createCall = fetchSpy.mock.calls.find(
      (call) => String(call[0]).includes("/issues") && !String(call[0]).includes("/comments")
    );
    expect(createCall).toBeDefined();
    const body = JSON.parse(String((createCall![1] as RequestInit).body));
    expect(body.projectId).toBe(PROJECT_ID);
  });
});

// ── General topic: reply resolution ──────────────────────────────

describe("general topic reply resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves replies in general topic via thread-level fallback", async () => {
    const issue = makeIssue({ id: "issue-gen-reply", identifier: "TST-14", status: "in_progress" });
    const { mapper, store } = buildTestMapper({ issue });

    // Seed mapping for a general topic message
    await store.saveMessageMapping({
      telegramMessageId: 200,
      telegramChatId: CHAT_ID,
      messageThreadId: undefined,
      paperclipIssueId: "issue-gen-reply",
      paperclipIssueIdentifier: "TST-14",
      createdAt: new Date().toISOString(),
    });

    // Mock fetch for comment creation
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "comment-reply" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    // Reply to a message in general topic (reply_to_message set, no thread_id)
    await mapper.handleMessage(
      makeGeneralMessage({
        message_id: 601,
        text: "Replying in general",
        reply_to_message: {
          message_id: 200,
          chat: { id: Number(CHAT_ID), type: "supergroup" },
          date: Date.now(),
          from: { id: 1, is_bot: true, first_name: "Bot" },
        },
      })
    );

    // Should have posted a comment via fetch
    expect(fetchSpy).toHaveBeenCalled();
    const commentCall = fetchSpy.mock.calls.find((call) =>
      String(call[0]).includes("/comments")
    );
    expect(commentCall).toBeDefined();

    // Reply mapping should be saved
    const mapping = await store.getIssueByMessage(CHAT_ID, 601);
    expect(mapping).not.toBeNull();
    expect(mapping!.paperclipIssueId).toBe("issue-gen-reply");
  });
});
