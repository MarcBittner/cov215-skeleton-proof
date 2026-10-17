# COV-215 shared contract (Wave 0, frozen)

Owner: the Wave-0 contract lane. After the freeze, a change to any file listed here goes through that lane:
edit the `.schema.json`, run `node scripts/e2e/contract/gen-schemas.mjs`, update `types.ts` (or `e2e/map/manifest.ts`) and the
validators, add a valid and an invalid fixture. `schemas-sync.test.ts` fails if the generated module drifts from the JSON.

Every document carries a `major.minor` version (`schema_version` in Section A formats, `schemaVersion` in B/C formats, as the
plan writes them). Readers refuse an unknown major before anything else. All objects are closed (`additionalProperties: false`),
so a renamed or extra field is rejected.

## Formats

| Format | Schema | Artifact / location | Written by | Read by | Validator |
|---|---|---|---|---|---|
| App map manifest (BK, R15) | `e2e/map/manifest.schema.json` | `e2e/map:maps/<stagingSha>/manifest.json` | T3 L3.5 (B5 reduce, report `publish` job) | T4 `scripts/e2e/select/map-adapter.ts` (only reader in T4), T3 B11, T5 B9 | `validateManifest`, `readManifest` in `e2e/map/manifest.ts` |
| Map store index (BK, R42) | `e2e/map/manifest-index.schema.json` | `e2e/map:maps/index.json` | T3 L3.5 (B5 publish), L3.9 (B10 failed nights) | T4 C1 `map-lookup.ts` | `validateManifestIndex`, `readManifestIndex`, `isReadableEntry` |
| Id grammar (BK, R15) | `e2e/map/ids.ts` | inside every format | T3 L3.5 | everyone; C parses ids only through it | `parseId`, `formatId`, `isIdOfKind`, `testKindOf` |
| `selection.json` (C0, C6) | `scripts/e2e/select/selection.schema.json` | setup run record; embedded in the bundle | T4 L4.8 `select.ts` | T2 L2.3 `plan-shards.mjs`, `comment.mjs`; T1 L1.2 via the bundle | `validateSelection`, `serializeSelection` |
| Measurement run record (C0, C11) | `scripts/e2e/measure/run.schema.json` | artifact `e2e-run-record`; `e2e/map:runs/<setupRunId>.json` | T4 L4.10 (`collect.ts`, called by report) | T4 L4.10 `attribute.ts`, `score-ai.ts`, `report.ts`; L4.9 limits | `validateRunRecord` |
| `run-request.json` (R84) | `scripts/e2e/contract/run-request.schema.json` | `e2e-run.yml` `workflow_dispatch` inputs | T2 L2.1 setup dispatch | T2 L2.2 `e2e-run.yml`, L2.3 trust check | `validateRunRequest` |
| Report request (R91) | `scripts/e2e/contract/report-request.schema.json` | `e2e-report.yml` `workflow_dispatch` inputs | T2 L2.2 fan-in job | T2 L2.3 | `validateReportRequest` |
| `run.json`: setup plan artifact (R80, R84, R88, R91) | `scripts/e2e/contract/setup-plan.schema.json` | artifact `e2e-plan`, file `run.json` | T2 L2.1 (`resolve`, `prepare`, dispatch) | T2 L2.3 report trust, recount, restore, sweep; T1 L1.0 `createRun` | `validateSetupPlan` |
| `plan.json`: shard plan (A11, R57) | `scripts/e2e/contract/shard-plan.schema.json` | artifact `e2e-plan`, file `plan.json` | T2 L2.3 `plan-shards.mjs` (run in setup) | T2 L2.3 `merge.mjs` (recount), L2.2 shard matrix | `validateShardPlan` |
| Bundle plaintext (R72, R81b, R81c) | `scripts/e2e/contract/bundle.schema.json` | never stored in clear; decrypted to the file named by `E2E_INPUTS_FILE` on the runner | T2 L2.1 `bundle.ts` | T1 L1.2 `e2e/helpers/ticket-broker.ts`, T2 L2.2 `inputs` job | `validateBundle` |
| Bundle envelope (R93) | `scripts/e2e/contract/bundle-envelope.schema.json` | artifact `e2e-bundle` (main) / `e2e-bundle-ai` (C9 extra shard), file `bundle.enc.json` | T2 L2.1 via `sealBundle` | T2 L2.2 `inputs` job, T1 L1.2 via `openBundle` | `validateBundleEnvelope`, `sealBundle`, `openBundle` |
| `control.json` (R6, R24, R36, R61) | `scripts/e2e/contract/control.schema.json` | artifact `e2e-control`, file `control.json` | T2 L2.1 (mail contain, seed integrity, limiter), T1 L1.0 (created users and tenants), T4 L4.10 (seeded escape, monthly schedule) | T2 L2.3 restore, sweep, integrity re-read; T4 L4.10 attribution | `validateControl` |
| `comment-rows-<task>.json` (R26, R58) | `scripts/e2e/contract/comment-rows.schema.json` | artifact `e2e-comment-rows-<task>`, file `comment-rows-<task>.json` | T3 (B8 and map rows), T4 L4.8 `rows.ts` and L4.10 escape row, T5 | T2 L2.3 `comment.mjs` | `validateCommentRows` |

Names and constants (artifact and file names, `COMMENT_SECTION_ORDER`, secret and variable names, TTL) are in `constants.ts`.
TypeScript types: `types.ts` (Section A and C formats) and `e2e/map/manifest.ts`, `e2e/map/ids.ts` (B formats). Import everything
from `scripts/e2e/contract` (index). Valid fixtures for every format: `__tests__/fixtures/e2e/contract/valid.ts`.

## Rules the validators enforce beyond shape

- **Ids.** Every test id is `test:<repoPath>::<title › title>` (Playwright title path joined with ` › `), `gen:screen:<cellId>` or
  `gen:snapshot:<controlId>`; its `kind` is `functional`, `screen` or `snapshot` respectively and must agree with the record's `kind`.
  A generated test that runs is `test:e2e/generated/<file>::<gen id>` (its one title is the gen id; Task 3 `generatedTestId`), kind
  `screen` or `snapshot`. `run.json`, `plan.json`, the bundle, shard reports and the report use only that form; a selection may name
  the bare gen id, which setup maps to it.
- **run.json.** `run_tag` = `r<setup_run_id>`. `gate` is set exactly when `kind` is `gate` (`ref` = `e2e/gate/<id>` or
  `artifact:<name>`, plus `path` and `sha256` of the drafted spec). Up to two dispatches, `main` with `e2e-bundle` and `ai` with
  `e2e-bundle-ai`, each with its own `run_key`; report matches a run only through `dispatched_run_id` recorded here.
  `state` `dispatched` needs a sent `main` dispatch and, unless `fixture`, `mail.contained`. `refused`, `failed`, `superseded`
  and `skipped` carry a `reason` and no sent dispatch. `supersedes` lists only older setup runs.
  Optional `target_sha` is the commit whose tree the preview serves; `tooling_sha` is the empty marker commit on it that heads
  the tooling branch (R101), or `null` when the preview is the PR's own.
- **plan.json and bundle.** Shards are numbered 1..n per `run_key` (at most 16), never empty; a test is planned once.
- **Bundle.** Tickets keyed by shard index, then by persona or run-user email (lower-case); a ticket appears once; tickets only for shards in
  the bundle's own plan; tenants only for tests in it; `expires_at - issued_at` ≤ 600 s. Any value shaped like a Clerk, Anthropic
  or Linear key, a private key or the Vercel bypass header rejects the bundle; there is no field for a bypass.
- **Envelope.** RSA-OAEP with SHA-256 (key ≥ 2048 bits) wraps a random 32-byte key; AES-256-GCM (12-byte iv, 16-byte tag) encrypts
  the canonical bundle JSON. Additional data = `cov215-e2e-bundle/1|<setup_run_id>|<run_key>|<sha>`, so the clear header cannot
  be swapped. `key_id` = sha256 of the recipient's SPKI DER. `openBundle(env, key, {sha: github.sha})` refuses a wrong sha before
  decrypting.
- **control.json.** The mail projection is exactly `{emailEnabled, catchAllAddress, catchAllSource}`; a contained deployment never
  had `emailEnabled: true` (R6); adoption is only from an older setup run.
- **selection.json.** Canonical JSON, every array sorted. A `fullRun` reason (`<code>` or `<code>: <detail>`) carries no tests and
  no shard plan (never a partial selection, C0). Without one, the always-run ids are all selected, the `rule` and `mapSha` are set,
  no file is unplaced, and a non-null `shardPlan` partitions exactly the selected ids.
- **comment rows.** All text is plain text; the renderer escapes markdown and neutralises @mentions (R89). A missing file renders
  its section as not run; an `error` section carries `detail`.
- **Manifest index.** `latest` is the newest `published` entry (null if none); failed entries carry a `reason`; entries are in
  `builtAt` order. Entries of an unknown major stay in the index; `isReadableEntry` tells C1 to skip them.

## Decisions taken by the contract lane (not fixed by the plan text)

1. Paths for Section A formats are under `scripts/e2e/contract/` (the plan names none).
2. `run-request.json` is the `e2e-run.yml` dispatch input object `{setup_run_id, run_key}`; private-A's older `run-request.json`
   (`environment_url`, `label`, ...) is superseded by `run.json` under R84/R88.
3. `run.json` names the setup run `setup_run_id` (A's text calls it `run_id`), matching the dispatch input.
4. AES-256-GCM rather than the AES-256-CBC used in spike S17: the plan requires a tampered ciphertext to fail to decrypt, which CBC
   does not guarantee.
5. The mail projection lives in `control.json` (artifact `e2e-control`), as `06-tests-phase0.md` says; A1's artifact name
   `mail-projection` is not used. `run.json` carries only `{contained, effective_catch_all}` (A10).
6. Artifact names `e2e-plan` (a contain-time record naming the deployment, state `failed`, uploaded with `e2e-control` right after
   mail is contained, then replaced once by planning before any dispatch; the runner reads it), `e2e-plan-final` (written once by
   the dispatch phase with the dispatched, failed or superseded state; report and sweep read it first), `e2e-control`, `e2e-bundle-ai`, `e2e-run-record`, `e2e-comment-rows-<task>`.
7. Test id form `test:<path>::<titles joined by " › ">`; `<anon#N>` is 1-based; `<module>` is only a whole chain.
8. Convex edge kinds `ctx-run | scheduler | cron | http-route | helper-import | src-caller`; manifest `health` fields from the B1,
   B4 and B5 acceptance prints; generated tests carry `provenance: human`.
9. Ticket secret name `E2E_TICKET_KEY` (R95 rename); the public half stays in variable `E2E_TICKET_AGE_RECIPIENT`.
10. Bundle tenants (Task 1 reconcile): keyed `t_` + the first 24 hex of sha256 of the Playwright title path joined with ` > `
    (`tenantKeyOf` in `tenant-key.ts`, used by setup and the helpers; the title path starts with the spec file relative to
    `e2e/`); a second tenant for one test is `<key>#2` up to `#20`. `title` holds the readable title path, for debugging, and must
    hash to the key. Each tenant carries `org_name` and its `members`, each with its actor `kind` (exactly one `owner`; others at
    most once), the Clerk `user_id`, the `convex_user_id` and `role`. `users` maps every Clerk user id the bundle can sign in
    (registry personas and the run's own users) to the email its tickets are keyed by; every tenant member is in it.
11. One bundle implementation: setup (`scripts/e2e/setup/t1/bundle.ts`) and the e2e helpers (`e2e/helpers/ticket-broker.ts`)
    both use `bundle.ts` here. The persona registry is `e2e/helpers/personas.json`, read by the helpers and by setup.
