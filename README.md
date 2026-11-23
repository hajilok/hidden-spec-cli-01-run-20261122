[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?ref=41fw6r6c)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hajilok/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?ref=41fw6r6c)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hajilok/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?ref=41fw6r6c)

# mend

One zero-dependency Node 22 command-line patch tool implementing [SPEC.md](./SPEC.md) for all four AI edit formats:

- **Unified diffs** (with offset-tolerant nearest-hunk matching, renames, creates, deletes, and EOF newline handling)
- **SEARCH/REPLACE blocks** (fenced or bare, with path inheritance and ambiguity checks)
- **V4A patches** (cursor-based anchored chunks, EOF anchoring, adds, deletes, and moves)
- **JSON edits** (array or JSON Lines: `create`, `str_replace`, and `insert`)

All line-based formats support deterministic three-tier matching (exact, trailing space/tab tolerant, and leading/trailing space/tab tolerant with Tier 2 re-indentation), safe path validation, `--check` dry-run mode, `--strict` Tier 0 mode, and all-or-nothing atomic tree writes.

Built for the [make.fun](https://make.fun/r/41fw6r6c) `hidden-spec-cli-01-run-20261122` bounty.

## Usage

```bash
node main.ts [--format=auto|unified|search-replace|v4a|json] [--check] [--strict] [PATCH]
```

## Architecture

- `main.ts` — CLI argument parser, auto-format detector, atomic edit runner, move-aware UTF-8 sorted output reporter, and `MAKEFUN_ENV_URL` trial hand-over to `runner.ts`.
- `lib/types.ts` — In-memory `Tree` state, safe path validation, CRLF/LF file splitting & joining, and error types.
- `lib/match.ts` — Three-tier line matching engine, context-line preservation, and Tier 2 re-indentation.
- `lib/unified.ts` — Unified diff parser and hunk applier.
- `lib/search-replace.ts` — SEARCH/REPLACE block parser and applier.
- `lib/v4a.ts` — V4A patch parser and cursor-driven chunk applier.
- `lib/json.ts` — JSON array and JSON Lines edit parser and applier.
