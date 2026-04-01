# Tools — Backend Engineer (Runtime & Adapters)

## Available Tools

- **Paperclip API** — task management, status updates, comments
- **Git** — version control, branching, commits
- **Shell** — run typecheck, tests, builds
- **File read/write/edit** — implement features, fix bugs, write tests
- **pnpm** — package management, script execution

## Key Commands

```sh
pnpm -r typecheck       # Type check all packages
pnpm test:run           # Run all tests
pnpm build              # Build all packages
pnpm dev                # Start dev server
```

## Key Directories

```
packages/adapters/      # Agent adapters (Claude, Codex, Cursor, Gemini, etc.)
packages/plugins/       # Plugin SDK, runtime, worker execution
cli/                    # Paperclip CLI
server/src/services/    # Runtime services (heartbeat, run management)
packages/shared/        # Shared types, constants, validators
server/src/__tests__/   # Tests
```

## Tool Notes

(Add notes about tools as you acquire and use them.)
