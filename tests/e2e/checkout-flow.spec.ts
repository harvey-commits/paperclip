import { test, expect } from "@playwright/test";
import {
  createCompany,
  createAgent,
  createAgentKey,
  createIssue,
  agentHeaders,
} from "./helpers.js";

/**
 * E2E: Checkout flow — atomic checkout, 409 on double-checkout,
 * and status transitions (backlog -> in_progress -> done).
 *
 * Issues are created in "backlog" status to avoid triggering automatic
 * heartbeat wakeups that would race with our explicit checkout calls.
 * Board-level checkout is used (null runId) unless testing agent auth.
 */
test.describe("Checkout flow", () => {
  test("checkout transitions task to in_progress, then done", async ({
    request,
  }) => {
    const company = await createCompany(request);
    const agent = await createAgent(request, company.id, { name: "Checkout Agent" });
    const issue = await createIssue(request, company.id, {
      title: "Checkout test task",
      status: "backlog",
      assigneeAgentId: agent.id,
    });

    expect(issue.status).toBe("backlog");

    const checkoutRes = await request.post(`/api/issues/${issue.id}/checkout`, {
      data: { agentId: agent.id, expectedStatuses: ["backlog"] },
    });
    expect(checkoutRes.ok()).toBe(true);
    const checkedOut = await checkoutRes.json();
    expect(checkedOut.status).toBe("in_progress");
    expect(checkedOut.assigneeAgentId).toBe(agent.id);

    // Verify status via GET
    const getRes = await request.get(`/api/issues/${issue.id}`);
    const fetched = await getRes.json();
    expect(fetched.status).toBe("in_progress");

    // Transition to done
    const doneRes = await request.patch(`/api/issues/${issue.id}`, {
      data: { status: "done" },
    });
    expect(doneRes.ok()).toBe(true);
    const doneIssue = await doneRes.json();
    expect(doneIssue.status).toBe("done");
  });

  test("double-checkout by a different agent returns 409", async ({
    request,
  }) => {
    const company = await createCompany(request);
    const agentA = await createAgent(request, company.id, { name: "Agent A" });
    const agentB = await createAgent(request, company.id, { name: "Agent B" });
    const issue = await createIssue(request, company.id, {
      title: "Double checkout task",
      status: "backlog",
      assigneeAgentId: agentA.id,
    });

    // Agent A checks out
    const resA = await request.post(`/api/issues/${issue.id}/checkout`, {
      data: { agentId: agentA.id, expectedStatuses: ["backlog"] },
    });
    expect(resA.ok()).toBe(true);

    // Agent B tries to check out the same in_progress issue → 409
    const resB = await request.post(`/api/issues/${issue.id}/checkout`, {
      data: { agentId: agentB.id, expectedStatuses: ["backlog", "in_progress"] },
    });
    expect(resB.status()).toBe(409);
    const body = await resB.json();
    expect(body.error).toContain("conflict");
  });

  test("checkout with wrong expectedStatuses fails with 409", async ({
    request,
  }) => {
    const company = await createCompany(request);
    const agent = await createAgent(request, company.id, { name: "Status Agent" });
    const issue = await createIssue(request, company.id, {
      title: "Status mismatch task",
      status: "backlog",
      assigneeAgentId: agent.id,
    });

    // Checkout expecting in_progress, but issue is backlog → 409
    const res = await request.post(`/api/issues/${issue.id}/checkout`, {
      data: { agentId: agent.id, expectedStatuses: ["in_progress"] },
    });
    expect(res.status()).toBe(409);
  });

  test("agent cannot checkout as a different agent (403)", async ({
    request,
  }) => {
    const company = await createCompany(request);
    const agentA = await createAgent(request, company.id, { name: "Real Agent" });
    const agentB = await createAgent(request, company.id, { name: "Other Agent" });
    const keyA = await createAgentKey(request, agentA.id);
    const issue = await createIssue(request, company.id, {
      title: "Impersonation task",
      status: "backlog",
      assigneeAgentId: agentB.id,
    });

    // Agent A (authed) tries to checkout as Agent B → 403
    const res = await request.post(`/api/issues/${issue.id}/checkout`, {
      headers: agentHeaders(keyA.token, "fake-run-id"),
      data: { agentId: agentB.id, expectedStatuses: ["backlog"] },
    });
    expect(res.status()).toBe(403);
  });

  test("idempotent checkout — same agent re-checkout returns 200", async ({
    request,
  }) => {
    const company = await createCompany(request);
    const agent = await createAgent(request, company.id, { name: "Idempotent Agent" });
    const issue = await createIssue(request, company.id, {
      title: "Idempotent checkout task",
      status: "backlog",
      assigneeAgentId: agent.id,
    });

    // First checkout
    const res1 = await request.post(`/api/issues/${issue.id}/checkout`, {
      data: { agentId: agent.id, expectedStatuses: ["backlog"] },
    });
    expect(res1.ok()).toBe(true);

    // Same agent, re-checkout the now in_progress issue — should be idempotent
    const res2 = await request.post(`/api/issues/${issue.id}/checkout`, {
      data: { agentId: agent.id, expectedStatuses: ["in_progress"] },
    });
    expect(res2.ok()).toBe(true);
    const body = await res2.json();
    expect(body.status).toBe("in_progress");
  });
});
