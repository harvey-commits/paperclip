import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue, Agent } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import { MessageMapper } from "../src/mapper.js";
import { MappingStore } from "../src/store.js";
import { TelegramClient } from "../src/telegram.js";
import type { TelegramForumConfig, TelegramMessage } from "../src/types.js";

const COMPANY_ID = "test-company";
const CHAT_ID = "-1001234567890";
const BOT_TOKEN = "123456:ABC-DEF";
const AGENT_ID = "agent-001";
const TELEGRAM_USER_ID = "99001";
const PAPERCLIP_USER_ID = "puser-abc-123";
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
    id: "issue-001",
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
    originId: `${CHAT_ID}:42`,
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

function makeAgent(): Agent {
  const now = new Date();
  return {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    name: "Test Agent",
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
  };
}

function buildTestMapper() {
  const config = makeConfig();
  const harness = createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities],
    config,
  });

  harness.seed({ issues: [makeIssue()], agents: [makeAgent()] });

  const store = new MappingStore(harness.ctx, COMPANY_ID);
  const telegram = new TelegramClient(harness.ctx, BOT_TOKEN);
  const sendMessageSpy = vi.spyOn(telegram, "sendMessage").mockResolvedValue(SENT_MESSAGE_ID);

  const mapper = new MessageMapper(harness.ctx, config, store, telegram);

  return { harness, mapper, store, telegram, sendMessageSpy };
}

function makeTelegramMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 500,
    from: {
      id: Number(TELEGRAM_USER_ID),
      is_bot: false,
      first_name: "Alice",
      last_name: "Smith",
      username: "alicesmith",
    },
    chat: { id: Number(CHAT_ID), type: "supergroup" },
    date: Date.now(),
    message_thread_id: 100,
    ...overrides,
  };
}

// ── MappingStore user mapping ───────────────────────────────────

describe("MappingStore user mapping", () => {
  it("returns null for unmapped users", async () => {
    const { store } = buildTestMapper();
    expect(await store.getUserMapping("unknown-id")).toBeNull();
  });

  it("stores and retrieves forward mapping", async () => {
    const { store } = buildTestMapper();

    await store.setUserMapping(TELEGRAM_USER_ID, PAPERCLIP_USER_ID, "Alice Smith");

    const mapping = await store.getUserMapping(TELEGRAM_USER_ID);
    expect(mapping).not.toBeNull();
    expect(mapping!.telegramUserId).toBe(TELEGRAM_USER_ID);
    expect(mapping!.paperclipUserId).toBe(PAPERCLIP_USER_ID);
    expect(mapping!.telegramDisplayName).toBe("Alice Smith");
  });

  it("stores and retrieves reverse mapping", async () => {
    const { store } = buildTestMapper();

    await store.setUserMapping(TELEGRAM_USER_ID, PAPERCLIP_USER_ID);

    const mapping = await store.getUserMappingByPaperclipId(PAPERCLIP_USER_ID);
    expect(mapping).not.toBeNull();
    expect(mapping!.telegramUserId).toBe(TELEGRAM_USER_ID);
    expect(mapping!.paperclipUserId).toBe(PAPERCLIP_USER_ID);
  });

  it("returns null for reverse lookup on unmapped user", async () => {
    const { store } = buildTestMapper();
    expect(await store.getUserMappingByPaperclipId("unknown-puser")).toBeNull();
  });

  it("handles null display name", async () => {
    const { store } = buildTestMapper();

    await store.setUserMapping(TELEGRAM_USER_ID, PAPERCLIP_USER_ID);

    const mapping = await store.getUserMapping(TELEGRAM_USER_ID);
    expect(mapping!.telegramDisplayName).toBeNull();
  });

  it("tracks different users independently", async () => {
    const { store } = buildTestMapper();

    await store.setUserMapping("user-1", "puser-1", "User One");
    await store.setUserMapping("user-2", "puser-2", "User Two");

    const m1 = await store.getUserMapping("user-1");
    const m2 = await store.getUserMapping("user-2");
    expect(m1!.paperclipUserId).toBe("puser-1");
    expect(m2!.paperclipUserId).toBe("puser-2");
  });

  it("overwrites existing mapping on update", async () => {
    const { store } = buildTestMapper();

    await store.setUserMapping(TELEGRAM_USER_ID, "old-puser");
    await store.setUserMapping(TELEGRAM_USER_ID, "new-puser", "New Name");

    const mapping = await store.getUserMapping(TELEGRAM_USER_ID);
    expect(mapping!.paperclipUserId).toBe("new-puser");
    expect(mapping!.telegramDisplayName).toBe("New Name");
  });
});

// ── /whoami command ─────────────────────────────────────────────

describe("/whoami command", () => {
  it("replies with mapping when user is mapped", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper();

    await store.setUserMapping(TELEGRAM_USER_ID, PAPERCLIP_USER_ID, "Alice Smith");

    const message = makeTelegramMessage({ text: "/whoami" });
    await mapper.handleMessage(message);

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [chatId, text, threadId, replyTo] = sendMessageSpy.mock.calls[0];
    expect(chatId).toBe(CHAT_ID);
    expect(text).toContain("You are mapped!");
    expect(text).toContain(PAPERCLIP_USER_ID);
    expect(text).toContain("Alice Smith");
    expect(threadId).toBe(100);
    expect(replyTo).toBe(500);
  });

  it("replies with 'not mapped' when user has no mapping", async () => {
    const { mapper, sendMessageSpy } = buildTestMapper();

    const message = makeTelegramMessage({ text: "/whoami" });
    await mapper.handleMessage(message);

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text] = sendMessageSpy.mock.calls[0];
    expect(text).toContain("Not mapped yet");
    expect(text).toContain(TELEGRAM_USER_ID);
  });

  it("handles missing from field gracefully", async () => {
    const { mapper, sendMessageSpy } = buildTestMapper();

    const message = makeTelegramMessage({ text: "/whoami", from: undefined });
    await mapper.handleMessage(message);

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text] = sendMessageSpy.mock.calls[0];
    expect(text).toContain("Could not identify");
  });

  it("does not create issues for /whoami command", async () => {
    const { mapper, harness } = buildTestMapper();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    const message = makeTelegramMessage({ text: "/whoami" });
    await mapper.handleMessage(message);

    // Should only be sendMessage calls, not issue creation
    const issueCalls = fetchSpy.mock.calls.filter(
      ([url]) => typeof url === "string" && url.includes("/api/companies/") && url.includes("/issues")
    );
    expect(issueCalls).toHaveLength(0);
    fetchSpy.mockRestore();
  });

  it("skips /whoami from bots", async () => {
    const { mapper, sendMessageSpy } = buildTestMapper();

    const message = makeTelegramMessage({
      text: "/whoami",
      from: { id: 123, is_bot: true, first_name: "Bot" },
    });
    await mapper.handleMessage(message);

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });
});

// ── User attribution in issue/comment creation ──────────────────

describe("user attribution", () => {
  it("includes createdByUserId in issue creation when user is mapped", async () => {
    const { mapper, store } = buildTestMapper();

    await store.setUserMapping(TELEGRAM_USER_ID, PAPERCLIP_USER_ID, "Alice");

    // Set up project mapping so issue creation proceeds
    await store.saveTopicMapping({
      messageThreadId: 100,
      projectId: "proj-001",
      projectName: "Test Project",
      createdAt: new Date().toISOString(),
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ id: "new-issue", identifier: "TST-2", title: "Test", status: "todo" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const message = makeTelegramMessage({ text: "New issue from mapped user" });
    await mapper.handleMessage(message);

    // Find the issue creation call
    const issueCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === "string" && url.includes("/api/companies/") && url.includes("/issues")
    );
    expect(issueCall).toBeDefined();
    const body = JSON.parse(issueCall![1]!.body as string);
    expect(body.createdByUserId).toBe(PAPERCLIP_USER_ID);
    fetchSpy.mockRestore();
  });

  it("omits createdByUserId when user is not mapped", async () => {
    const { mapper, store } = buildTestMapper();

    await store.saveTopicMapping({
      messageThreadId: 100,
      projectId: "proj-001",
      projectName: "Test Project",
      createdAt: new Date().toISOString(),
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ id: "new-issue", identifier: "TST-3", title: "Test", status: "todo" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const message = makeTelegramMessage({ text: "New issue from unmapped user" });
    await mapper.handleMessage(message);

    const issueCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === "string" && url.includes("/api/companies/") && url.includes("/issues")
    );
    expect(issueCall).toBeDefined();
    const body = JSON.parse(issueCall![1]!.body as string);
    expect(body.createdByUserId).toBeUndefined();
    fetchSpy.mockRestore();
  });
});

// ── Auto-assignment via topicAgentMap ─────────────────────────────

describe("topicAgentMap auto-assignment", () => {
  function buildTestMapperWithAgentMap(agentMap: Record<string, string>) {
    const config: TelegramForumConfig = {
      ...makeConfig(),
      topicAgentMap: agentMap,
    };
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config,
    });

    harness.seed({ issues: [makeIssue()], agents: [makeAgent()] });

    const store = new MappingStore(harness.ctx, COMPANY_ID);
    const telegram = new TelegramClient(harness.ctx, BOT_TOKEN);
    const sendMessageSpy = vi.spyOn(telegram, "sendMessage").mockResolvedValue(SENT_MESSAGE_ID);

    const mapper = new MessageMapper(harness.ctx, config, store, telegram);

    return { harness, mapper, store, telegram, sendMessageSpy, config };
  }

  it("includes assigneeAgentId when topicAgentMap maps the thread (top-level message)", async () => {
    const targetAgent = "agent-auto-assigned-001";
    const { mapper, store } = buildTestMapperWithAgentMap({ "100": targetAgent });

    await store.saveTopicMapping({
      messageThreadId: 100,
      projectId: "proj-001",
      projectName: "Test Project",
      createdAt: new Date().toISOString(),
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ id: "new-issue", identifier: "TST-10", title: "Test", status: "todo" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await mapper.handleMessage(makeTelegramMessage({ text: "Auto-assign me" }));

    const issueCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === "string" && url.includes("/api/companies/") && url.includes("/issues")
    );
    expect(issueCall).toBeDefined();
    const body = JSON.parse(issueCall![1]!.body as string);
    expect(body.assigneeAgentId).toBe(targetAgent);
    fetchSpy.mockRestore();
  });

  it("includes assigneeAgentId when topicAgentMap maps the thread (/new command)", async () => {
    const targetAgent = "agent-auto-assigned-002";
    const { mapper, store } = buildTestMapperWithAgentMap({ "100": targetAgent });

    await store.saveTopicMapping({
      messageThreadId: 100,
      projectId: "proj-001",
      projectName: "Test Project",
      createdAt: new Date().toISOString(),
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ id: "new-issue", identifier: "TST-11", title: "Test", status: "todo" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await mapper.handleMessage(makeTelegramMessage({ text: "/new Auto-assigned issue" }));

    const issueCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === "string" && url.includes("/api/companies/") && url.includes("/issues")
    );
    expect(issueCall).toBeDefined();
    const body = JSON.parse(issueCall![1]!.body as string);
    expect(body.assigneeAgentId).toBe(targetAgent);
    fetchSpy.mockRestore();
  });

  it("omits assigneeAgentId when topic is not in topicAgentMap", async () => {
    const { mapper, store } = buildTestMapperWithAgentMap({ "999": "agent-for-other-topic" });

    await store.saveTopicMapping({
      messageThreadId: 100,
      projectId: "proj-001",
      projectName: "Test Project",
      createdAt: new Date().toISOString(),
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ id: "new-issue", identifier: "TST-12", title: "Test", status: "todo" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await mapper.handleMessage(makeTelegramMessage({ text: "No auto-assign for this topic" }));

    const issueCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === "string" && url.includes("/api/companies/") && url.includes("/issues")
    );
    expect(issueCall).toBeDefined();
    const body = JSON.parse(issueCall![1]!.body as string);
    expect(body.assigneeAgentId).toBeUndefined();
    fetchSpy.mockRestore();
  });

  it("omits assigneeAgentId when topicAgentMap is not configured", async () => {
    const { mapper, store } = buildTestMapper();

    await store.saveTopicMapping({
      messageThreadId: 100,
      projectId: "proj-001",
      projectName: "Test Project",
      createdAt: new Date().toISOString(),
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ id: "new-issue", identifier: "TST-13", title: "Test", status: "todo" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await mapper.handleMessage(makeTelegramMessage({ text: "No agent map configured" }));

    const issueCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === "string" && url.includes("/api/companies/") && url.includes("/issues")
    );
    expect(issueCall).toBeDefined();
    const body = JSON.parse(issueCall![1]!.body as string);
    expect(body.assigneeAgentId).toBeUndefined();
    fetchSpy.mockRestore();
  });
});
