import { test, expect } from "@playwright/test";
import {
  createCompany,
  createAgent,
  createAgentKey,
  createIssue,
  agentHeaders,
} from "./helpers.js";

/**
 * E2E: Auth boundary tests — agent keys cannot access other companies,
 * board-only routes reject agent requests, and unauthenticated requests
 * are handled correctly.
 */
test.describe("Auth boundaries", () => {
  test("agent key from company A cannot access company B issues", async ({
    request,
  }) => {
    const companyA = await createCompany(request, `auth-a-${Date.now()}`);
    const companyB = await createCompany(request, `auth-b-${Date.now()}`);

    const agentA = await createAgent(request, companyA.id, {
      name: "Company A Agent",
    });
    const keyA = await createAgentKey(request, agentA.id);

    const issueB = await createIssue(request, companyB.id, {
      title: "Company B task",
      status: "backlog",
    });

    // Agent A tries to read company B's issue → 403
    const getRes = await request.get(`/api/issues/${issueB.id}`, {
      headers: agentHeaders(keyA.token),
    });
    expect(getRes.status()).toBe(403);

    // Agent A tries to list company B's issues → 403
    const listRes = await request.get(
      `/api/companies/${companyB.id}/issues`,
      { headers: agentHeaders(keyA.token) },
    );
    expect(listRes.status()).toBe(403);
  });

  test("agent key from company A cannot list company B agents", async ({
    request,
  }) => {
    const companyA = await createCompany(request, `agents-a-${Date.now()}`);
    const companyB = await createCompany(request, `agents-b-${Date.now()}`);

    const agentA = await createAgent(request, companyA.id, {
      name: "Cross-company Agent",
    });
    const keyA = await createAgentKey(request, agentA.id);

    const listRes = await request.get(
      `/api/companies/${companyB.id}/agents`,
      { headers: agentHeaders(keyA.token) },
    );
    expect(listRes.status()).toBe(403);
  });

  test("agent cannot create agents (board-only route)", async ({
    request,
  }) => {
    const company = await createCompany(request);
    const agent = await createAgent(request, company.id, { name: "Limited Agent" });
    const key = await createAgentKey(request, agent.id);

    const createRes = await request.post(
      `/api/companies/${company.id}/agents`,
      {
        headers: agentHeaders(key.token),
        data: { name: "Sneaky Agent", role: "engineer", adapterType: "process" },
      },
    );
    expect(createRes.status()).toBe(403);
  });

  test("agent cannot pause or terminate other agents (board-only)", async ({
    request,
  }) => {
    const company = await createCompany(request);
    const agentA = await createAgent(request, company.id, { name: "Agent Alpha" });
    const agentB = await createAgent(request, company.id, { name: "Agent Beta" });
    const keyA = await createAgentKey(request, agentA.id);

    // Agent A tries to pause Agent B → 403
    const pauseRes = await request.post(`/api/agents/${agentB.id}/pause`, {
      headers: agentHeaders(keyA.token),
    });
    expect(pauseRes.status()).toBe(403);

    // Agent A tries to terminate Agent B → 403
    const terminateRes = await request.post(
      `/api/agents/${agentB.id}/terminate`,
      { headers: agentHeaders(keyA.token) },
    );
    expect(terminateRes.status()).toBe(403);
  });

  test("agent cannot create API keys for other agents (board-only)", async ({
    request,
  }) => {
    const company = await createCompany(request);
    const agentA = await createAgent(request, company.id, { name: "Key Thief" });
    const agentB = await createAgent(request, company.id, { name: "Key Target" });
    const keyA = await createAgentKey(request, agentA.id);

    const keyRes = await request.post(`/api/agents/${agentB.id}/keys`, {
      headers: agentHeaders(keyA.token),
      data: { name: "stolen-key" },
    });
    expect(keyRes.status()).toBe(403);
  });

  test("agent can access /api/agents/me but not update other agents", async ({
    request,
  }) => {
    const company = await createCompany(request);
    const agent = await createAgent(request, company.id, { name: "Self Agent" });
    const otherAgent = await createAgent(request, company.id, {
      name: "Other Agent",
    });
    const key = await createAgentKey(request, agent.id);

    // Agent can access its own identity
    const meRes = await request.get("/api/agents/me", {
      headers: agentHeaders(key.token),
    });
    expect(meRes.ok()).toBe(true);
    const me = await meRes.json();
    expect(me.id).toBe(agent.id);

    // Agent cannot update another agent (board-only)
    const updateRes = await request.patch(`/api/agents/${otherAgent.id}`, {
      headers: agentHeaders(key.token),
      data: { name: "Hacked Name" },
    });
    expect(updateRes.status()).toBe(403);
  });

  test("agent checkout requires run ID header", async ({ request }) => {
    const company = await createCompany(request);
    const agent = await createAgent(request, company.id, { name: "No-Run Agent" });
    const key = await createAgentKey(request, agent.id);
    const issue = await createIssue(request, company.id, {
      title: "Run ID test",
      status: "backlog",
      assigneeAgentId: agent.id,
    });

    // Checkout without X-Paperclip-Run-Id header → 401
    const res = await request.post(`/api/issues/${issue.id}/checkout`, {
      headers: { Authorization: `Bearer ${key.token}` },
      data: { agentId: agent.id, expectedStatuses: ["backlog"] },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("run id");
  });
});
