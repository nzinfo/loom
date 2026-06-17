# loom

> Forward schema description language. Weaves design intent into physical schemas.

`loom` is a TypeScript-implemented schema engine that takes a **design schema**
(business identity, fields, value types, extension strategy) and projects it
into **physical schemas** (SQL DDL, atlas-yaml/v2). It is the forward-direction
complement to `atlas-yaml/v2`, which describes the physical fact of an existing
database.

## Status

Pre-alpha. Skeleton only — see `docs/specs/2026-06-17-loom-design.md` for the
validated design specification.

## Why loom?

- `atlas-yaml/v2` describes what a database **is** (physical fact, diff-stable)
- `loom-schema` describes what a database **should be** (design intent,
  business identity, extension strategy)
- One-way projection: design → physical. Reverse is lossy and needs LLM/human
  assistance (`loom lift`)

See spec §"命名说明" for the etymology (loom = weaving machine;
atlas = collection of maps).

## Repository layout

```
loom/
  packages/
    core/        schema engine (pure TS, environment-agnostic)
    cli/         CLI entry point (thin wrapper over core)
  docs/
    specs/       design specifications
```

## Quick start

```bash
pnpm install
pnpm build
pnpm test

# Run CLI directly
./packages/cli/bin/loom version
```

## Design decisions

See `docs/specs/2026-06-17-loom-design.md` §2 for the full decision table.
Highlights:

1. Two independent layers (loom design ↔ atlas physical), one-way projection
2. Sidecar EAV extension strategy — main tables never change shape for
   custom fields
3. `system / module / {value_type | table | entity}` file organization,
   `base_types.yaml` global type catalog
4. value types can map to multiple physical columns (Money = amount + currency)
5. YAML is the AST/IR — no second source of truth
6. `loom fmt` enforces diff-stable formatting

## License

TBD.
