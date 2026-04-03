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
const THREAD_ID = 100;

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
    assigneeAgentId: AGENT_ID,
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
    eventType: "issue.updated",
    occurredAt: new Date().toISOString(),
    companyId: COMPANY_ID,
    entityId: ISSUE_ID,
    entityType: "issue",
    actorId: AGENT_ID,
    actorType: "agent",
    payload: { status: "done" },
    ...overrides,
  };
}

function buildTestMapper(options?: {
  issue?: Issue;
  agent?: Agent;
  extraAgents?: Agent[];
  sendMessageResult?: number | null;
}) {
  const config = makeConfig();
  const issue = options?.issue ?? makeIssue();
  const agent = options?.agent ?? makeAgent();
  const allAgents = [agent, ...(options?.extraAgents ?? [])];
  const sendResult =
    options && "sendMessageResult" in options
      ? options.sendMessageResult
      : SENT_MESSAGE_ID;

  const harness = createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities],
    config,
  });

  harness.seed({ issues: [issue], agents: allAgents });

  const store = new MappingStore(harness.ctx, COMPANY_ID);
  const telegram = new TelegramClient(harness.ctx, BOT_TOKEN);

  const sendMessageSpy = vi
    .spyOn(telegram, "sendMessage")
    .mockResolvedValue(sendResult);

  const mapper = new MessageMapper(harness.ctx, config, store, telegram);

  return { harness, mapper, store, telegram, sendMessageSpy };
}

function makeTelegramMessage(
  overrides: Partial<TelegramMessage> = {}
): TelegramMessage {
  return {
    message_id: 500,
    from: {
      id: 99001,
      is_bot: false,
      first_name: "Alice",
      last_name: "Smith",
      username: "alicesmith",
    },
    chat: { id: Number(CHAT_ID), type: "supergroup" },
    date: Date.now(),
    message_thread_id: THREAD_ID,
    ...overrides,
  };
}

/** Seed a Telegram→Paperclip user mapping so auth checks pass. */
async function seedUserMapping(store: MappingStore): Promise<void> {
  await store.setUserMapping("99001", "paperclip-user-001", "Alice Smith");
}

async function seedMapping(store: MappingStore): Promise<void> {
  await store.saveMessageMapping({
    telegramMessageId: ORIGIN_MESSAGE_ID,
    telegramChatId: CHAT_ID,
    messageThreadId: THREAD_ID,
    paperclipIssueId: ISSUE_ID,
    paperclipIssueIdentifier: "TST-1",
    createdAt: new Date().toISOString(),
  });
}

// ── /assign auth boundary (unmapped user) ──────────────────────
describe("/assign auth boundary", () => {
  it("rejects unmapped user with auth error", async () => {
    const { mapper, store, sendMessageSpy, harness } = buildTestMapper();
    await seedMapping(store);
    // Do NOT seed user mapping

    const updateSpy = vi.spyOn(harness.ctx.issues, "update");

    await mapper.handleMessage(
      makeTelegramMessage({ text: "/assign @test-agent" })
    );

    // Should NOT have called issues.update
    expect(updateSpy).not.toHaveBeenCalled();
    // Should reply with auth error
    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text] = sendMessageSpy.mock.calls[0];
    expect(text).toContain("linked to a Paperclip account");
  });
});

// ── /close auth boundary (unmapped user) ───────────────────────
describe("/close auth boundary", () => {
  it("rejects unmapped user with auth error", async () => {
    const { mapper, store, sendMessageSpy, harness } = buildTestMapper();
    await seedMapping(store);
    // Do NOT seed user mapping

    const updateSpy = vi.spyOn(harness.ctx.issues, "update");

    await mapper.handleMessage(makeTelegramMessage({ text: "/close" }));

    // Should NOT have updated the issue
    expect(updateSpy).not.toHaveBeenCalled();
    // Should reply with auth error
    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text] = sendMessageSpy.mock.calls[0];
    expect(text).toContain("linked to a Paperclip account");
  });
});

// ── Rate limiting ──────────────────────────────────────────────
describe("rate limiting", () => {
  it("throttles rapid /status commands in the same topic", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper();
    await seedMapping(store);

    // Send RATE_LIMIT_PER_TOPIC (10) + 1 commands in rapid succession
    for (let i = 0; i < 11; i++) {
      await mapper.handleMessage(
        makeTelegramMessage({ message_id: 600 + i, text: "/status" })
      );
    }

    // The 11th command should have been throttled (only 10 allowed per minute per topic)
    expect(sendMessageSpy.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("throttles rapid /close commands in the same topic", async () => {
    const { mapper, store, sendMessageSpy, harness } = buildTestMapper();
    await seedMapping(store);
    await seedUserMapping(store);

    const updateSpy = vi.spyOn(harness.ctx.issues, "update");

    // Send 11 /close commands
    for (let i = 0; i < 11; i++) {
      await mapper.handleMessage(
        makeTelegramMessage({ message_id: 700 + i, text: "/close" })
      );
    }

    // Updates should be limited to at most 10
    expect(updateSpy.mock.calls.length).toBeLessThanOrEqual(10);
  });
});

// ── /status command ──────────────────────────────────────────────

describe("/status command", () => {
  it("replies with issue status, priority, and assignee", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper();
    await seedMapping(store);

    await mapper.handleMessage(makeTelegramMessage({ text: "/status" }));

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [chatId, text, threadId, replyTo] = sendMessageSpy.mock.calls[0];
    expect(chatId).toBe(CHAT_ID);
    expect(text).toContain("TST-1");
    expect(text).toContain("Test Issue");
    expect(text).toContain("in_progress");
    expect(text).toContain("medium");
    expect(text).toContain(AGENT_NAME);
    expect(threadId).toBe(THREAD_ID);
    expect(replyTo).toBe(500);
  });

  it("replies with error when no linked issue in thread", async () => {
    const { mapper, sendMessageSpy } = buildTestMapper();

    await mapper.handleMessage(makeTelegramMessage({ text: "/status" }));

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text] = sendMessageSpy.mock.calls[0];
    expect(text).toContain("No linked issue");
  });

  it("omits assignee line when issue has no assignee", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper({
      issue: makeIssue({ assigneeAgentId: null }),
    });
    await seedMapping(store);

    await mapper.handleMessage(makeTelegramMessage({ text: "/status" }));

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text] = sendMessageSpy.mock.calls[0];
    expect(text).not.toContain("Assignee");
  });

  it("resolves issue from reply when command is a reply", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper();
    await seedMapping(store);

    const message = makeTelegramMessage({
      text: "/status",
      reply_to_message: {
        message_id: ORIGIN_MESSAGE_ID,
        chat: { id: Number(CHAT_ID), type: "supergroup" },
        date: Date.now(),
      },
    });
    await mapper.handleMessage(message);

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text] = sendMessageSpy.mock.calls[0];
    expect(text).toContain("TST-1");
  });
});

// ── /assign command ──────────────────────────────────────────────

describe("/assign command", () => {
  it("reassigns issue to matched agent", async () => {
    const secondAgent = makeAgent({
      id: "agent-002",
      name: "Backend Lead",
      urlKey: "backend-lead",
    });
    const { mapper, store, sendMessageSpy, harness } = buildTestMapper({
      extraAgents: [secondAgent],
    });
    await seedMapping(store);
    await seedUserMapping(store);

    const updateSpy = vi.spyOn(harness.ctx.issues, "update");

    await mapper.handleMessage(
      makeTelegramMessage({ text: "/assign @backend-lead" })
    );

    expect(updateSpy).toHaveBeenCalledWith(
      ISSUE_ID,
      { assigneeAgentId: "agent-002" },
      COMPANY_ID
    );
    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text] = sendMessageSpy.mock.calls[0];
    expect(text).toContain("TST-1");
    expect(text).toContain("assigned to");
    expect(text).toContain("Backend Lead");
  });

  it("replies with error when agent not found", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper();
    await seedMapping(store);
    await seedUserMapping(store);

    await mapper.handleMessage(
      makeTelegramMessage({ text: "/assign @nonexistent" })
    );

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text] = sendMessageSpy.mock.calls[0];
    expect(text).toContain("not found");
  });

  it("replies with usage when no agent name provided", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper();
    await seedUserMapping(store);

    await mapper.handleMessage(makeTelegramMessage({ text: "/assign " }));

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text] = sendMessageSpy.mock.calls[0];
    expect(text).toContain("Usage");
  });

  it("replies with error when no linked issue", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper();
    await seedUserMapping(store);

    await mapper.handleMessage(
      makeTelegramMessage({ text: "/assign @test-agent" })
    );

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text] = sendMessageSpy.mock.calls[0];
    expect(text).toContain("No linked issue");
  });

  it("matches agent by name (case-insensitive)", async () => {
    const { mapper, store, sendMessageSpy, harness } = buildTestMapper();
    await seedMapping(store);
    await seedUserMapping(store);

    const updateSpy = vi.spyOn(harness.ctx.issues, "update");

    await mapper.handleMessage(
      makeTelegramMessage({ text: "/assign test agent" })
    );

    expect(updateSpy).toHaveBeenCalledWith(
      ISSUE_ID,
      { assigneeAgentId: AGENT_ID },
      COMPANY_ID
    );
    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text] = sendMessageSpy.mock.calls[0];
    expect(text).toContain("assigned to");
  });
});

// ── /close command ───────────────────────────────────────────────

describe("/close command", () => {
  it("marks issue as done and replies with confirmation", async () => {
    const { mapper, store, sendMessageSpy, harness } = buildTestMapper();
    await seedMapping(store);
    await seedUserMapping(store);

    const updateSpy = vi.spyOn(harness.ctx.issues, "update");

    await mapper.handleMessage(makeTelegramMessage({ text: "/close" }));

    expect(updateSpy).toHaveBeenCalledWith(
      ISSUE_ID,
      { status: "done" },
      COMPANY_ID
    );
    expect(sendMessageSpy).toHaveBeenCalled();
    const lastCall = sendMessageSpy.mock.calls[sendMessageSpy.mock.calls.length - 1];
    expect(lastCall[1]).toContain("TST-1");
    expect(lastCall[1]).toContain("closed");
  });

  it("marks status change as plugin-initiated for loop prevention", async () => {
    const { mapper, store } = buildTestMapper();
    await seedMapping(store);
    await seedUserMapping(store);

    await mapper.handleMessage(makeTelegramMessage({ text: "/close" }));

    expect(await store.isPluginStatusChange(ISSUE_ID)).toBe(true);
  });

  it("replies with error when no linked issue", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper();
    await seedUserMapping(store);

    await mapper.handleMessage(makeTelegramMessage({ text: "/close" }));

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text] = sendMessageSpy.mock.calls[0];
    expect(text).toContain("No linked issue");
  });
});

// ── handleIssueUpdated (status change notifications) ─────────────

describe("handleIssueUpdated", () => {
  it("sends notification to Telegram for done status", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper();
    await seedMapping(store);

    await mapper.handleIssueUpdated(makeEvent({ payload: { status: "done" } }));

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [chatId, text, threadId, replyTo] = sendMessageSpy.mock.calls[0];
    expect(chatId).toBe(CHAT_ID);
    expect(text).toContain("TST-1");
    expect(text).toContain("done");
    expect(text).toContain(AGENT_NAME);
    expect(threadId).toBe(THREAD_ID);
    expect(replyTo).toBe(ORIGIN_MESSAGE_ID);
  });

  it("sends notification for blocked status", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper({
      issue: makeIssue({ status: "blocked" }),
    });
    await seedMapping(store);

    await mapper.handleIssueUpdated(
      makeEvent({ payload: { status: "blocked" } })
    );

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text] = sendMessageSpy.mock.calls[0];
    expect(text).toContain("blocked");
  });

  it("sends notification for in_progress status", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper();
    await seedMapping(store);

    await mapper.handleIssueUpdated(
      makeEvent({ payload: { status: "in_progress" } })
    );

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text] = sendMessageSpy.mock.calls[0];
    expect(text).toContain("in progress");
  });

  it("skips non-meaningful status transitions", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper();
    await seedMapping(store);

    await mapper.handleIssueUpdated(
      makeEvent({ payload: { status: "backlog" } })
    );

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("skips events from plugin actor type", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper();
    await seedMapping(store);

    await mapper.handleIssueUpdated(
      makeEvent({ actorType: "plugin", payload: { status: "done" } })
    );

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("skips events with no entityId", async () => {
    const { mapper, sendMessageSpy } = buildTestMapper();

    await mapper.handleIssueUpdated(
      makeEvent({ entityId: undefined, payload: { status: "done" } })
    );

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("skips events with no status in payload", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper();
    await seedMapping(store);

    await mapper.handleIssueUpdated(
      makeEvent({ payload: { title: "New title" } })
    );

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("skips plugin-initiated status changes (/close loop prevention)", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper();
    await seedMapping(store);

    // Mark as plugin-initiated (as /close does)
    await store.markPluginStatusChange(ISSUE_ID);

    await mapper.handleIssueUpdated(makeEvent({ payload: { status: "done" } }));

    expect(sendMessageSpy).not.toHaveBeenCalled();
    // Flag should be cleared after check
    expect(await store.isPluginStatusChange(ISSUE_ID)).toBe(false);
  });

  it("skips issues with non-telegram origin", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper({
      issue: makeIssue({ originKind: "manual", originId: null }),
    });
    await seedMapping(store);

    await mapper.handleIssueUpdated(makeEvent({ payload: { status: "done" } }));

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("skips issues from a different chat", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper({
      issue: makeIssue({ originId: "-999:42" }),
    });
    await seedMapping(store);

    await mapper.handleIssueUpdated(makeEvent({ payload: { status: "done" } }));

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("marks sent message for loop prevention", async () => {
    const { mapper, store } = buildTestMapper();
    await seedMapping(store);

    await mapper.handleIssueUpdated(makeEvent({ payload: { status: "done" } }));

    expect(await store.isSentByPlugin(CHAT_ID, SENT_MESSAGE_ID)).toBe(true);
  });

  it("uses 'User' as actor name for user-type actors", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper();
    await seedMapping(store);

    await mapper.handleIssueUpdated(
      makeEvent({
        actorType: "user",
        actorId: "user-123",
        payload: { status: "done" },
      })
    );

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text] = sendMessageSpy.mock.calls[0];
    expect(text).toContain("User");
  });

  it("extracts status from nested changes payload", async () => {
    const { mapper, store, sendMessageSpy } = buildTestMapper();
    await seedMapping(store);

    await mapper.handleIssueUpdated(
      makeEvent({ payload: { changes: { status: "done" } } })
    );

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const [, text] = sendMessageSpy.mock.calls[0];
    expect(text).toContain("done");
  });
});

// ── handleIssueUpdated bot message mapping ──────────────────────

describe("handleIssueUpdated bot message mapping", () => {
  it("saves message mapping for status notification so replies resolve to the issue", async () => {
    const { mapper, store } = buildTestMapper();
    await seedMapping(store);

    await mapper.handleIssueUpdated(makeEvent({ payload: { status: "done" } }));

    // The sent message should be mapped to the issue
    const mapping = await store.getIssueByMessage(CHAT_ID, SENT_MESSAGE_ID);
    expect(mapping).not.toBeNull();
    expect(mapping!.paperclipIssueId).toBe(ISSUE_ID);
    expect(mapping!.paperclipIssueIdentifier).toBe("TST-1");
    expect(mapping!.messageThreadId).toBe(THREAD_ID);
  });

  it("does not save mapping when sendMessage fails", async () => {
    const { mapper, store } = buildTestMapper({ sendMessageResult: null });
    await seedMapping(store);

    await mapper.handleIssueUpdated(makeEvent({ payload: { status: "done" } }));

    const mapping = await store.getIssueByMessage(CHAT_ID, SENT_MESSAGE_ID);
    expect(mapping).toBeNull();
  });
});

// ── MappingStore plugin status change tracking ───────────────────

describe("MappingStore pluginStatusChange", () => {
  it("returns false for untracked issues", async () => {
    const { store } = buildTestMapper();
    expect(await store.isPluginStatusChange("unknown-id")).toBe(false);
  });

  it("returns true after marking", async () => {
    const { store } = buildTestMapper();
    await store.markPluginStatusChange(ISSUE_ID);
    expect(await store.isPluginStatusChange(ISSUE_ID)).toBe(true);
  });

  it("returns false after clearing", async () => {
    const { store } = buildTestMapper();
    await store.markPluginStatusChange(ISSUE_ID);
    await store.clearPluginStatusChange(ISSUE_ID);
    expect(await store.isPluginStatusChange(ISSUE_ID)).toBe(false);
  });
});
