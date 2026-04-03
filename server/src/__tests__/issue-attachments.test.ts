import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import type { StorageService } from "../storage/types.js";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  createAttachment: vi.fn(),
  listAttachments: vi.fn(),
  getAttachmentById: vi.fn(),
  deleteAttachment: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => ({ getById: vi.fn() }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

const now = new Date("2026-01-01T00:00:00.000Z");

function createStorageService(): StorageService {
  return {
    provider: "local_disk" as const,
    putFile: vi.fn(async (input) => ({
      provider: "local_disk" as const,
      objectKey: `company-1/issues/issue-1/${input.originalFilename ?? "upload"}`,
      contentType: input.contentType,
      byteSize: input.body.length,
      sha256: "sha256-sample",
      originalFilename: input.originalFilename,
    })),
    getObject: vi.fn(),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

function makeAttachment(overrides?: Record<string, unknown>) {
  return {
    id: "att-1",
    companyId: "company-1",
    issueId: "issue-1",
    issueCommentId: null,
    assetId: "asset-1",
    provider: "local_disk",
    objectKey: "company-1/issues/issue-1/photo.png",
    contentType: "image/png",
    byteSize: 100,
    sha256: "sha256-sample",
    originalFilename: "photo.png",
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeIssue() {
  return {
    id: "issue-1",
    companyId: "company-1",
    status: "in_progress",
    identifier: "CAR-1",
    title: "Test issue",
  };
}

type ActorType = "board" | "agent";

function createApp(storage: StorageService, actorType: ActorType = "board") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (actorType === "agent") {
      (req as any).actor = {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        keyId: undefined,
        runId: "run-1",
        source: "agent_jwt",
      };
    } else {
      (req as any).actor = {
        type: "board",
        userId: "user-1",
        companyIds: ["company-1"],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
    }
    next();
  });
  app.use("/api", issueRoutes({} as any, storage));
  app.use(errorHandler);
  return app;
}

// ─── Multipart upload with agent JWT ─────────────────────────────

describe("POST /api/companies/:companyId/issues/:issueId/attachments (agent JWT)", () => {
  let storage: StorageService;

  beforeEach(() => {
    storage = createStorageService();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.createAttachment.mockResolvedValue(makeAttachment({ createdByAgentId: "agent-1" }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts file upload from agent JWT caller", async () => {
    const app = createApp(storage, "agent");

    const res = await request(app)
      .post("/api/companies/company-1/issues/issue-1/attachments")
      .attach("file", Buffer.from("fake png data"), "photo.png");

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("att-1");
    expect(res.body.contentPath).toBe("/api/attachments/att-1/content");
  });

  it("passes createdByAgentId from agent actor to createAttachment", async () => {
    const app = createApp(storage, "agent");

    await request(app)
      .post("/api/companies/company-1/issues/issue-1/attachments")
      .attach("file", Buffer.from("fake png data"), "photo.png");

    expect(mockIssueService.createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        createdByAgentId: "agent-1",
        createdByUserId: null,
      }),
    );
  });

  it("passes createdByUserId for board actor", async () => {
    const app = createApp(storage, "board");

    await request(app)
      .post("/api/companies/company-1/issues/issue-1/attachments")
      .attach("file", Buffer.from("fake png data"), "photo.png");

    expect(mockIssueService.createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        createdByAgentId: null,
        createdByUserId: "user-1",
      }),
    );
  });

  it("rejects when issue does not exist", async () => {
    mockIssueService.getById.mockResolvedValue(null);
    const app = createApp(storage, "agent");

    const res = await request(app)
      .post("/api/companies/company-1/issues/issue-1/attachments")
      .attach("file", Buffer.from("data"), "file.png");

    expect(res.status).toBe(404);
  });

  it("rejects when issue belongs to different company", async () => {
    mockIssueService.getById.mockResolvedValue({ ...makeIssue(), companyId: "other-company" });
    const app = createApp(storage, "agent");

    const res = await request(app)
      .post("/api/companies/company-1/issues/issue-1/attachments")
      .attach("file", Buffer.from("data"), "file.png");

    expect(res.status).toBe(422);
  });
});

// ─── URL-based upload ────────────────────────────────────────────

describe("POST /api/companies/:companyId/issues/:issueId/attachments/from-url", () => {
  let storage: StorageService;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    storage = createStorageService();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.createAttachment.mockResolvedValue(makeAttachment());

    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("downloads a file from URL and creates an attachment", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-type": "image/png",
        "content-length": "100",
      }),
      arrayBuffer: async () => new ArrayBuffer(100),
    });

    const app = createApp(storage, "agent");

    const res = await request(app)
      .post("/api/companies/company-1/issues/issue-1/attachments/from-url")
      .send({ fileUrl: "https://example.com/photo.png" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("att-1");
    expect(res.body.contentPath).toBe("/api/attachments/att-1/content");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://example.com/photo.png",
      expect.objectContaining({ redirect: "follow" }),
    );
    expect(storage.putFile).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        namespace: "issues/issue-1",
        contentType: "image/png",
      }),
    );
  });

  it("uses originalFilename from request body when provided", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/jpeg" }),
      arrayBuffer: async () => new ArrayBuffer(50),
    });

    const app = createApp(storage, "agent");

    const res = await request(app)
      .post("/api/companies/company-1/issues/issue-1/attachments/from-url")
      .send({ fileUrl: "https://example.com/download/abc123", originalFilename: "vacation.jpg" });

    expect(res.status).toBe(201);
    expect(storage.putFile).toHaveBeenCalledWith(
      expect.objectContaining({ originalFilename: "vacation.jpg" }),
    );
  });

  it("derives filename from URL path when originalFilename not provided", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/pdf" }),
      arrayBuffer: async () => new ArrayBuffer(50),
    });

    const app = createApp(storage, "agent");

    await request(app)
      .post("/api/companies/company-1/issues/issue-1/attachments/from-url")
      .send({ fileUrl: "https://example.com/files/report.pdf" });

    expect(storage.putFile).toHaveBeenCalledWith(
      expect.objectContaining({ originalFilename: "report.pdf" }),
    );
  });

  it("sets createdByAgentId for agent callers", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => new ArrayBuffer(50),
    });

    const app = createApp(storage, "agent");

    await request(app)
      .post("/api/companies/company-1/issues/issue-1/attachments/from-url")
      .send({ fileUrl: "https://example.com/photo.png" });

    expect(mockIssueService.createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        createdByAgentId: "agent-1",
        createdByUserId: null,
      }),
    );
  });

  it("rejects invalid fileUrl", async () => {
    const app = createApp(storage, "agent");

    const res = await request(app)
      .post("/api/companies/company-1/issues/issue-1/attachments/from-url")
      .send({ fileUrl: "not-a-url" });

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects non-http/https protocols", async () => {
    const app = createApp(storage, "agent");

    const res = await request(app)
      .post("/api/companies/company-1/issues/issue-1/attachments/from-url")
      .send({ fileUrl: "ftp://example.com/file.png" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/http or https/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects when file exceeds size limit (Content-Length header)", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-type": "image/png",
        "content-length": String(MAX_ATTACHMENT_BYTES + 1),
      }),
      arrayBuffer: async () => new ArrayBuffer(MAX_ATTACHMENT_BYTES + 1),
    });

    const app = createApp(storage, "agent");

    const res = await request(app)
      .post("/api/companies/company-1/issues/issue-1/attachments/from-url")
      .send({ fileUrl: "https://example.com/huge.png" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/exceeds/);
    expect(storage.putFile).not.toHaveBeenCalled();
  });

  it("rejects empty downloaded files", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    const app = createApp(storage, "agent");

    const res = await request(app)
      .post("/api/companies/company-1/issues/issue-1/attachments/from-url")
      .send({ fileUrl: "https://example.com/empty.png" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/empty/);
  });

  it("rejects unsupported content types", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/zip" }),
      arrayBuffer: async () => new ArrayBuffer(50),
    });

    const app = createApp(storage, "agent");

    const res = await request(app)
      .post("/api/companies/company-1/issues/issue-1/attachments/from-url")
      .send({ fileUrl: "https://example.com/archive.zip" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Unsupported/);
  });

  it("handles failed download (non-ok status)", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
    });

    const app = createApp(storage, "agent");

    const res = await request(app)
      .post("/api/companies/company-1/issues/issue-1/attachments/from-url")
      .send({ fileUrl: "https://example.com/missing.png" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/404/);
  });

  it("handles fetch network error", async () => {
    fetchSpy.mockRejectedValue(new Error("Network error"));

    const app = createApp(storage, "agent");

    const res = await request(app)
      .post("/api/companies/company-1/issues/issue-1/attachments/from-url")
      .send({ fileUrl: "https://example.com/photo.png" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Failed to download/);
  });

  it("rejects when issue does not exist", async () => {
    mockIssueService.getById.mockResolvedValue(null);
    const app = createApp(storage, "agent");

    const res = await request(app)
      .post("/api/companies/company-1/issues/issue-1/attachments/from-url")
      .send({ fileUrl: "https://example.com/photo.png" });

    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects missing fileUrl field", async () => {
    const app = createApp(storage, "agent");

    const res = await request(app)
      .post("/api/companies/company-1/issues/issue-1/attachments/from-url")
      .send({});

    expect(res.status).toBe(400);
  });

  it("logs activity with source: url", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => new ArrayBuffer(50),
    });

    const app = createApp(storage, "agent");

    await request(app)
      .post("/api/companies/company-1/issues/issue-1/attachments/from-url")
      .send({ fileUrl: "https://example.com/photo.png" });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.attachment_added",
        details: expect.objectContaining({ source: "url" }),
      }),
    );
  });
});
