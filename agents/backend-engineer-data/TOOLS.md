# Tools — Backend Engineer (Data & Integrations)

## Available Tools

- **Paperclip API** — task management, status updates, comments
- **Git** — version control, branching, commits
- **Shell** — run typecheck, tests, builds, database migrations
- **File read/write/edit** — implement features, fix bugs, write tests
- **pnpm** — package management, script execution

## Key Commands

```sh
pnpm -r typecheck       # Type check all packages
pnpm test:run           # Run all tests
pnpm build              # Build all packages
pnpm db:generate        # Generate DB migration after schema changes
pnpm dev                # Start dev server
```

## Key Directories

```
packages/db/src/schema/ # Drizzle schema definitions
packages/db/drizzle/    # Generated migrations
server/src/secrets/     # Secrets management
server/src/storage/     # Storage layer
packages/shared/        # Shared types, constants, validators
server/src/__tests__/   # Tests
```

## Tool Notes

(Add notes about tools as you acquire and use them.)
