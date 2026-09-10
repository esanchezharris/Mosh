# Native zero-spend rehearsal boundary

An explicitly requested provider now uses only that configured direct provider.
An unknown or incomplete explicit selection fails; it neither selects another
provider nor uses the opaque server proxy. Unqualified calls without a rehearsal
policy retain the existing proxy-first/default-provider behavior.

For an isolated synthetic rehearsal, launch the native executable with
`MOSH_BRAIN_TRIAL_POLICY` containing exactly these JSON fields:

```json
{"provider":"openai","model":"synthetic-pinned","baseUrl":"http://127.0.0.1:12345/v1","maxCalls":3,"loopbackOnly":true}
```

Use the actual reserved fixture port, matching `OPENAI_BASE_URL` and
`OPENAI_MODEL`, a fixture-only key, and `MOSH_IGNORE_BUNDLED_BRAIN_CONFIG=1`.
Construct the child environment without inherited provider credentials. Use a
new owned `_harness` session, audio disabled, and the owner runtime disabled.
The fixture must be a locally owned responder that never forwards requests.

The native policy is loaded once on first chat use and cannot be reset through
the WebView. Present but invalid policy denies chat. A valid policy pins provider,
configured model and literal loopback endpoint, bypasses the server proxy, and
disables HTTP redirects. Its process-wide counter reserves transport attempts
under a lock; failures consume their reservations. Non-array message payloads or mismatched
selection do not reach transport. Restarting the process starts a new counter.

This policy deliberately accepts only `loopbackOnly:true`. It does not enable a
live paid trial or enforce a dollar allowance. Live-provider selection, consent,
pricing, worst-case reservation, retries and cross-process accounting still need
an explicit live-trial decision and verification. Missing usage is unknown cost,
not zero. A local fixture can prove transport behavior, not provider availability,
model quality or musical understanding.

Direct native replies retain `model` as configured, optional `responseModel` as
reported by the provider, optional unmodified `usage`, `rawResponse`, HTTP
`statusCode`, elapsed `ms`, and provider identity. HTTP and malformed-response
failures retain the receipt too. The UI bridge returns these fields or exposes
them through `BrainChatError.receipt`. The server proxy and Vite development
route do not acquire upstream accounting guarantees from this change. Receipts
are not an automatic durable billing ledger; rehearsal tooling must capture them.
Treat raw responses as private task evidence and never publish credentials or
private media embedded in provider output.
