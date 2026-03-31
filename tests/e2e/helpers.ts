import type { APIRequestContext } from "@playwright/test";
import { randomUUID } from "crypto";

/**
 * Shared helpers for Paperclip E2E API tests.
 *
 * All tests run against a local_trusted server, so unauthenticated requests
 * are treated as board-level. Agent-level requests use API keys created
 * via the board endpoints.
 */

export interface TestCompany {
  id: string;
  name: string;
  prefix: string;
}

export interface TestAgent {
  id: string;
  name: string;
  companyId: string;
  role: string;
  status: string;
}

export interface TestAgentKey {
  id: string;
  token: string;
}

export interface TestIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  companyId: string;
  assigneeAgentId: string | null;
}

/** Create a test company via POST /api/companies (board-level in local_trusted mode). */
export async function createCompany(
  request: APIRequestContext,
  name?: string,
): Promise<TestCompany> {
  const companyName = name ?? `e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const res = await request.post("/api/companies", {
    data: { name: companyName },
  });
  if (!res.ok()) {
    throw new Error(`Failed to create company: ${res.status()} ${await res.text()}`);
  }
  const body = await res.json();
  return { id: body.id, name: body.name, prefix: body.prefix };
}

/** Create an agent in a company. */
export async function createAgent(
  request: APIRequestContext,
  companyId: string,
  opts: { name: string; role?: string; adapterType?: string },
): Promise<TestAgent> {
  const res = await request.post(`/api/companies/${companyId}/agents`, {
    data: {
      name: opts.name,
      role: opts.role ?? "engineer",
      adapterType: opts.adapterType ?? "process",
    },
  });
  const body = await res.json();
  return {
    id: body.id,
    name: body.name,
    companyId: body.companyId,
    role: body.role,
    status: body.status,
  };
}

/** Create an API key for an agent (board-level operation). */
export async function createAgentKey(
  request: APIRequestContext,
  agentId: string,
): Promise<TestAgentKey> {
  const res = await request.post(`/api/agents/${agentId}/keys`, {
    data: { name: "e2e-test-key" },
  });
  const body = await res.json();
  return { id: body.id, token: body.token };
}

/** Create an issue in a company. */
export async function createIssue(
  request: APIRequestContext,
  companyId: string,
  opts: {
    title: string;
    status?: string;
    assigneeAgentId?: string;
    description?: string;
  },
): Promise<TestIssue> {
  const res = await request.post(`/api/companies/${companyId}/issues`, {
    data: {
      title: opts.title,
      status: opts.status ?? "backlog",
      assigneeAgentId: opts.assigneeAgentId ?? null,
      description: opts.description ?? null,
    },
  });
  const body = await res.json();
  return {
    id: body.id,
    identifier: body.identifier,
    title: body.title,
    status: body.status,
    companyId: body.companyId,
    assigneeAgentId: body.assigneeAgentId,
  };
}

/** Build headers for agent-authenticated requests. */
export function agentHeaders(
  token: string,
  runId?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (runId) {
    headers["X-Paperclip-Run-Id"] = runId;
  }
  return headers;
}
