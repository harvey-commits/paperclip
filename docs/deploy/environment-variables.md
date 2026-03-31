---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that Paperclip uses for server configuration.

## Required for Production

These variables **must** be set explicitly in any authenticated/production deployment. No safe default exists.

| Variable | Description |
|----------|-------------|
| `BETTER_AUTH_SECRET` | Random secret for session signing (min 32 chars). Generate with `openssl rand -base64 32`. |
| `DATABASE_URL` | PostgreSQL connection string (required when `database.mode = "postgres"`). |
| `PAPERCLIP_PUBLIC_URL` | Publicly accessible URL of the server (e.g. `https://paperclip.example.com`). Used for auth callbacks and links. |

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `HOST` | `127.0.0.1` | Server host binding. Set to `0.0.0.0` inside Docker. |
| `PAPERCLIP_HOME` | `~/.paperclip` | Base directory for all Paperclip data |
| `PAPERCLIP_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode: `local_trusted`, `authenticated`. |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | Exposure level: `private`, `public`. |
| `PAPERCLIP_ALLOWED_HOSTNAMES` | (derived from `PAPERCLIP_PUBLIC_URL`) | Comma-separated list of additional allowed hostnames for Host header validation. |
| `SERVE_UI` | `true` | Serve the embedded UI from the server process. |
| `PAPERCLIP_CONFIG` | `$PAPERCLIP_HOME/instances/$PAPERCLIP_INSTANCE_ID/config.json` | Path to the JSON config file. |

## Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `BETTER_AUTH_SECRET` | *(none — required)* | Session signing secret. |
| `PAPERCLIP_AUTH_BASE_URL_MODE` | `auto` (or `explicit` when `PAPERCLIP_PUBLIC_URL` is set) | How the auth base URL is derived: `auto`, `explicit`. |
| `PAPERCLIP_AUTH_PUBLIC_BASE_URL` | (falls back to `PAPERCLIP_PUBLIC_URL`) | Explicit public base URL for auth callbacks. |
| `PAPERCLIP_AUTH_DISABLE_SIGN_UP` | `false` | Disable new user sign-ups. |

## Database

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | (embedded postgres) | PostgreSQL connection string. Required when using external Postgres. |
| `PAPERCLIP_DB_BACKUP_ENABLED` | `true` | Enable periodic database backups (embedded Postgres only). |
| `PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES` | `60` | Backup interval in minutes. |
| `PAPERCLIP_DB_BACKUP_RETENTION_DAYS` | `30` | Number of days to keep backups. |
| `PAPERCLIP_DB_BACKUP_DIR` | `$PAPERCLIP_HOME/.../backup` | Directory for database backups. |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_SECRETS_PROVIDER` | `local_encrypted` | Secrets backend: `local_encrypted`, `env`. |
| `PAPERCLIP_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw). Takes precedence over key file. |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `$PAPERCLIP_HOME/.../secrets/master.key` | Path to the master key file. |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars. |

## Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_STORAGE_PROVIDER` | `local_disk` | Storage backend: `local_disk`, `s3`. |
| `PAPERCLIP_STORAGE_LOCAL_DIR` | `$PAPERCLIP_HOME/.../storage` | Local disk storage base directory. |
| `PAPERCLIP_STORAGE_S3_BUCKET` | `paperclip` | S3 bucket name. |
| `PAPERCLIP_STORAGE_S3_REGION` | `us-east-1` | S3 region. |
| `PAPERCLIP_STORAGE_S3_ENDPOINT` | (none) | Custom S3 endpoint URL (for S3-compatible stores). |
| `PAPERCLIP_STORAGE_S3_PREFIX` | `` | Key prefix inside the S3 bucket. |
| `PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE` | `false` | Force path-style S3 URLs (required by some S3-compatible stores). |

## Heartbeat Scheduler

| Variable | Default | Description |
|----------|---------|-------------|
| `HEARTBEAT_SCHEDULER_ENABLED` | `true` | Enable the agent heartbeat scheduler. |
| `HEARTBEAT_SCHEDULER_INTERVAL_MS` | `30000` | How often the scheduler polls for due heartbeats (minimum 10000). |

## Miscellaneous

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_ENABLE_COMPANY_DELETION` | `true` in `local_trusted`, `false` otherwise | Allow companies to be deleted. |
| `PAPERCLIP_UI_DEV_MIDDLEWARE` | `false` | Mount Vite dev middleware (development only). |

## Agent Runtime (Injected into agent processes)

These are set automatically by the server when invoking agents. Do not set them manually.

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` | Agent's unique ID |
| `PAPERCLIP_COMPANY_ID` | Company ID |
| `PAPERCLIP_API_URL` | Paperclip API base URL |
| `PAPERCLIP_API_KEY` | Short-lived JWT for API auth |
| `PAPERCLIP_RUN_ID` | Current heartbeat run ID |
| `PAPERCLIP_TASK_ID` | Issue that triggered this wake |
| `PAPERCLIP_WAKE_REASON` | Wake trigger reason |
| `PAPERCLIP_WAKE_COMMENT_ID` | Comment that triggered this wake |
| `PAPERCLIP_APPROVAL_ID` | Resolved approval ID |
| `PAPERCLIP_APPROVAL_STATUS` | Approval decision |
| `PAPERCLIP_LINKED_ISSUE_IDS` | Comma-separated linked issue IDs |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Local adapter) |
| `OPENAI_API_KEY` | OpenAI API key (for Codex Local adapter) |

## Security Notes

- `BETTER_AUTH_SECRET` uses the `${VAR:?error}` Docker Compose syntax — the container will refuse to start if it is unset or empty.
- The `docker-compose.yml` development file binds Postgres to `127.0.0.1:5432` to prevent external exposure. Do not change this to `0.0.0.0` in production.
- No sensitive values are hard-coded as defaults in `config.ts`. Secrets default to file-based storage; `BETTER_AUTH_SECRET` has no default and must always be explicitly provided.
