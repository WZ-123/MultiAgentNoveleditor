# Chapter Harness Benchmark

This corpus contains three original, synthetic mini-novels. It is safe to keep in the repository and does not contain user novel text or Provider credentials.

Corpus `1.3.0` adds deterministic state-verifier counterexamples and scripted independent-Judge evidence cases: an explicit contradiction must block the draft, a source that merely omits a field must remain advisory, and source coverage requires paragraph-backed independent evidence with valid paragraph IDs.

## Profiles

- `smoke`: target parsing, context compilation, and one live knowledge-boundary chapter.
- `core`: representative state, knowledge, location, and write-isolation cases. Live cases default to three runs.
- `full`: all deterministic orchestration, cache, repair, state, and post-write cases.

## Commands

```bash
npm run benchmark:harness:offline -- --profile=full
npm run benchmark:harness:live -- --profile=smoke
npm run benchmark:harness:live -- --profile=core --repeat=3 --concurrency=2
node scripts/eval-harness-benchmark.js --report=artifacts/harness-benchmark/<run>/report.json [--accept-baseline]
node scripts/compare-harness-benchmark.js --candidate=<report> --baseline=<baseline>
node scripts/replay-harness-benchmark.js --report=<report>
```

Use `MANA_PROVIDER_CONFIG_ROOT` or `--provider-root` to point at an existing development configuration. Credentials are loaded read-only into memory. Reports omit API keys, Provider URLs, local configuration paths, and generated chapter text.

Pass `--novel=/path/to/novel` only for an optional shadow run. The project is copied into the ignored run directory; its report row contains an anonymous ID, hashes, scores, and aggregate metrics only.

`--accept-baseline` writes a baseline only when every acceptance gate passes; it is supported by both the runner and evaluator so an unchanged, already completed report can be approved after evaluator-only fixes. `--resume --report=<existing-report>` keeps passing samples and reruns failed or under-covered samples.

When an evaluator-only policy correction is intentionally applied to an already completed raw report, use `node scripts/eval-harness-benchmark.js --report=<report> --rebase-policy --accept-baseline`. The resulting baseline records `policyRebasedFrom`; the raw report is left unchanged.

Reports carry a Benchmark policy version in addition to Corpus, model IDs, and Prompt signatures. A policy change is intentionally not comparable with an older baseline. Live source recall is calculated from the independent Judge's paragraph-backed evidence; a verified state check may guard a prior-chapter/timeline fact that only constrains non-occurrence, while literal source claims still require paragraph evidence. State consistency excludes only deterministic direct conflicts and extractor failures, and aggregate state/soft-constraint rates are arithmetic means rather than medians. Gate metrics are calculated over accepted samples, while `allSample*` metrics and failure counts retain every failed generation for audit and cost accounting.

The independent Judge is part of each live case's telemetry: its model ID, Prompt signature, latency, and token usage are included in the case and total cost. The runner also requires the sum of per-case usage to match Provider-level usage before accepting a live report. This prevents a quality gate from becoming an uncounted cost center.

The `live/core` absolute performance gate is enforced by the evaluator: total usage must not exceed 780,000 tokens and P95 latency must not exceed 450,000 ms. These limits apply even when no comparison baseline is supplied.
