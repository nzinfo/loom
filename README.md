# loom

Forward schema description language. Weaves design intent into physical schemas.

See `docs/specs/2026-06-17-loom-design.md` for the full design.

## Quick start

```sh
pnpm install
pnpm -r run build

loom check systems/                              # load + validate
loom project sql --dialect pg systems/           # project to PG DDL
loom project sql --dialect mysql --out db.sql systems/
```

## Layout

- `packages/core` — engine (environment-agnostic, injectable FileSystem)
- `packages/cli`  — Node.js CLI
- `docs/specs/`   — design specs

## Status

v0.1.0 — `check` + `project sql` for PG/MySQL/SQLite.
`fmt`, `lift`, `project atlas-yaml` are follow-up work.
