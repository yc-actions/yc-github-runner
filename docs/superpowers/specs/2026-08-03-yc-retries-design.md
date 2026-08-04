# Retries for transient Yandex Cloud errors

Resolves [#700](https://github.com/yc-actions/yc-github-runner/issues/700).

## Problem

The action fails immediately when Yandex Cloud rejects a request under load:

```text
Error: ClientError: /yandex.cloud.compute.v1.InstanceService/Create RESOURCE_EXHAUSTED: The limit on maximum number of active operations has exceeded.
```

This is transient — the limit clears as other operations finish — but the job dies on the first
rejection. Users running many concurrent jobs hit it routinely.

## Why it happens

`@yandex-cloud/nodejs-sdk` already ships retry middleware
(`dist/middleware/retry.js`), and `RESOURCE_EXHAUSTED` is already in its default
retryable status set. It is simply never activated:

- `retry` defaults to whether the method is marked idempotent in Protobuf.
  `InstanceService.Create` and `.Delete` are not, so it defaults to `false`.
- `retryMaxAttempts` defaults to `1`.
- `createVm` and `destroyVm` call the client with no call options at all.

The SDK's own `waitForOperation` does pass `{retry: true, retryMaxAttempts: 3}`, so operation
polling is already covered. Only the initial create/delete calls are exposed.

## Approach

Configure the SDK's existing retry middleware rather than writing a new retry framework. A single
module owns the schedule and the budget math; call sites spread its output into their call options.

Rejected alternatives:

- **Custom `withRetry` for everything.** Exact delay control and one code path, but reimplements
  middleware the SDK already ships and tests, and requires hand-rolling gRPC status classification.
- **`AbortSignal` budget.** The middleware honours `options.signal`, so wall-clock could enforce the
  budget exactly. Rejected because expiry surfaces as `AbortError` instead of the real cloud error,
  and it can cancel an in-flight create, leaving a VM whose id is never learned.

## Retry schedule

Nominal delays: **1s → 2s → 4s → 8s → 16s → 32s → 60s → 60s → …** — a doubling climb from a second
to a minute, then a fixed one-minute interval. Starting at a second keeps the cost of a brief
hiccup proportional to it.

The SDK computes `delay = min(cap, 2^k · base) · (1 + rand) / 2`, so the expected delay is
`0.75 × backoff`. Dividing the nominal targets by `0.75` makes the *expected* delays land on the
schedule above:

| constant            | value      | expected delays        |
| ------------------- | ---------- | ---------------------- |
| `retryBaseDelayMs`  | `1_333`    | 1s, 2s, 4s, 8s, 16s, 32s |
| `retryMaxDelayMs`   | `80_000`   | 60s from the 7th on      |

Jitter is kept deliberately. The root cause is many jobs colliding, so spreading their retries out
is a feature, not noise.

## Configuration

New optional action input `retry-timeout`: an ISO-8601 duration, parsed with `moment.duration`
exactly like the existing `ttl` input.

- Default: `PT5M`.
- `PT0S` disables retries entirely (restores today's behaviour).
- Values above `PT30M` are **silently clamped** to `PT30M` with a `core.warning`. This is an
  internal cap, never a validation error — an over-large value must not fail the job at startup.

Stored on `ActionConfig` as `retryTimeoutMs: number`, so the retry module never handles a `moment`
object.

Derived attempt counts, walking the nominal schedule and counting retries whose cumulative delay
fits the budget:

| budget  | retries | approx. waiting |
| ------- | ------- | --------------- |
| `PT0S`  | 0       | —               |
| `PT5M`  | 9       | ~243s           |
| `PT10M` | 14      | ~543s           |
| `PT30M` | 34      | ~1743s          |

## `src/retry.ts`

Single owner of the schedule and budget math. Three exports:

- `attemptsForBudget(budgetMs): number` — pure; walks the nominal schedule as described above.
  Returns a count of *retries*, matching the SDK's `retryMaxAttempts` semantics: `N` means up to
  `N + 1` total calls. Every "retries" figure in this document uses that meaning.
- `grpcRetryOptions(budgetMs, opName): RetryOptions` — returns `retry: true`, the two delay
  constants, `retryMaxAttempts` from the budget, `retryableStatuses`, and an `onRetryableError`
  callback that logs `core.info("<opName> failed with <status>, retrying in Ns (attempt k/N)")`.
  Retries become visible in the job log instead of a silent hang.
- `withRetry<T>(fn, budgetMs, opName): Promise<T>` — the same schedule for the non-gRPC axios token
  exchange. Retries on network errors and HTTP 429/5xx only.

Retryable gRPC statuses: `RESOURCE_EXHAUSTED`, `UNAVAILABLE`, `UNKNOWN`, `INTERNAL` — the SDK's
default set.

## Idempotency

Retrying non-idempotent `Create`/`Delete` on `UNAVAILABLE` or `UNKNOWN` risks acting twice: a
request may have succeeded with its response lost. Yandex Cloud's `Idempotency-Key` header (a v4
UUID) prevents this — a repeat carrying the same key returns the *existing* Operation instead of
starting a new one.

Each call generates one key with `randomUUID()` from `node:crypto` **before** the call, so every
retry carries the same key. The SDK middleware forwards `metadata` unchanged to each attempt, so
the key stays stable across the whole retry sequence.

```ts
const idempotencyKey = randomUUID()
const op = await instanceService.create(CreateInstanceRequest.fromPartial({ ... }), {
    ...grpcRetryOptions(config.input.retryTimeoutMs, 'Create instance'),
    metadata: Metadata({ 'idempotency-key': idempotencyKey })
})
```

`destroyVm` gets identical treatment with its own key.

## Auth coverage

Two distinct paths:

- `exchangeToken` (the workload-identity token exchange over axios) is wrapped in `withRetry`. Its
  current `res.status !== 200` branch is dead code — axios throws on non-2xx by default — and the
  wrapper's error classification replaces it.
- The `Session` IAM token fetch is created internally by the SDK and accepts no call options. It is
  covered *transitively*: a token failure rejects the credentials metadata generator, which surfaces
  as `UNAVAILABLE`/`UNKNOWN` on the outer create/delete call, which is now retried. This is the one
  part of the scope covered indirectly rather than directly.

## Dependency

The SDK re-exports neither `Status` nor `Metadata`, both of which live in `nice-grpc`. `nice-grpc`
moves from a transitive dependency to a direct one in `dependencies`, rather than being deep-imported
through the SDK's `node_modules`. It is bundled by `ncc` either way, so `dist/` size is unaffected.

## Out of scope

- `waitForOperation` — the SDK already retries `GetOperation` internally, and it is idempotent.
- The octokit GitHub API calls in `src/gh.ts` — not Yandex Cloud.

## Error handling

Unchanged on exhaustion. The final `ClientError` propagates to the existing handler in `run()`, so a
genuinely stuck cloud still fails with the real `RESOURCE_EXHAUSTED` message plus `x-request-id` and
`x-server-trace-id`, exactly as the issue reporter saw. Retrying delays that outcome; it never masks
it.

## Known limitations

`retry-timeout` is a target, not a hard deadline. The budget sizes the *attempt count* from expected
delays, but jitter varies each actual delay between 0.67× and 1.33× nominal, and an in-flight gRPC
call can itself take minutes. Real elapsed time can overshoot the budget by roughly a third. Making
it exact would require the rejected `AbortSignal` approach, at the cost of the final error message.
This is documented in the input description.

### Retry coverage does not reach every gRPC failure shape

The SDK's client factory builds its middleware stack as
`createClientFactory().use(errorMetadataMiddleware).use(retryMiddleware).use(deadlineMiddleware)`
(`dist/utils/client-factory.js`). Because `composeClientMiddleware(m1, m2)` makes `m2` the outer
layer, chaining `.use` calls like this nests them with the *last* `.use` outermost. The effective
call order is therefore deadline → retry → errorMetadata → the actual gRPC call: `retryMiddleware`
sits *outside* `errorMetadataMiddleware`, not inside it.

That ordering matters because `retryMiddleware`'s guard is `!(error instanceof ClientError) → throw`
(`dist/middleware/retry.js`) — anything that isn't a `ClientError` skips retrying entirely,
regardless of `retryableStatuses`. `errorMetadataMiddleware` (`dist/middleware/error-metadata.js`),
running on the inside, rewrites any error into a `new ApiError(error, md)` whenever response headers
(`md`) were captured before the failure. `ApiError extends Error`, not `ClientError`
(`dist/errors.js`), so once headers have arrived, a subsequent failure on that same call is wrapped
as an `ApiError` and `retryMiddleware` — sitting outside it — never sees a `ClientError` to retry.
In short, this design retries transient failures that occur before the server sends headers, but not
ones that occur after headers arrive but before a full response.

The case this whole effort was built for is unaffected. Issue #700's log line reads
`Error: ClientError: /yandex.cloud.compute.v1.InstanceService/Create RESOURCE_EXHAUSTED: ...` —
note the `ClientError:` prefix, not `ApiError:` (`ApiError` sets `name = 'ApiError'`, so a wrapped
error would render differently). That means the failure arrived with no response headers at all,
so `errorMetadataMiddleware` never wraps it and `retryMiddleware` retries it as designed.

Coverage is therefore partial: it fully handles the reported issue and any failure of the same
shape, but not a `RESOURCE_EXHAUSTED`/`UNAVAILABLE`/etc. that shows up after headers are already on
the wire. Closing that gap can't be done by reordering `.use()` calls alone without risking other
behavior the SDK relies on, and doing it properly would mean writing a bespoke retry layer instead
of configuring the SDK's own middleware — reopening the "custom `withRetry` for everything"
alternative this design already rejected. Left as follow-up work rather than blocking this change,
since it doesn't affect the reported issue.

## Testing

The existing suite is pure-function only (`buildUserDataScript`, config parsing, memory parsing) with
no SDK mocking infrastructure. New tests match that shape:

`__tests__/retry.test.ts`

- `attemptsForBudget` at boundaries: `PT0S` → 0, `PT5M` → 9, `PT30M` → 34.
- Budgets above 30 minutes clamp rather than throw.
- `grpcRetryOptions` emits the constants that place expected delays at 10/20/40/60/60.
- `withRetry` against a fake function: retries 429/5xx, does not retry 400/401, stops at the attempt
  limit, rethrows the last error.

`__tests__/config.test.ts`

- `retry-timeout` parsing, default of `PT5M`, and clamping-without-throwing.

No test drives a real `instanceService`. The call-site wiring is verified by review, consistent with
how the rest of this action is tested.

## Documentation

- `action.yml`: new `retry-timeout` input with description, default, and the clamp noted.
- `README.md`: matching input row.
