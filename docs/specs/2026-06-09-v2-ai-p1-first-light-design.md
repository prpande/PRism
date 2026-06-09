# v2 AI P1 First-Light — PR Summarizer + Live enablement — design

- **Roadmap:** [`docs/specs/2026-06-05-v2-ai-roadmap-design.md`](2026-06-05-v2-ai-roadmap-design.md) §P1 (First-Light), §3.1 (per-PR cache keying), §4 (three modes / egress consent). Builds directly on PR3a [`docs/specs/2026-06-07-v2-ai-p0-pr3a-fe-mode-migration-design.md`](2026-06-07-v2-ai-p0-pr3a-fe-mode-migration-design.md) and PR2 [`docs/plans/2026-06-06-v2-ai-p0-pr2-capability-model.md`](../plans/2026-06-06-v2-ai-p0-pr2-capability-model.md).
- **Date:** 2026-06-09
- **Tier / Risk:** T3 · **gated** — *risk-surface* (first real LLM call; PR content egresses the device; prompt-injection; consent enforcement) **and** UI-visual (new Live segment + consent modal). Retains the human spec/plan review gates.
- **Branch / Base:** `feat/v2-ai-p1-first-light` → **`V2`** (never `main`).
- **Status:** Design (awaiting human spec review) · revised after ce-doc-review (1 pass, 7 personas).

> Section cross-references in this doc are to **this doc's** sections unless prefixed "roadmap §".

---

## 1. Problem & context

P0 (PR1–PR3a) built the AI substrate dark: `ILlmProvider` + `ClaudeCodeLlmProvider` (one-shot `claude -p` with the cache levers), the tri-state capability model (`AiCapabilityResolver`, `AiSeamSelector`), `PromptSanitizer`, `ITokenUsageTracker`, `GetDiffAsync`, the event bus, and the `IPrSummarizer` seam with Noop/Placeholder impls. PR3a shipped the **Off | Preview** selector and the SampleBadge sample-data treatment. Every `ai.*` capability still resolves false: no live-capable seam is registered, and the selector's Live branch is **dead** (`liveAvailable: () => false`, hardcoded in `AddPrismAi`).

**This slice lights the first real feature.** It registers a real `IPrSummarizer` (`ClaudeCodeSummarizer`) into the live-seam dictionary, makes the selector's Live branch *live* (the `() => false` becomes a real availability-and-consent check — itself a behavioral change beyond "register a seam"), and rewires the PR-detail summary card to a live fetch. It is the roadmap's deliberate **lowest-blast-radius** first surface: read-only, free-text, one PR at a time, user-verifiable against the diff.

**Live enablement is folded in as the UI prerequisite, in the correct order.** A live summary call egresses PR content (diff, title, description) to Anthropic via the Claude Code CLI. PR3a's spec flagged this as a hard sequencing dependency: *"PR3b's egress-consent gate MUST land before any P1 work registers a real Live seam … a hand-edited Live config could egress PR content with no consent."* This slice resolves that risk **within the same change**.

**Atomic-ordering mandate (load-bearing for safety).** The consent term MUST be wired into the gating predicates (§5) **in the same PR** that registers `ClaudeCodeSummarizer`. The implementation plan must not split these across PRs: a window where the real seam is registered but the consent predicate is absent would let a direct `POST /api/preferences {"ui.ai.mode":"live"}` egress PR content with no consent. The exit test "Live + no consent ⇒ 204, zero egress" (§12) is a **required**, blocking criterion — not advisory.

## 2. Scope & non-goals

**In scope:**

- **Backend** — `ClaudeCodeSummarizer : IPrSummarizer` (provider + sanitizer + diff + token tracker + a per-process in-memory summary cache); register it into the live-seam dictionary; the explicit D111 `IsSubscribed` gate on `/ai/summary`.
- **Backend** — egress consent wired into the Live-availability gating (the two predicates + the disabled-reason path — see §5 for the *actual* wiring, which is more than a one-line change); a consent record in `AppConfig`; `GET /api/ai/egress-disclosure`; `POST /api/ai/consent`.
- **Frontend** — make **Live** a selectable third segment via a two-phase commit (§7); the consent-before-flip `EgressConsentModal`; rewire `AiSummaryCard`/`useAiSummary` with a loading affordance, coordinated with the active-PR subscription.

**Out of scope — deferred:**

- **P1b** — `<dataDir>/llm-cache` file cache + restart survival, event-bus eviction, the per-PR **context artifact** keyed `(prRef, baseSha, headSha)`, **base-rebase staleness** eviction (R2), measured prompt-cache hit, the **stale badge + Regenerate** UX, the formal **`IAiCache`** contract (introduced when the disk impl's requirements are known — §4), and the disclosure-version **409 re-fetch** path (§7).
- **PR-nature classification / the `Category` field** — `Category` is left empty in P1a (see §2 deferrals; the FE suppresses the empty label, §7). The classifier is one feature serving two surfaces (inbox chip + detail `Category`), built later per roadmap §3.2 cost-control decisions.
- **The 4 disabled-state guidance messages** and a **dedicated Settings → AI pane** — AI mode stays in `AppearancePane`; consent is a modal triggered from there.
- **The re-consent affordance** for the "Live + consent-required" state — unreachable through normal UI this slice (single provider, constant disclosure version); recovery is the Off→Live re-toggle (which re-opens the modal). Built when a real trigger ships.
- **Multi-provider** — there is one provider. The "active provider id" is a constant (§5); per-provider consent switching is modeled in the record shape but is **forward-looking** (no switch mechanism exists to exercise it).

> **Open scope decision (§13):** whether to pull a **minimal inline error + Retry** affordance into P1a. The product/design review argues silent-hide-on-failure corrupts the dogfood trust signal. Resolve with the user before planning.

## 3. Architecture overview

```
PR detail (Live) ──GET /ai/summary──► AiEndpoints (handler gains IActivePrCache)
                                         │  D111: IsSubscribed(prRef)?  no ─► 204
                                         ▼
                                    IAiSeamSelector.Resolve<IPrSummarizer>()
                                         │  Live branch: seamRegistered
                                         │            && liveAvailable()   ← was () => false; now real
                                         │            && consentRecorded(providerId)
                                         │  not usable ─► NoopPrSummarizer ─► null ─► 204
                                         ▼
                                    ClaudeCodeSummarizer.SummarizeAsync(prRef)
                                         │  in-memory cache (prRef, headSha) hit ─► cached (0 provider calls)
                                         ▼  miss
              IPrReader.GetDiffAsync(prRef, DiffRangeRequest) ─► sanitize diff + title + description
                                         ─► ILlmProvider.CompleteAsync (v1 prompt, --append-system-prompt)
                                         ─► ITokenUsageTracker.RecordAsync(feature:"pr-summary")
                                         ─► PrSummary(Body, Category="")  ─► 200
```

**Consent is wired into the gating, but it is NOT "one shared predicate" today — be precise.** The current code has *two structurally different* Live-availability inputs plus a *third* reason path:

1. `AiSeamSelector.Resolve<T>()` gates Live on a `Func<bool> _liveAvailable` (today `() => false`). Consent must be folded into this delegate, and the delegate must start returning real availability.
2. `AiCapabilityResolver.Capable(seam)` gates Live on a per-call `LlmAvailability.Available`. Consent must be incorporated here too.
3. `AiCapabilityResolver.DisabledReason(mode, availability)` is a **static** method whose signature has no consent input, and `CapabilitiesEndpoints` injects no consent source. Emitting `disabledReason="consent-required"` requires (a) extending `DisabledReason` to take consent state (or making it instance state reading `AiConsentState`) and (b) injecting the consent source into `CapabilitiesEndpoints`.

So the consent change touches **three sites**, not one. The reason-precedence rule must be explicit: when Live is **both** probe-unavailable **and** unconsented, `disabledReason` reports the **provider/probe reason first** (consent is moot if the provider can't run); `consent-required` is reported only when the provider is available but consent is absent.

## 4. Backend — the summarizer

**`ClaudeCodeSummarizer : IPrSummarizer`** (new). **Composition site:** compose it in `PRism.Web`'s `AddPrismAi` (where the AI seams are already wired), not inside `PRism.AI.ClaudeCode` — that keeps the AI provider project free of a `PRism.Core.PrDetail` dependency. `SummarizeAsync(PrReference, ct)`:

1. **Resolve the diff + headSha.** Derive the diff and the current `headSha` from the **diff-fetch / `PrDetailLoader` path** (`PrDetailLoader.TryGetCachedSnapshot` / `GetOrFetchDiffAsync`, reusing the memoized diff). **Do not source SHAs from `ActivePrSnapshot`** — it carries `HeadSha` only (no `baseSha`) and is null until the first poll. The cache key is `(prRef, headSha)`; `baseSha` has **no current producer**, which is why P1a cannot key on it (see the R2 acceptance, §9). Use the live `GetDiffAsync(prRef, DiffRangeRequest)` overload — the legacy `(fromSha, toSha)` overload throws `NotImplementedException`.
2. **Cache lookup.** A per-process in-memory cache keyed `(prRef, headSha)`. Hit ⇒ return cached `PrSummary`, **zero provider calls**. *For P1a this may be the BCL `IMemoryCache` or a small internal dictionary; the formal `IAiCache` contract is introduced in P1b when the disk impl's contract needs (restart, eviction hooks) are known — introducing a one-impl interface now is premature.*
3. **Sanitize all attacker-controlled inputs.** `PromptSanitizer.WrapAsData(diff, "diff")`, `WrapAsData(title, "title")`, `WrapAsData(description, "description")`. **PR title and description are author-controlled and MUST be wrapped** — not just the diff (the sanitizer's own contract lists titles as attacker-controllable).
4. **Generate.** `ILlmProvider.CompleteAsync` with a hand-written **v1 system prompt** via `--append-system-prompt` (cache-prefix-stable). **Body** = free-text summary. **`Category` = ""** (classifier deferred); the wire slot stays so the FE and the future classifier need no contract change.
5. **Record usage.** `ITokenUsageTracker.RecordAsync(new TokenUsageRecord(Feature:"pr-summary", …))`.
6. **Cache store** keyed `(prRef, headSha)`, then return.

**Provider id.** Consent (§5) keys on a provider id. There is one provider; use a backend constant `ClaudeProviderId = "claude-code"` (matching the literal already used in `TokenUsageRecord`). The multi-provider registry is deferred.

**Registration.** Add `ClaudeCodeSummarizer` to the live-seam dictionary **and** flip the selector's `liveAvailable` delegate to a real availability+consent check, in the same PR (§1 mandate).

**Eval.** P1a ships a reasonable v1 prompt. The golden-set tuning loop (roadmap §11.1) is the **P1→P2 gate**, human-anchored — it does **not** block this slice's merge.

## 5. Backend — egress consent

**Predicates (the real wiring — see §3).** Consent term: `consentRecorded(ClaudeProviderId)` ⇔ a stored record exists whose `DisclosureVersion == current` and whose `ProviderId == ClaudeProviderId`. Fold it into (1) the selector's `liveAvailable` delegate and (2) the resolver's `Capable`, and surface it via (3) `DisabledReason` + `CapabilitiesEndpoints`. No consent ⇒ `Summary` flag `false`, `disabledReason="consent-required"` (when provider available), seam ⇒ Noop ⇒ 204. **Security guarantee:** a direct `POST /api/preferences {"ui.ai.mode":"live"}` cannot egress — the seam resolves Noop until a consent record exists.

**Storage.** Add an `AiConsentConfig` record (`{ ProviderId, DisclosureVersion, AcknowledgedAt }`) to `AppConfig`. **Placement + backfill (avoids a startup NRE):** add it as an explicit member and add the matching null-backfill in `ConfigStore.ReadFromDiskAsync` (`AiConsent = parsed.AiConsent ?? AppConfig.Default.AiConsent`), mirroring the existing `Ui`/`Llm`/`Polling` backfills; `Default` represents "no consent recorded." Persist via a **dedicated `ConfigStore.RecordAiConsentAsync(providerId, disclosureVersion, ct)`** (modeled on `SetDefaultAccountLoginAsync`, *not* the flat `PatchAsync` allowlist) — and cover it with a concurrent-write test (a consent write racing another config mutation must not be lost). Mirror into an `AiConsentState` singleton on the `ConfigStore.Changed` event, as `ui.ai.mode` mirrors into `AiModeState`.

**Disclosure source.** `RecipientIdentity = "Anthropic, via the Claude Code CLI"` and `DataLeavesDevice = true` are constants owned by the **egress-disclosure module / endpoint** (one consumer), **not** added to `ProviderCapabilityDescriptor` — that record documents itself as "minimal until a second provider lands," and two always-true-for-the-only-provider fields would violate that invariant.

**Disclosure version.** Backend constant `DisclosureVersion = "1"`; consent valid only while `record.DisclosureVersion == current`. **A "material change" that warrants a bump** = a change to the recipient, the data categories sent, or retention/usage terms (not copy-editing). Bumping invalidates stored consent ⇒ re-prompt. Switching the active provider (forward-looking) invalidates likewise. Both fall out of the predicate.

**Endpoints (both new; both under the existing `/api/*` pipeline — `SessionTokenMiddleware` requires a session token; `POST` is additionally covered by `OriginCheckMiddleware`):**

- `GET /api/ai/egress-disclosure` → `{ recipient, dataCategories[], disclosureVersion, alreadyConsented }`. `dataCategories` = `["Pull request diff (changed files and their contents)", "Title", "Description"]` — truthful to what the summarizer sends. `alreadyConsented` = active provider has a valid current-version record (lets the FE skip the modal on repeat Live selection).
- `POST /api/ai/consent { disclosureVersion }` → if `disclosureVersion != current` ⇒ **409**. Else stamp `{ ClaudeProviderId, disclosureVersion, AcknowledgedAt = UtcNow }`, return **204**. The backend stamps the provider id itself. Re-recording is idempotent (re-stamps `AcknowledgedAt`).

**Consent withdrawal (named gap).** Switching to Off/Preview does *not* delete the consent record — it makes the predicate moot until Live is re-selected. A permanent "revoke consent" action is **not** in this slice (deferred with the Settings→AI pane); document this so it is a conscious omission.

## 6. Backend — the D111 gate on `/ai/summary`

`IActivePrCache.IsSubscribed(prRef)` is the D111 token-spend gate: a live summary call fires only for a PR with an active subscriber. The `/ai/summary` handler currently injects only `(IAiSeamSelector, ct)`; the gate **adds an `IActivePrCache` parameter** and an early `if (!cache.IsSubscribed(prRef)) return NoContent();` branch **before** resolving the seam, mirroring the established `IsSubscribed` pattern in `PrSubmitEndpoints`/`PrRootCommentEndpoints`. This replaces the standing `D111: …add an IsSubscribed gate` comment with real code + a test. Off / no-consent / not-subscribed all converge on **204**.

**Subscription-race coordination (correctness, not just spend).** The active-PR subscription is established by an async SSE handshake (`useActivePrUpdates`: stream connect → `subscriberId()` → `POST /api/events/subscriptions`). On a cold PR open, a summary fetch fired on mount can **beat** subscription registration ⇒ D111 ⇒ 204 ⇒ card hidden — and today `useAiSummary` only refetches on `[prRef, enabled]`, so it never recovers. **Fix:** gate `useAiSummary`'s `enabled` (and refetch) on the active-PR subscription being **established**, not on bare mount, so the FE fetch and the backend D111 gate agree. Tested explicitly (§11) — the existing always-subscribed test fake hides this race.

## 7. Frontend

**`AppearancePane` selector — two-phase commit (avoids flash-then-revert).** Options become `Off | Preview | Live`. The `SegmentedControl` fires `onChange` on **arrow-key** navigation and moves focus synchronously, so the Live segment must **not** be driven straight off `preferences.ui.aiMode`. `AppearancePane` holds a local **`pendingLive`** state; the control's `value` shows the **resolved** mode (off/preview/live from preferences), never a pending Live. Flow:

- `off` / `preview` → `set('ui.ai.mode', next)` directly (existing behavior + no-op guard).
- `live` → **intercept; do not POST, do not advance the control's value.** `GET /api/ai/egress-disclosure`; if `alreadyConsented` ⇒ `set('ui.ai.mode','live')` directly; else open `EgressConsentModal`.
- **Accept** → `POST /api/ai/consent` → on 204, `set('ui.ai.mode','live')` (now the control advances) → clear pending → close.
- **Decline / error** → clear pending, no mode change; the control was never advanced, so "revert" is a no-op and focus returns to the **previously-selected segment** (e.g. Preview), not the Live button that triggered the intercept.
- **Non-204 from consent POST** (incl. 409) → treat as generic failure: toast + revert. *(The 409-specific disclosure re-fetch is deferred to P1b with the re-consent affordance — building it now serves a trigger that cannot fire this slice.)*

**`EgressConsentModal`** (new; on the existing `Modal` primitive — focus-trapped). **Interaction states, all specified:**
- **Title:** "Enable Live AI" (the `Modal` required title / `aria-labelledby`).
- **Value-first copy:** lead with what Live enables (a real, diff-grounded PR summary) **before** the egress disclosure — first contact with AI should not be a bare legal wall.
- **Disclosure body:** `recipient`, `dataCategories`, per-call nature, wired via `aria-describedby` (the most important content for screen readers).
- **Loading:** while the disclosure GET is in flight, render the modal with a `Skeleton` body + Accept/Decline disabled + `aria-busy="true"` + a visually-hidden "Loading data-sharing disclosure…" status (the existing `Skeleton` is reduced-motion-safe).
- **Error / fail-closed:** disclosure fetch failure ⇒ modal shows an error, cannot consent.
- **Default focus:** **Decline** (the less-destructive action), matching the discard-modal precedent.

**`useAiSummary` + `AiSummaryCard`.** The hook returns `PrSummary | null` today; refactor to `{ summary, loading }` and gate `enabled` on subscription-established (§6). **Consumer + mock migration (both test trees):** update the `OverviewTab` destructure and `AiSummaryCard` prop usage, and every `vi.mock('.../useAiSummary', () => ({ useAiSummary: () => null }))` site → `() => ({ summary: null, loading: false })`, in **both** co-located `src/**` and legacy `frontend/__tests__/`. `AiSummaryCard` renders a **`Skeleton`-based loading affordance** (`aria-busy`/`aria-live`, matching `InboxSkeleton`) while in flight, the summary on success, and **hides** on failure/204 (best-effort, per §13 open decision). `Category===""` ⇒ the category label is not rendered, and the card layout must read intentionally with the category region absent for the whole P1a window (not merely suppress the label).

**Help text.** Update the `ai-mode-help` text to describe all three segments (currently "Off · no AI. Preview · sample output, clearly labeled." → add Live), so the radiogroup's `aria-describedby` stays accurate.

## 8. Data flow (the reachable states)

| State | Backend | Card |
|---|---|---|
| Off / Preview | seam = Noop / Placeholder | hidden / sample (unchanged) |
| **Live, consented, subscribed** | real summarizer → 200 | loading → summary |
| **Live, consented, not subscribed** | D111 → 204 | hidden |
| **Live, not consented** | predicate → Noop → 204; `disabledReason="consent-required"` | hidden; selecting Live (re-)opens the modal |

**Accepted P1a gap (named):** the not-subscribed, not-consented, and provider-failure cases all render an identical hidden card — the user gets no signal distinguishing "working, nothing to show" from "broken." This is the subject of the §13 open decision; absent that, it is an explicitly accepted P1a limitation.

## 9. Error handling & accepted limitations

- **Provider failure/timeout** ⇒ `LlmProviderException` ⇒ null ⇒ 204 ⇒ card hidden. **Never 500.** (See §13: whether to surface a minimal error+Retry instead of silent hide.)
- **Token-tracker write failure** ⇒ logged, non-fatal.
- **Disclosure fetch failure** ⇒ modal error, cannot consent — **fail-closed**.
- **Accepted: base-rebase staleness (R2, roadmap-rated High).** Cache keyed `(prRef, headSha)`; a base rebase leaving `headSha` unchanged can serve a stale summary until process restart. **A GitHub tracking issue for P1b (R2 `(prRef, baseSha, headSha)` keying + base-change eviction, plus the other deferred P1b items) MUST be filed and referenced before P1a merges** — so a High risk is not left open without an enforcement trail.
- **Accepted: consent-revocation TOCTOU (one-call window).** Consent is read at seam-resolve time; egress happens ~10s later inside `CompleteAsync`. A revocation in that window lets one in-flight call complete. Blast radius is a single call; accepted under the local-desktop threat model (consistent with the base-rebase acceptance).
- **Accepted: ~10s latency, no streaming.** Loading affordance covers it.

## 10. Security

- **Egress consent is backend-enforced** via the predicates (§5), not a cosmetic FE gate. Direct-POST-to-Live cannot egress without a record. The consent predicate and the seam registration ship in **one PR** (§1).
- **All author-controlled inputs sanitized:** diff, title, **and** description via `PromptSanitizer.WrapAsData`.
- **Prompt-injection battery** runs against the **real provider invocation path** — i.e. the combined (`--append-system-prompt` keeps Claude Code's default identity in front) prompt as `ClaudeCodeLlmProvider` produces it, not an isolated fragment — and includes injection payloads in the **diff, the title, and the description**, plus a delimiter-escape attempt against `WrapAsData`.
- **Token-usage records carry no prompt text / secrets** (existing shape).

## 11. Testing strategy

**Backend (xUnit + FluentAssertions, `PRismWebApplicationFactory`):**

- `ClaudeCodeSummarizer` unit — cache hit ⇒ 0 provider calls; diff+title+description each sanitized; `ITokenUsageTracker.RecordAsync(feature:"pr-summary")`; injection in diff/title/description does not corrupt; delimiter-escape attempt neutralized; provider exception ⇒ null; snapshot-absent-on-first-view ⇒ a stable cache key still resolves.
- Consent — predicate unit tests on **both** the selector delegate and the resolver `Capable`/`DisabledReason`: Live + available + no consent ⇒ false + `consent-required` + Noop; + consent ⇒ true + real; disclosure-version mismatch invalidates; **provider-id mismatch invalidates (predicate unit test, not an integration fixture — no switch UI exists)**; reason-precedence (probe-unavailable **and** unconsented ⇒ provider reason wins).
- `/ai/summary` integration — **204** not-subscribed (D111); **204** Live-but-unconsented (zero egress, blocking exit criterion); **200** Live + consented + subscribed; Off ⇒ 204; **summary fetch arriving before subscription registers ⇒ recovers once subscribed** (the cold-open race).
- Endpoints — `/api/ai/consent` records (204), stale version ⇒ 409; `/api/ai/egress-disclosure` returns recipient/categories/version/`alreadyConsented`; **both return 401 without a session token; `POST /api/ai/consent` returns 403 with a missing Origin.**
- `ConfigStore.RecordAiConsentAsync` round-trip + `AiConsentState` mirror on `Changed` + **concurrent-write safety** + legacy-config load (no NRE when `AiConsent` absent on disk).

**Frontend (Vitest + RTL — placement rule: new components get co-located `src/**/*.test.tsx`; the legacy `frontend/__tests__/` mirror is updated only where it already covers a modified unit, e.g. the `useAiSummary` mocks):**

- `AppearancePane` — Live segment renders; selecting Live (`alreadyConsented:false`) opens the modal and does **not** POST `live` or advance the control; (`alreadyConsented:true`) POSTs `live` directly; off/preview unchanged + no-op guard; Decline returns focus to the prior segment.
- `EgressConsentModal` — loading (skeleton, buttons disabled), error (fail-closed), Accept ⇒ consent POST then mode POST, Decline ⇒ no POST, non-204 ⇒ generic failure + revert; default focus on Decline; `aria-describedby` present.
- `useAiSummary`/`AiSummaryCard` — loading affordance during fetch; gated on subscription-established; renders summary; empty `Category` ⇒ no label; hides on failure.

**e2e (Playwright):** Live + consent happy path (select Live → modal → Accept → summary); Decline path (no summary, segment unchanged).

## 12. Exit criteria

**P1a (this slice):**
- Real summary within ~10s for a ~200-line PR; provider call count **1** on miss, **0** on in-memory cache hit.
- Flag off ⇒ 204; **Live + no consent ⇒ 204 with zero egress** (blocking); not-subscribed ⇒ 204; cold-open subscription race recovers.
- Injected `IGNORE PREVIOUS INSTRUCTIONS…` in diff/title/description does not corrupt output.
- Consent recorded gates Live end-to-end; declining leaves mode unchanged.
- The PR3a sequencing risk is **closed**: consent guard + first real seam in one PR.

**Deferred to P1b — and the roadmap §P1 governance gate depends on them (roadmap: "the dogfood signal gates on P1b"), so merging P1a does NOT clear the P1→P2 gate:** `cache_read_input_tokens > 0` (measured prompt-cache hit), `ActivePrUpdated` eviction + regenerate, base-rebase eviction (R2), head-shift-mid-call leaves no stale entry, stale-badge + Regenerate UX. *(Whether `ITokenUsageTracker` should already capture `cache_read_input_tokens` in P1a — so P1b can measure without a schema change — is a plan-phase question; the field exists on `LlmResult` today.)*

## 13. Open decision (resolve with user before planning)

**Should P1a include a minimal inline error + Retry affordance, instead of silently hiding the card on failure?** The product and design reviews both flag that this is PRism's first real-AI feature and the source of the dogfood trust signal; a provider timeout right after a deliberate consent ceremony renders as "the feature is broken," and dogfood feedback ("AI didn't show up") becomes uninterpretable because failure and genuine-absence look identical. Surfacing `{ error }` alongside the `{ summary, loading }` refactor already in scope is a small delta; full Regenerate + stale-badge stays P1b. **Recommendation: pull a minimal error+Retry into P1a.** This expands the scope the user originally bounded (which deferred "Regenerate UX"), so it needs explicit sign-off.
