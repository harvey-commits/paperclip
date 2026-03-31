import { test, expect } from "@playwright/test";
import {
  createCompany,
  createAgent,
  createAgentKey,
  createIssue,
  agentHeaders,
} from "./helpers.js";

/**
 * E2E: Approval flow — create approval, resolve (approve/reject),
 * and verify issue linkage and agent auth boundaries on resolve routes.
 */
test.describe("Approval flow", () => {
  test("create approval, approve it, and verify status", async ({
    request,
  }) => {
    const company = await createCompany(request);
    const agent = await createAgent(request, company.id, {
      name: "Approval Agent",
      role: "ceo",
    });
    const issue = await createIssue(request, company.id, {
      title: "Approval test task",
      status: "backlog",
      assigneeAgentId: agent.id,
    });

    // Create an approval linked to the issue (board-level)
    const createRes = await request.post(
      `/api/companies/${company.id}/approvals`,
      {
        data: {
          type: "hire_agent",
          requestedByAgentId: agent.id,
          payload: { reason: "E2E test approval" },
          issueIds: [issue.id],
        },
      },
    );
    expect(createRes.status()).toBe(201);
    const approval = await createRes.json();
    expect(approval.id).toBeTruthy();
    expect(approval.status).toBe("pending");
    expect(approval.type).toBe("hire_agent");

    // Verify approval is linked to the issue
    const linkedRes = await request.get(
      `/api/issues/${issue.id}/approvals`,
    );
    expect(linkedRes.ok()).toBe(true);
    const linkedApprovals = await linkedRes.json();
    expect(linkedApprovals.some((a: { id: string }) => a.id === approval.id)).toBe(true);

    // Verify linked issues from approval side
    const approvalIssuesRes = await request.get(
      `/api/approvals/${approval.id}/issues`,
    );
    expect(approvalIssuesRes.ok()).toBe(true);
    const approvalIssues = await approvalIssuesRes.json();
    expect(approvalIssues.some((i: { id: string }) => i.id === issue.id)).toBe(true);

    // Approve the approval (board-only action)
    const approveRes = await request.post(
      `/api/approvals/${approval.id}/approve`,
      {
        data: { decisionNote: "Approved in E2E test" },
      },
    );
    expect(approveRes.ok()).toBe(true);
    const approved = await approveRes.json();
    expect(approved.status).toBe("approved");
    expect(approved.decisionNote).toBe("Approved in E2E test");
  });

  test("reject an approval updates status to rejected", async ({
    request,
  }) => {
    const company = await createCompany(request);
    const agent = await createAgent(request, company.id, {
      name: "Reject Agent",
      role: "ceo",
    });

    const createRes = await request.post(
      `/api/companies/${company.id}/approvals`,
      {
        data: {
          type: "approve_ceo_strategy",
          requestedByAgentId: agent.id,
          payload: { strategy: "Test strategy" },
        },
      },
    );
    expect(createRes.status()).toBe(201);
    const approval = await createRes.json();

    // Reject
    const rejectRes = await request.post(
      `/api/approvals/${approval.id}/reject`,
      {
        data: { decisionNote: "Rejected in E2E test" },
      },
    );
    expect(rejectRes.ok()).toBe(true);
    const rejected = await rejectRes.json();
    expect(rejected.status).toBe("rejected");
  });

  test("agent cannot approve an approval (board-only, returns 403)", async ({
    request,
  }) => {
    const company = await createCompany(request);
    const agent = await createAgent(request, company.id, {
      name: "Unauthorized Agent",
      role: "ceo",
    });
    const key = await createAgentKey(request, agent.id);

    const createRes = await request.post(
      `/api/companies/${company.id}/approvals`,
      {
        data: {
          type: "hire_agent",
          requestedByAgentId: agent.id,
          payload: { reason: "agent auth test" },
        },
      },
    );
    const approval = await createRes.json();

    // Agent tries to approve → 403
    const approveRes = await request.post(
      `/api/approvals/${approval.id}/approve`,
      {
        headers: agentHeaders(key.token),
        data: { decisionNote: "Attempted by agent" },
      },
    );
    expect(approveRes.status()).toBe(403);
  });
});
