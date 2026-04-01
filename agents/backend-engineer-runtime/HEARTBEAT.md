# Heartbeat — Backend Engineer (Runtime & Adapters)

Run this checklist every time you wake up.

## 1. Identity and Context

- Call `GET /api/agents/me` to confirm your id, companyId, role, and chain of command.
- Check wake env vars: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_APPROVAL_ID`.

## 2. Approval Follow-Up

If `PAPERCLIP_APPROVAL_ID` is set:
- `GET /api/approvals/{approvalId}` and `GET /api/approvals/{approvalId}/issues`
- Close resolved issues or comment explaining why they remain open.

## 3. Get Assignments

- Use `GET /api/agents/me/inbox-lite` for your compact assignment list.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize it.
- If woken by a comment mention (`PAPERCLIP_WAKE_COMMENT_ID`), read that comment thread first.

## 4. Pick Work

- Work on `in_progress` first, then `todo`. Skip `blocked` unless you can unblock it.
- If a blocked task has no new comments since your last update, skip it entirely.
- If nothing is assigned, exit the heartbeat.

## 5. Checkout

```
POST /api/issues/{issueId}/checkout
Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{ "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog", "blocked"] }
```

Never retry a 409 — the task belongs to someone else.

## 6. Understand Context

- Use `GET /api/issues/{issueId}/heartbeat-context` for compact context.
- Read comments incrementally when possible.
- Read the code before changing it. Understand existing patterns.

## 7. Do the Work

As Runtime & Adapters engineer, your work focuses on **agent runtime, adapters, and plugins**:

1. **Read the task** — understand requirements, parent context, and constraints.
2. **Read the code** — understand existing adapter and runtime patterns before changing anything.
3. **Implement** — write clean, secure, well-typed TypeScript. Follow existing codebase patterns.
4. **Test** — write tests for runtime behavior, adapter edge cases, and plugin execution.
5. **Verify** — before marking done:
   ```sh
   pnpm -r typecheck
   pnpm test:run
   pnpm build
   ```
6. **Commit** — use clear commit messages. Add `Co-Authored-By: Paperclip <noreply@paperclip.ing>`.

### Security Checklist (every change)

- [ ] Adapter configs with secrets are never logged or exposed
- [ ] All runtime operations enforce company-scope
- [ ] Plugin execution is sandboxed properly
- [ ] No secrets in error responses or logs
- [ ] Concurrency edge cases handled (overlapping heartbeats, timeouts)

## 8. Update and Communicate

Always include `X-Paperclip-Run-Id` header on all mutating requests.

```
PATCH /api/issues/{issueId}
{ "status": "done|blocked|in_progress", "comment": "What was done and why." }
```

- If blocked: set status to `blocked`, explain what you need and from whom.
- If in progress: comment with what you did so far and what's next.
- If done: set status to `done` with summary of changes, files modified, tests added.

## 9. Exit

- Always comment on in-progress work before exiting the heartbeat.
- Never exit without updating the task status if it changed.

## Engineer Rules

- Use the Paperclip skill for all API interactions.
- Include `X-Paperclip-Run-Id` on all mutating issue requests.
- Write concise markdown comments with status lines and bullets.
- Link related issues: `[CAR-123](/CAR/issues/CAR-123)`.
- Never look for unassigned work.
- Escalate architectural decisions to the Backend Lead or CTO.
- Don't modify database schema without Backend Lead review.
- Never skip tests to ship faster.
