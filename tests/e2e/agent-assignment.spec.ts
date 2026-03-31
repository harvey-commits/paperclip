import { test, expect } from "@playwright/test";
import {
  createCompany,
  createAgent,
  createIssue,
} from "./helpers.js";

/**
 * E2E: Agent assignment — reassignment between agents,
 * paused agent blocks checkout, and terminated agent blocks assignment.
 *
 * Issues use "backlog" status to avoid triggering automatic heartbeat wakeups.
 */
test.describe("Agent assignment", () => {
  test("reassign task from agent A to agent B, then B checks out", async ({
    request,
  }) => {
    const company = await createCompany(request);
    const agentA = await createAgent(request, company.id, { name: "Agent A" });
    const agentB = await createAgent(request, company.id, { name: "Agent B" });
    const issue = await createIssue(request, company.id, {
      title: "Reassignment task",
      status: "backlog",
      assigneeAgentId: agentA.id,
    });

    expect(issue.assigneeAgentId).toBe(agentA.id);

    // Reassign to Agent B (board-level) — stays backlog to avoid wakeup
    const reassignRes = await request.patch(`/api/issues/${issue.id}`, {
      data: { assigneeAgentId: agentB.id },
    });
    expect(reassignRes.ok()).toBe(true);
    const reassigned = await reassignRes.json();
    expect(reassigned.assigneeAgentId).toBe(agentB.id);

    // Agent B can now checkout
    const checkoutRes = await request.post(
      `/api/issues/${issue.id}/checkout`,
      {
        data: { agentId: agentB.id, expectedStatuses: ["backlog"] },
      },
    );
    expect(checkoutRes.ok()).toBe(true);
    const checkedOut = await checkoutRes.json();
    expect(checkedOut.assigneeAgentId).toBe(agentB.id);
    expect(checkedOut.status).toBe("in_progress");
  });

  test("paused agent can still be checked out at board level", async ({ request }) => {
    const company = await createCompany(request);
    const agent = await createAgent(request, company.id, { name: "Pausable Agent" });
    const issue = await createIssue(request, company.id, {
      title: "Paused checkout task",
      status: "backlog",
      assigneeAgentId: agent.id,
    });

    // Pause the agent (board-level)
    const pauseRes = await request.post(`/api/agents/${agent.id}/pause`);
    expect(pauseRes.ok()).toBe(true);

    // Verify agent is paused
    const agentRes = await request.get(`/api/agents/${agent.id}`);
    const agentData = await agentRes.json();
    expect(agentData.status).toBe("paused");

    // Board-level checkout for paused agent still succeeds
    // (assertAssignableAgent only blocks pending_approval and terminated)
    const checkoutRes = await request.post(
      `/api/issues/${issue.id}/checkout`,
      {
        data: { agentId: agent.id, expectedStatuses: ["backlog"] },
      },
    );
    expect(checkoutRes.ok()).toBe(true);
    const checkedOut = await checkoutRes.json();
    expect(checkedOut.status).toBe("in_progress");
    expect(checkedOut.assigneeAgentId).toBe(agent.id);
  });

  test("terminated agent cannot be assigned tasks", async ({ request }) => {
    const company = await createCompany(request);
    const agent = await createAgent(request, company.id, { name: "Terminated Agent" });

    // Terminate the agent
    const terminateRes = await request.post(
      `/api/agents/${agent.id}/terminate`,
    );
    expect(terminateRes.ok()).toBe(true);

    // Try to create a task assigned to terminated agent → should fail
    const issueRes = await request.post(
      `/api/companies/${company.id}/issues`,
      {
        data: {
          title: "Task for terminated agent",
          status: "backlog",
          assigneeAgentId: agent.id,
        },
      },
    );
    expect(issueRes.status()).toBe(409);
  });

  test("release task clears checkout and sets status to todo", async ({
    request,
  }) => {
    const company = await createCompany(request);
    const agent = await createAgent(request, company.id, { name: "Release Agent" });
    const issue = await createIssue(request, company.id, {
      title: "Release test task",
      status: "backlog",
      assigneeAgentId: agent.id,
    });

    // Checkout the issue (board-level)
    const checkoutRes = await request.post(
      `/api/issues/${issue.id}/checkout`,
      {
        data: { agentId: agent.id, expectedStatuses: ["backlog"] },
      },
    );
    expect(checkoutRes.ok()).toBe(true);
    const checkedOut = await checkoutRes.json();
    expect(checkedOut.status).toBe("in_progress");

    // Release the task (board-level, no actor)
    const releaseRes = await request.post(
      `/api/issues/${issue.id}/release`,
    );
    expect(releaseRes.ok()).toBe(true);
    const released = await releaseRes.json();
    expect(released.status).toBe("todo");
    expect(released.assigneeAgentId).toBeNull();

    // Verify via GET
    const getRes = await request.get(`/api/issues/${issue.id}`);
    const fetched = await getRes.json();
    expect(fetched.status).toBe("todo");
    expect(fetched.assigneeAgentId).toBeNull();
  });
});
