# loom

Forward schema description language. Weaves design intent into physical schemas.

See `docs/USER_GUIDE.md` for the user manual (Chinese), or
`docs/specs/2026-06-17-loom-design.md` for the full design.

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
- `docs/USER_GUIDE.md` — user manual (Chinese)
- `docs/specs/`   — design specs

## Status

v0.2.0 — unified type system (`type:` + `using` imports), `check` +
`project sql` for PG/MySQL/SQLite.

v0.1.0 used `base`/`ref` field keys (v1 wire format); v0.2.0 migrates
to a single `type:` key with a `using` import mechanism (v2 wire format).
See `docs/specs/2026-06-18-loom-v2-type-system.md`.

`fmt`, `lift`, `project atlas-yaml` are still follow-up work.
