# AI Seam Architecture

The PoC ships **zero AI features**, but it ships every architectural seam that v2 AI features require so that v2 can light up features by **registering different DI implementations and flipping capability flags**. What's preserved across PoC → v2 is **the interface boundary**: no `IReviewService` reshape; no `IReviewContext` rewrite; no DI-graph upheaval; no frontend slot-position changes; no PR-detail or inbox layout reflow at the structural level (per-slot vertical-space changes when a slot lights up are expected — see "Honest layout-reservation policy" below). What is *not* universally preserved: the internal shapes of placeholder DTOs in **`PRism.AI.Contracts`**. Some will reshape between PoC and v2 (`ComposerSuggestion`'s `Notes` field already did, ahead of P2-1; enum widening for severity types is similarly permitted). Each reshape is an explicit per-feature contract change, flagged in the relevant backlog item, applied in `PRism.AI.Contracts` ahead of (not during) the v2 feature. See § "DTO catalogue — declared in PoC" for the refined contract.

**The PoC commits to the full seam scaffolding.** Every interface listed below ships with a `Noop*` default implementation registered in DI; every frontend slot exists in the component tree gated by capability flags. This is what the DoD checklist enforces (`spec/01-vision-and-acceptance.md` § Architectural). The seam scaffold itself is roughly **2–3 weeks** of work for one developer (see "A note on PoC effort" below for the breakdown) — not the dominant cost of the PoC, but not free either. v2 lights up most features by registering a different DI implementation and flipping a capability flag; **some features may require additive or breaking changes to the placeholder DTOs in `PRism.AI.Contracts`**, applied as a coordinated contract update *ahead of* (not during) the v2 feature. What the seam protects is the *interface boundary* (`IReviewService`, `IReviewContext`, `IReviewEventBus`, the per-feature service interfaces, the frontend slot positions, the DI graph) — not every internal detail of every DTO crossing it. See "DTO catalogue — declared in PoC" below for the refined contract; the practical effect is that contract reshapes are localized to one assembly (`PRism.AI.Contracts`) instead of threading through `PRism.Core` per feature.

**A note on PoC effort.** Earlier drafts of this section anchored the schedule to a "~250–300 line" or "~1500–3000 line" estimate of the AI seam scaffold. Both are honest about the seams *in isolation* and misleading about the PoC as a whole. Auditing the DoD against the listed work — full GitHub provider (Octokit + GraphQL pending-review pipeline + iteration clustering + rate-limit-aware polling + Search/Checks/Statuses APIs + comment fetch); the resumable submit state machine with foreign-pending-review prompt and commitOID-mismatch handling; the seven-row stale-draft reconciliation algorithm; the React frontend (file tree, side-by-side + unified diff with word-level highlighting, comment threads, composer with markdown preview, iteration tabs with right-click merge/split, Compare picker, reconciliation panel, submit modal, inbox sections with banners); the markdown stack (react-markdown v9 + remark-gfm + Shiki 16-grammar subset with lazy-load + Mermaid v11 with theme switching + sanitization + `urlTransform` allowlist); ASP.NET Core minimal API (a dozen endpoints), SSE channel with backpressure timeout, MSAL keychain with platform caveats, lockfile with PID liveness, JSON state migration framework + forward-compat test, hot-reload config, append-only forensic log; cross-platform browser launcher, port-selection retry, CSRF cookie + Origin defense; self-contained binary builds for win-x64/osx-arm64 (osx-x64 dropped — see `01-vision-and-acceptance.md` DoD); **plus** automated tests for the submit pipeline, reconciliation algorithm, and migration framework that the DoD now requires — **realistic effort is on the order of 5–8 months for one full-time senior developer**. Earlier "3–5 months" wording understated by ~2× and would make a maintainer commit to a Q1–Q2 timeline they will hit in Q3. (The earlier list also included a "provider-abstraction stub" line item; that has been dropped along with the abstraction. The stub was a small fraction of the work — ~1 week — so the 5–8 month band is unchanged after removing it; the band was deliberately sized wide enough to absorb item-level swings.) The AI seam scaffold itself is roughly **2–3 weeks** of those months (16+ `Noop*` classes + ~25 placeholder DTOs + 9 frontend slots + DI registration + capability registry + tests; 1 work-week is the floor only if the contracts are stable and DI patterns are familiar).

**Why not down-scope the seams.** A bare-minimum alternative — ship only the headline interfaces (`ILlmProvider`, `IStreamingLlmProvider`, `IAiFeatureFlags`, `IReviewContextFactory`, `IReviewEventBus` + slot scaffold) and defer per-feature `Noop*` services to v2 — was considered and rejected. Reasons: (1) the DoD wording is hard to relax without weakening the "v2 doesn't reshape Core" promise; (2) the marginal cost of a `Noop*` implementation is small (a class with empty methods, ~5–10 LOC); (3) deferring forces v2 to thread DI changes through Core while shipping each feature, which is exactly the friction the seams are meant to remove.

---

## Core principle

**The frontend never calls LLMs.** The backend owns all AI calls. The frontend asks the backend "is feature X available?" via a capability registry, hides the UI when not, renders results when yes. v2 plugs in by registering different DI implementations and flipping capability flags — no frontend changes required.

---

## Backend seams

All seams live in `PRism.Core`. None of these reference Octokit, Claude Code, or any external LLM library — those concrete implementations live in dedicated provider/integration projects added in v2.

### `IReviewContext` — read-only context for AI features

The single interface every AI feature consumes to inspect the current review.

```csharp
public interface IReviewContext
{
    Pr CurrentPr { get; }
    PrIteration[] Iterations { get; }
    FileChange[] Diff { get; }
    ExistingComment[] ExistingComments { get; }
    DraftReview CurrentDraft { get; }
    Task<string> GetFileContentAsync(string path, string sha, CancellationToken ct);
}
```

Implemented in PoC as a real service (`ReviewContextProvider`) that gathers data from the `IReviewService`, `IAppStateStore`, and on-demand file fetches. Used in PoC by zero AI features but the implementation is exercised by tests.

**Lifetime: singleton factory, per-call contexts.** `IReviewContextFactory` is registered as a singleton; `For(prRef)` returns a fresh `IReviewContext` value per call, bound to that `PrReference`. The factory holds no per-request state; the returned context holds its own snapshots gathered at the moment of the call. AI services that consume `IReviewContextFactory` may be registered as singletons themselves — there is no captive-dependency hazard because the factory is a singleton and the *contexts* it produces are short-lived values, not DI-scoped instances.

```csharp
services.AddSingleton<IReviewContextFactory, ReviewContextFactory>();
// usage in any AI service (also a singleton):
var ctx = factory.For(prRef);   // fresh context value bound to that PrReference
```

This shape avoids the captive-dependency problem an earlier draft of this spec introduced (singleton AI services + scoped factory + ASP.NET Core's `ValidateOnBuild`/`ValidateScopes` rejecting the registration) and matches PoC's actual concurrency model: one PR active at a time, occasional concurrent reads on the same PR. P4-F6 (multi-PR tabs) is supported because each call to `For(prRef)` is independent — no shared scope hides PR identity in the factory.

**Lifetime model with chat sessions.** Chat sessions (`IPrChatService`, P2-2) are long-lived — the user opens the drawer, types for 20 minutes, leaves and comes back. Chat **calls `factory.For(session.PrRef)` at the start of each user turn** and uses the returned context for that turn. The benefit is that chat sees up-to-date PR state across long sessions, including new comments and new iterations that arrived while the user was thinking. Snapshotting once at session-open would be cheaper but stalls the chat against stale data — unacceptable for "what does the latest iteration change?" questions.

**Caching ownership for the per-turn snapshot — owned by chat (P2-2), not by `IReviewService`.** `IReviewService` (defined in `02-architecture.md`) is intentionally **un-cached**: every method hits the GitHub API. A "small cost per turn" claim earlier in this doc was misleading — without a caching layer somewhere, every chat turn refetches PR detail, comments, iterations, and the diff, which is a tens-of-API-calls-per-turn cost on a long chat. The PoC seam exposes the *un-cached* GitHub access; the *chat session* (P2-2) owns its caching strategy:
- Chat caches PR detail / comments / iterations / diff per `(prRef, head_sha)` for the lifetime of the session in memory.
- The cache invalidates when `head_sha` shifts (which is also when the head-shift system message is injected; the two events share a trigger).
- The chat code subscribes to `IReviewEventBus.PrUpdated(prRef, newHeadSha)` to detect shifts.
- The cache is per-chat-session, not global — concurrent sessions on the same PR share underlying GitHub responses through HTTP-client-level caching (out of scope for the seam) but each session owns its `IReviewContext` snapshots independently.

The placement is deliberate: the caching strategy is chat-specific (per-session lifetime, head-shift invalidation, in-memory). Pushing it into `IReviewService` would impose chat's strategy on every other consumer (the inbox poller, the active-PR poller, the submit pipeline) that has different invalidation needs. The cost is that P2-2 carries ~50 lines of caching code; the benefit is a clean, single-purpose `IReviewService`.

**Honest acknowledgment: head-changes mid-session can produce confusing answers.** A chat answer in turn N may reference code that's no longer present at turn N+1 because the head SHA moved between turns. The user asks "why does this method use a switch statement?", a force-push between their turn and the next removes the switch, and the model's "explain that switch" reference is now nonsensical. The chat drawer surfaces a small banner inside the drawer when `head_sha` changes mid-session: *"PR head moved during this chat — answers from earlier turns may reference code that's no longer present."* The banner is informational; it does not auto-reset the chat or force a refresh (that would violate banner-not-mutation). The user can explicitly start a new chat or press a "refresh context" affordance inside the banner.

**The model itself is also told.** The user-facing banner is necessary but not sufficient — the model carries facts derived from old code in its working memory, and unless explicitly informed, may answer follow-ups under the assumption that earlier-turn references are still accurate. When the chat detects a `head_sha` shift between turns, **the next user turn's prompt is prefixed with a system-message-style note**: *"[Note: the PR's head moved at turn N (and any prior shifts at turns X, Y if applicable). Code referenced in earlier turns may not match the current state. When the user's question refers to earlier-turn answers, verify against the diff for the new head before responding.]"* The injection is mechanical, cheap (~50 tokens), and the kind of context-awareness the model handles well when surfaced explicitly. It does not violate any "model autonomy" property — chat is always a function of the prompt, and the prompt is the host's to compose.

**Cumulative shifts.** When *multiple* shifts occur in a session (e.g., the PR receives commits at turns 3 and 7), the orchestrator tracks the list of shift turns in `aiState.chatSessions[<id>]` and includes the full list in each subsequent turn's prefix until a fresh-session reset clears it. Pre-pending the latest shift only would leave the model unaware that turn-1 references were already stale before turn 4 — leading to confident-but-wrong answers. The list is short in practice (most chats see 0 or 1 shifts; long sessions across multiple iterations might see 3–5), so the cumulative cost is bounded.

Implementation: the chat orchestrator tracks `(headShaAtSessionStart, shifts: [{turnIndex, fromSha, toSha}])` and re-checks before sending each user turn; when a new change is detected, append to the list and prepend the cumulative-shift note on that turn and every subsequent turn until the chat session ends. Subsequent turns without a new shift continue to carry the last-known cumulative note (the model needs the reminder, not just on the shift turn). On a fresh state-2 session (e.g., after `request_repo_access`), the shift list resets — the system prompt's prior-conversation injection covers continuity, and the model in the new session has no working memory of pre-shift code to defend against.

**Verification gate (before P2-2 ships).** This injection's effectiveness is empirically untested. Add to the C-track verification discipline: send a chat turn referencing prior code, inject the head-shift note, ask a follow-up that depends on the now-stale earlier reference, observe whether the model defers to the new code or hallucinates from memory. Run against a reference Claude model (Opus 4.7 at minimum) before P2-2 lands. If the model ignores the note and confidently re-uses pre-shift references, the design needs to escalate (e.g., an explicit "pre-shift answers are now invalidated; please re-derive from current diff" assertion, or a fresh session on every shift). Document the observed behavior in `00-verification-notes.md` § C8 (new entry, see below) and adjust this section accordingly.

### `ILlmProvider` and `IStreamingLlmProvider` — LLM access

Two interfaces for one-shot vs sustained chat:

```csharp
public interface ILlmProvider
{
    string ProviderId { get; }                                   // "claude-code", "anthropic-api", "ollama"
    Task<LlmResponse> CompleteAsync(LlmRequest req, CancellationToken ct);
}

public interface IStreamingLlmProvider
{
    string ProviderId { get; }
    IStreamingLlmSession StartSession(StreamingSessionOptions opts);
}

public interface IStreamingLlmSession : IAsyncDisposable
{
    // The underlying provider's session ID — load-bearing for `--resume` cross-restart persistence.
    // For Claude Code, this is the session ID Claude Code itself reports at session start; v2 persists it
    // in `state.json.aiState.chatSessions[<prismSessionId>].claudeCodeSessionId`.
    string ProviderSessionId { get; }

    Task SendUserTurnAsync(string content, CancellationToken ct);
    IAsyncEnumerable<LlmEvent> Events { get; }

    // Cleanly end the session at a turn boundary. The implementation flushes any in-flight output, waits
    // for an `LlmResult` event signaling the current turn is complete (up to `gracefulShutdownTimeout`),
    // then sends the underlying provider a clean exit signal. Sets the session's `lastTurnEndedCleanly`
    // state to `true`. After a clean end, the session can be resumed by passing the same `ProviderSessionId`
    // back via `StreamingSessionOptions.ResumeSessionId` on a subsequent `StartSession` call.
    //
    // If the timeout elapses without a clean turn boundary (rare but possible for very long generations),
    // falls back to forced termination and reports `lastTurnEndedCleanly = false`. Sessions ended this way
    // are not resumable per [verification-notes § C4](./00-verification-notes.md#c4)'s dangling-tool-use
    // finding; the chat path then falls back to "fresh session + conversation-log injection as system-prompt
    // context" instead.
    Task<SessionEndState> EndCleanlyAsync(TimeSpan gracefulShutdownTimeout, CancellationToken ct);
}

public record SessionEndState(bool LastTurnEndedCleanly, string ProviderSessionId);

public record LlmRequest(string Prompt, string? SystemPrompt = null, string? Model = null);
public record LlmResponse(string Body, TokenUsage? Usage);
public record TokenUsage(int InputTokens, int OutputTokens, int? CacheCreationInputTokens = null, int? CacheReadInputTokens = null);
public record StreamingSessionOptions(
    string? WorkingDirectory = null,
    string[]? AllowedTools = null,
    string[]? DisallowedTools = null,
    string[]? AddDirs = null,
    string? ResumeSessionId = null,
    string? McpConfigPath = null);                  // path to JSON consumed by `claude --mcp-config`; populated by v2 chat to register the host's MCP server. See [verification-notes § C3](./00-verification-notes.md#c3).

public abstract record LlmEvent;
public record LlmTextDelta(string Text) : LlmEvent;
public record LlmToolUse(string ToolName, JsonElement Input) : LlmEvent;
public record LlmResult(string FullText, TokenUsage? Usage) : LlmEvent;
```

PoC ships a single concrete implementation: `NoopLlmProvider` returning empty results. v2 adds:
- `ClaudeCodeLlmProvider` — shells out to the Claude Code CLI for both interfaces (see "Claude Code integration" below).
- Optionally `AnthropicApiLlmProvider`, `OllamaLlmProvider`.

**Honest framing: `StreamingSessionOptions` is shaped for Claude Code.** The fields `AddDirs`, `AllowedTools`, `DisallowedTools`, `ResumeSessionId`, `McpConfigPath` are all Claude-Code-specific concepts. `AnthropicApiLlmProvider` (HTTP API, no `--add-dir`) and `OllamaLlmProvider` (no MCP) would have to ignore most of these or implement awkward shims. The "substrate-neutral" interface name reads as a contract that the type cannot actually deliver across substrates without reshape. **PoC and v2's shipped substrate is Claude Code**; the multi-substrate framing is aspirational and the interface is shaped accordingly. If a second substrate ever ships (P4-N4 Ollama is the closest current candidate), `StreamingSessionOptions` will need to refactor into a discriminated union of substrate-specific opts (`ClaudeCodeStreamingSessionOptions`, `OllamaStreamingSessionOptions`, …) — that is a coordinated contract change in `PRism.Core` ahead of the second substrate's feature, consistent with the per-feature reshape policy in § "DTO catalogue — declared in PoC." This is documented now so the reshape, if it happens, is not surprising.

### Per-feature service interfaces

Each AI capability is a separate service interface. v2 implements each by composing `IReviewContext` + `ILlmProvider` (and possibly `IAiCache` and `IRepoCloneService`).

```csharp
public interface IPrSummarizer
{
    Task<PrSummary> SummarizeAsync(IReviewContext ctx, SummaryScope scope, CancellationToken ct);
}
public enum SummaryScope { WholePr, Iteration }

public interface IFileFocusRanker
{
    Task<FileFocusScore[]> RankAsync(IReviewContext ctx, CancellationToken ct);
}

public interface IHunkAnnotator
{
    Task<HunkAnnotation[]> AnnotateAsync(IReviewContext ctx, CancellationToken ct);
}

public interface IPrChatService
{
    IStreamingLlmSession StartChatSession(IReviewContext ctx, ChatSessionOptions opts);
}

public interface IInboxRanker
{
    Task<RankedInboxSection[]> RankAsync(InboxSection[] sections, CancellationToken ct);
}

public interface IInboxItemEnricher
{
    Task<InboxItemEnrichment[]> EnrichAsync(PrInboxItem[] items, CancellationToken ct);
}

public interface IComposerAssistant
{
    Task<ComposerSuggestion> RefineAsync(ComposerRefinementRequest req, CancellationToken ct);
}

public interface IDraftCommentSuggester
{
    Task<DraftCommentSuggestion[]> SuggestAsync(IReviewContext ctx, CancellationToken ct);
}

public interface IDraftReconciliationAssistant
{
    Task<ReconciliationSuggestion> SuggestAsync(IReviewContext ctx, DraftComment staleDraft, CancellationToken ct);
}

public interface IPreSubmitValidator
{
    Task<ValidationResult[]> ValidateAsync(IReviewContext ctx, DraftReview review, CancellationToken ct);
}
```

PoC ships a `NoopXxx` for each, registered in DI by default. They return empty arrays / null results. v2 swaps them for real implementations.

### DTO catalogue — declared in PoC

Every DTO mentioned in a PoC seam-interface signature **is declared in PoC** as a placeholder record. This is the only consistent posture: the interfaces use strong return types, the `Noop*` implementations return `default(T)` or empty collections, and v2 features populate the records with real values. Adding new optional properties to a record in v2 is non-breaking; *reshaping* signatures would be a Core change the spec doesn't permit.

The DTOs ship in two assemblies:
- **`PRism.AI.Contracts`** — AI-seam types referenced from PoC seam interfaces, declared as placeholders. `Noop*` implementations return defaults.
- **Per-feature project (v2 only)** — internal types specific to one AI feature; never crosses an interface boundary; not seamed.

(`PRism.Core.Contracts` carries the *provider* DTOs — `Pr`, `FileChange`, `DraftReview`, `PrReference`, `Verdict`, `ExistingComment`, etc. — referenced from `IReviewService`. AI types do not live there. See `02-architecture.md` § "Core DTOs (in `PRism.Core.Contracts`)" for the provider list.)

```csharp
// PRism.AI.Contracts — placeholder shapes declared in PoC; v2 populates.
// Each record carries the fields the v2 implementation needs; v2 may add fields (additive, non-breaking).

public record PrSummary(string Body, TokenUsage? Usage, SummaryScope Scope);              // for IPrSummarizer
public enum SummaryScope { WholePr, Iteration }
public record FileFocusScore(string Path, FocusLevel Level, string Rationale);            // for IFileFocusRanker
public enum FocusLevel { High, Medium, Low }
public record HunkAnnotation(string StableId, string FilePath, int LineOffsetWithinHunk,  // for IHunkAnnotator
                             AnnotationSeverity Severity, string Message);
public enum AnnotationSeverity { Info, Suggestion, Concern }
public record ChatSessionOptions(PrReference PrRef, bool PersistAlwaysAllow);             // for IPrChatService — the v2 P2-2 implementation will widen this with TTL, PAT fingerprint, granted-at, and scope; flagged in the contract-evolution policy
public record RankedInboxSection(string SectionId, RankedPrInboxItem[] Items);            // for IInboxRanker
public record RankedPrInboxItem(PrInboxItem Pr, double RankScore, string RankReason);
public record InboxItemEnrichment(string PrId, string? CategoryChip, string? HoverSummary); // for IInboxItemEnricher
public record ComposerSuggestion(string RefinedBody, ComposerNote[] Notes, string? RefinementRationale = null); // for IComposerAssistant
public record ComposerNote(NoteSeverity Severity, string Message);
public enum NoteSeverity { Info, Suggestion, Concern }
public enum RefinementMode { Clarity, Validate, Both }
public record ComposerRefinementRequest(string OriginalBody, ComposerContext Context, RefinementMode Mode);
public abstract record ComposerContext;
public record InlineCommentContext(string FilePath, int LineNumber, string AnchoredLineContent, string SurroundingHunk) : ComposerContext;
public record ReplyContext(string ParentThreadId, string ParentBody) : ComposerContext;
public record PrSummaryContext(Verdict CurrentVerdict) : ComposerContext;
public record DraftCommentSuggestion(string FilePath, int LineNumber, string ProposedBody, string Rationale); // for IDraftCommentSuggester
public record ReconciliationSuggestion(string DraftId, ReconciliationAction SuggestedAction, string Explanation); // for IDraftReconciliationAssistant
public enum ReconciliationAction { KeepAsIs, Reanchor, Discard, Edit }
public record ValidationResult(ValidationSeverity Severity, string Message, string? SuggestedAction); // for IPreSubmitValidator
public enum ValidationSeverity { Info, Suggestion, Concern, Blocking }
```

These declarations live in their own assembly **`PRism.AI.Contracts`**, separate from `PRism.Core.Contracts`. The split is structural (project boundary, not just folder convention) so that the GitHub project — which only needs the provider DTOs in `PRism.Core.Contracts` — cannot accidentally reference AI types. The dependency direction is one-way: AI projects (`PRism.AI.*`) reference both contracts assemblies; `PRism.GitHub` references only `PRism.Core.Contracts`. v2 features include `PRism.AI.Contracts` and populate the records with real values.

(The naming parallels the `PRism.AI.*` per-feature projects rather than extending the `PRism.Core.Contracts` namespace prefix; the earlier `PRism.Core.Contracts.Ai` reads as a sub-namespace of `PRism.Core.Contracts` rather than a sibling, which confuses every new contributor about which is the parent assembly. Earlier wording also placed both DTO sets in a single `PRism.Core.Contracts/Ai/` folder under one assembly; that arrangement preserved the *appearance* of separation without enforcement, since C# does not bind subfolder to sub-namespace by language rule.)

**The "additive-only" promise — refined.** Earlier wording said "v2 features may add fields (additive, non-breaking)." That promise turns out to be too strong: when a v2 implementer has actual prompt outputs to fit, some placeholder records will need to reshape. Concretely:

- `ComposerSuggestion.Notes` was originally `string`; `ComposerNote[]` (with severity) is the shape the P2-1 implementation actually needs. **This is a reshape**, not an addition. The PoC catalogue here has been updated to declare the v2 shape directly, so the reshape happens once before v2 starts rather than mid-stream.
- Enum extensions (`AnnotationSeverity`, `NoteSeverity`, `ValidationSeverity`) cannot be additive — C# enums are not extensible. If v2 risk-scoring (P2-10) needs `Critical`/`Security`, the enum is widened in PoC's contracts ahead of time, and code that switches on it is updated. This is a Core change but a localized one.
- `ValidationResult.SuggestedAction` is `string?` for PoC clarity; v2 may want a structured `ValidationAction` (link to file, suggested edit). That reshape would break the PoC `Noop*` and would need a coordinated swap of the contract type + impl.

**Refined contract.** "PoC declares the *interface signatures* (method shapes, return type names) and the v2 implementations populate the placeholder DTOs. New methods on existing interfaces are additive. Adding new optional properties to a placeholder record is additive. Reshaping a placeholder record (`string` → `record[]`, enum widening, swap to a discriminated union) is permitted but counts as an explicit per-feature contract change — flagged in the corresponding backlog item, applied in `PRism.Core.Contracts` ahead of (not during) the v2 feature, with a migration note here." This is weaker than the original promise but honest: the seam protects the *interface boundary*, not every internal detail of every DTO crossing it.

**Why declare placeholders in PoC rather than defer.** Earlier draft suggested typing seam returns as `object?` until v2 declared the strong types. That's a different design — `Task<object?>` to `Task<PrSummary>` is a breaking signature change at every consumer site, far more disruptive than reshaping a single record's internal fields. The placeholder-record approach keeps signatures stable; reshape risk is contained to per-DTO updates.

### `IAiCache` — caching layer for AI calls

(Renamed from `IAugmentationCache` to `IAiCache` for naming consistency with the rest of the AI seam vocabulary — `IAiFeatureFlags`, `ai.*` capabilities, `PRism.AI.*` projects. The implementation type renames similarly: `NoopAiCache`. The rename is *committed* — there is no `[Obsolete]` alias retained; PoC ships only `IAiCache`. Backlog references in `01-P0-foundations.md` (P0-2) and the dependency graph in `00-priority-methodology.md` use the new name as well.)

```csharp
public interface IAiCache
{
    Task<T?> GetAsync<T>(string cacheKey, CancellationToken ct);
    Task SetAsync<T>(string cacheKey, T value, TimeSpan ttl, CancellationToken ct);
    Task InvalidateAsync(string cacheKeyPrefix, CancellationToken ct);
}
```

Cache key convention: `<feature>:<provider>:<pr_ref>:<head_sha>:<input_hash>`. On new iteration, `head_sha` changes, cache invalidates naturally. The `InvalidateAsync(prefix)` method exists for `IReviewEventBus` subscribers to invalidate on PR-update events.

PoC ships `NoopAiCache` returning null on all reads. v2 implements file-based or in-memory cache.

### `IAiFeatureFlags` — AI feature-flag registry

```csharp
public interface IAiFeatureFlags
{
    bool IsEnabled(string featureId);
    IDictionary<string, bool> GetAll();
}
```

(Renamed from `IAugmentationCapabilities` for naming consistency with the rest of the AI seam vocabulary — `PRism.AI.*` projects, `ai.*` capabilities. Earlier wording also justified the rename as disambiguation from a `ProviderCapabilities` type from the multi-provider abstraction; that type has been dropped along with the abstraction, so the disambiguation rationale is moot, but the cleaner name stands.)

**Resolution rule.** A capability is reported as enabled (`IsEnabled("ai.summary") == true`) **iff all of the following hold**:

1. The corresponding service interface (`IPrSummarizer` for `ai.summary`, etc.) is registered in DI with a **non-noop** implementation. Detection is via a **marker interface `INoopAiService`** (or attribute `[NoopAiService]`) on every `Noop*` class. `ConfigDrivenAiFeatureFlags` checks `service is INoopAiService` rather than matching on the type name's `Noop` prefix. The marker-interface mechanism keeps the capability gate type-safe and rename-safe — a future v2 implementer who renames `NoopPrSummarizer` to `EmptyPrSummarizer` for stylistic reasons does not silently break the gate (the marker survives the rename; a name-prefix check would not).
2. The config's per-feature `enabled` flag is `true` (`config.llm.features.summary.enabled`).
3. The configured `ILlmProvider`'s runtime availability probe succeeded. For Claude Code, that is the `claude --version` + no-op authenticated probe described under "Capability detection." For an `AnthropicApiLlmProvider` it would be a successful credential check against the Anthropic API; for an `OllamaLlmProvider` it would be a successful local-server reachability probe. The clause is provider-agnostic; "is the configured LLM substrate up and reachable?" is the question. (Earlier wording hardcoded `claudeCodeAvailable` and would have falsely failed for Ollama or Anthropic-API substrates per P4-N4.)

If any of these is false, the capability reports disabled. The rationale for AND rather than OR: disabling either the impl or the config flag should turn the feature off without ambiguity. The most common failure mode this prevents is "user enables `summary` in config but the v2 build hasn't shipped `IPrSummarizer` yet" — without the AND, the UI would render the slot and call into a no-op service, producing empty results that confuse the user. With the AND, the slot stays hidden until the implementation is actually wired up.

**PoC behavior.** Clause 3 is consulted only when clauses 1 and 2 both pass. In PoC clause 1 is always false (every implementation is `Noop*`), so clause 3 is never consulted and `claudeCodeAvailable` may remain unset. (Earlier wording introduced "vacuously true" three-valued logic; that was unnecessary — the short-circuit on clause 1 makes clause 3's value irrelevant in PoC, period.)

The capability IDs used in PoC and reserved for v2:

| Capability ID | What enables it in v2 |
|---|---|
| `ai.summary` | `IPrSummarizer` registered with non-noop impl |
| `ai.fileFocus` | `IFileFocusRanker` registered with non-noop impl |
| `ai.hunkAnnotations` | `IHunkAnnotator` registered with non-noop impl |
| `ai.chat` | `IPrChatService` + Claude Code installed |
| `ai.inboxRanking` | `IInboxRanker` registered with non-noop impl |
| `ai.inboxEnrichment` | `IInboxItemEnricher` registered with non-noop impl |
| `ai.composerAssist` | `IComposerAssistant` registered with non-noop impl |
| `ai.draftSuggestions` | `IDraftCommentSuggester` registered with non-noop impl |
| `ai.draftReconciliation` | `IDraftReconciliationAssistant` registered with non-noop impl |
| `ai.preSubmitValidators` | `IPreSubmitValidator` registered with non-noop impl |

Capability registry is exposed via `GET /api/capabilities` returning a flat object:

```json
{
  "ai.summary": false,
  "ai.fileFocus": false,
  ...
}
```

In PoC, **every `ai.*` flag is `false`**.

### `IReviewEventBus` — pub/sub for state changes

```csharp
public interface IReviewEventBus
{
    void Publish<TEvent>(TEvent evt) where TEvent : IReviewEvent;
    IDisposable Subscribe<TEvent>(Action<TEvent> handler) where TEvent : IReviewEvent;
}

public interface IReviewEvent { }

public record PrUpdated(PrReference Pr, string NewHeadSha) : IReviewEvent;
public record InboxUpdated(string[] ChangedSectionIds) : IReviewEvent;
public record DraftSubmitted(PrReference Pr) : IReviewEvent;
public record DraftDiscarded(PrReference Pr, string DraftId) : IReviewEvent;
public record DraftSaved(PrReference Pr, string DraftId) : IReviewEvent;
public record StateChanged(PrReference Pr, string[] FieldsTouched) : IReviewEvent;          // umbrella event for the multi-tab consistency channel
public record RepoAccessRequested(string SessionId, PrReference Pr, string Reason, long? RepoSizeBytes) : IReviewEvent;
```

In PoC, the event bus is implemented as a simple in-process pub/sub. Used by:
- The polling pipeline (publishes `PrUpdated` / `InboxUpdated`)
- The state-mutation endpoints (publish per-event types `DraftSaved` / `DraftDiscarded` / `DraftSubmitted` *and* a coarse `StateChanged(ref, fieldsTouched)` for the same write — both fire). Frontend tabs subscribe to whichever shape they need: most surfaces use the typed `Draft*` events; the multi-tab consistency reconciler in `02-architecture.md` § Multi-tab consistency uses `StateChanged` because it cares about *which fields* changed in aggregate, not the specific draft action.
- The frontend banner subscribers (via Server-Sent Events on `/api/events`)
- v2 AI services subscribe to invalidate caches on `PrUpdated`
- v2 chat sessions subscribe to `RepoAccessRequested` to surface `<RepoAccessRequestModal>`

**Subscriber policy: pick one shape, not both.** A single subscriber MUST pick *either* the typed events (`DraftSaved` / `DraftDiscarded` / `DraftSubmitted`) *or* the coarse umbrella (`StateChanged`), not both — both fire for the same write, so subscribing to both produces double-counts. A telemetry sink that wants every state mutation should subscribe to `StateChanged` only; a UI surface that animates a specific verb (e.g., "draft submitted" toast) should subscribe to `DraftSubmitted` only. The framework does not enforce the rule in code; it is a convention the PR-review of new subscribers checks. New event types added in v2 (e.g., a hypothetical `ChatTurnCompleted`) inherit the same rule: pick the typed event or the umbrella, not both.

### `IUserConsentChannel` — repo-access consent bridge

The bridge that lets the host (in v2; PoC ships a noop) ask the user "OK to give this chat read access to `<repo>`?" and waits for the answer. Called from the MCP server's `request_repo_access` tool dispatcher (P0-7), which routes the model's request through this channel to surface `<RepoAccessRequestModal>` on the frontend. Async TaskCompletionSource-based; the dispatcher awaits the user's choice before returning a tool_result to the model.

```csharp
public interface IUserConsentChannel
{
    Task<RepoAccessConsent> RequestRepoAccessAsync(RepoAccessRequest req, CancellationToken ct);
}

public record RepoAccessRequest(
    string SessionId,
    PrReference PrRef,
    string RepoFullName,                            // "acme/api-server" — for display
    long? RepoSizeBytes,                            // null if unknown; non-null triggers the size-warning copy in the modal
    bool ExistingLocalCloneFound,                   // if true, modal copy emphasizes "we'll use your existing clone via worktree"
    string? PRismCloneTargetPath);             // if no existing clone, the path PRism would clone INTO; modal shows it for transparency

public abstract record RepoAccessConsent;
public record RepoAccessAllowedOnce() : RepoAccessConsent;
public record RepoAccessAllowedAlways() : RepoAccessConsent;       // persist to aiState.alwaysAllowRepoAccess
public record RepoAccessDenied() : RepoAccessConsent;              // chat starts in state 1: no repo access
public record RepoAccessCanceled() : RepoAccessConsent;            // user closed the modal; chat does not start
```

**Lifetime: singleton.** The implementation publishes a `RepoAccessRequested` event on `IReviewEventBus` keyed by `SessionId`, and waits on a `TaskCompletionSource<RepoAccessConsent>` keyed by the same `SessionId`. The frontend renders `<RepoAccessRequestModal>` on receipt and resolves the request via `POST /api/chat/{sessionId}/repo-access` with the user's choice; the endpoint completes the TCS. Default timeout: 5 minutes (resolves to `RepoAccessCanceled` and surfaces a banner: *"chat-open canceled — consent modal timed out"*).

The async TCS shape is needed because the modal surfaces to the frontend over the SSE channel (the consent decision is a UI event, not a backend-internal one). The dispatcher in the MCP server's `request_repo_access` tool calls `RequestRepoAccessAsync` and awaits the user's answer; while waiting, the model's tool_use is in-flight (no other turns proceed). On answer, the dispatcher returns a `tool_result` to the model. (Across W29 and W31, the *call site* moved — W29 had this called at chat-bootstrap, W31 has it called from the MCP tool dispatcher mid-conversation — but the interface shape is the same.)

**PoC implementation**: `NoopUserConsentChannel.RequestRepoAccessAsync` returns `Task.FromResult<RepoAccessConsent>(new RepoAccessDenied())` immediately. The interface and record types are in PoC's seam catalogue so v2 can swap in the real implementation without reshaping.

### `IRepoCloneService` — repository cloning for v2 chat

```csharp
public interface IRepoCloneService
{
    // Workspace enumeration. Called at backend startup and on PR-detail-view mount (scoped to one repo).
    // Walks <localWorkspace>/*/ excluding .prism/, identifies user-owned clones via remote-URL match,
    // populates state.json.aiState.repoCloneMap. The single-repo overload is for PR-detail-view mount —
    // it scans only the entry that would resolve for this PR's repo, in case the user added it since startup.
    Task EnumerateWorkspaceAsync(CancellationToken ct);
    Task EnumerateWorkspaceForRepoAsync(PrReference prRef, CancellationToken ct);

    // Resolve <owner>/<repo> to a clone path (user-owned or PRism-created). Returns null if neither
    // exists yet — the caller (chat-bootstrap) decides whether to clone fresh.
    Task<RepoCloneEntry?> ResolveCloneAsync(PrReference prRef, CancellationToken ct);

    // Ensure a clone exists for this repo. If ResolveCloneAsync returns null, clones into
    // <localWorkspace>/.prism/clones/<owner>/<repo>/ (or <dataDir>/.prism/clones/... if
    // localWorkspace is null). Persists the result in repoCloneMap with ownership = "prism-created".
    Task<CloneResult> EnsureCloneAsync(PrReference prRef, CloneOptions opts, CancellationToken ct);

    // Ensure a worktree for this PR exists at <root>/.prism/worktrees/<owner>/<repo>/pr-<n>/, where
    // <root> is localWorkspace if set, else <dataDir>. Worktree lifetime is per-PR (not per-session): if it
    // already exists, just verify the worktree's HEAD matches the requested ref; if not, run worktree add.
    // The clonePath used as the object store is whichever ResolveCloneAsync returns (user-owned or
    // PRism-created).
    Task<WorktreeResult> EnsureWorktreeForPrAsync(PrReference prRef, CancellationToken ct);

    // Sync a worktree to the latest PR head. Called from the user's Reload flow. Runs git fetch under
    // refs/prism/pr-<n> + git reset --hard inside the worktree. No-op if worktree doesn't exist.
    Task SyncWorktreeAsync(PrReference prRef, CancellationToken ct);

    // Mark a worktree as eligible for cleanup. Called when polling detects a PR state flip to closed/merged.
    // Does not delete immediately — the audit (below) handles physical removal after a cooldown.
    Task MarkWorktreeForCleanupAsync(PrReference prRef, CancellationToken ct);

    // The cleanup audit. Scans the .prism/ tree, identifies worktrees on closed-PRs-older-than-7-days
    // and PRism-created clones with no recent PR activity. Returns the proposed cleanup; caller surfaces
    // the confirmation modal. Actual removal happens via ApplyCleanupAsync below.
    Task<CleanupAudit> AuditAsync(CancellationToken ct);
    Task ApplyCleanupAsync(CleanupSelection selection, CancellationToken ct);

    Task<long?> GetRepoSizeBytesAsync(PrReference prRef, CancellationToken ct);
    // Source data: GitHub `repos/{o}/{r}.size` is reported in **kilobytes** (KB, not KiB; the docs are
    // not explicit on KB-vs-KiB and the implementation must treat it as KB = bytes / 1000 to match
    // GitHub's UI "size" display). The interface contract is bytes — the implementation multiplies
    // the API value by 1000. The 500 MB clone threshold check uses bytes consistently. Do not return
    // the API's KB number raw from this method — the unit error then leaks into every consumer.
}

public record RepoCloneEntry(
    PrReference PrRef,
    string ClonePath,                               // absolute; may be inside or outside .prism/clones/
    CloneOwnership Ownership);                       // wire form: "user" or "prism-created" (kebab-case lowercase per the JSON policy in 02-architecture.md)

public enum CloneOwnership { User, PRismCreated }   // serialized via the global JsonStringEnumConverter with kebab-case-lower naming policy; see 02-architecture.md § Local workspace / "Serialization policy"

public abstract record CloneResult;
public record CloneSucceeded(string ClonePath, CloneOwnership Ownership) : CloneResult;
public record CloneRejectedTooLarge(long RepoSizeBytes, long ThresholdBytes) : CloneResult;
public record CloneFailed(string Reason, Exception? Inner) : CloneResult;

public abstract record WorktreeResult;
public record WorktreeReady(string WorktreePath, string HeadSha) : WorktreeResult;
public record WorktreeFailed(string Reason, Exception? Inner) : WorktreeResult;

public record CloneOptions(
    bool Shallow = true,
    int? Depth = 50,
    bool Sparse = true,
    string[]? SparsePaths = null);

public record CleanupAudit(
    CleanupCandidate[] Worktrees,                    // per-worktree info: PR ref, age since close, size, owner
    CleanupCandidate[] Clones,                       // PRism-created clones with no recent activity
    long TotalReclaimableBytes);

public record CleanupCandidate(string Path, PrReference? PrRef, long SizeBytes, string Reason);
public record CleanupSelection(string[] PathsToRemove);   // a subset of the audit's candidates, chosen by the user
```

The `CloneResult` and `WorktreeResult` discriminated unions replace earlier `Task<string?>` returns that conflated multiple outcomes into one nullable string. Consumers `switch` on the result type explicitly.

PoC ships `NoopRepoCloneService` returning empty results / null paths. v2 implements `GitRepoCloneService` that:
- Discovers user-owned clones via workspace enumeration under `<localWorkspace>/*/` (one level deep, excluding `.prism/`); reuses them via `git worktree add` to a path inside `.prism/worktrees/`.
- Creates new clones (when no user-owned clone exists for the repo) at `<localWorkspace>/.prism/clones/<owner>/<repo>/`. If `localWorkspace` is `null`, all `.prism/...` paths root at `<dataDir>` instead.
- Persists per-PR worktrees at `<root>/.prism/worktrees/<owner>/<repo>/pr-<n>/`. Worktree lifetime is per-PR (not per-session); the worktree is reused across multiple chat sessions on the same PR.
- `SyncWorktreeAsync` runs on the user's Reload click to fetch + reset the worktree to the new PR head. Background polling never touches the worktree.
- `AuditAsync` + `ApplyCleanupAsync` implement the disk-cleanup flow described in `02-architecture.md` § "Local workspace and the `.prism/` subroot".
- Defaults to shallow + sparse on PRism-created clones; reuses user-owned clones as-is (we don't `--unshallow` their clones; if their shallow clone is missing the PR's commits, `git fetch` pulls what's needed).
- Triggers consent (via `IUserConsentChannel`) **lazily, when the model calls `request_repo_access`** mid-conversation — not at chat-bootstrap. The chat starts in state 1; the upgrade to state 2 (clone + worktree + fresh Claude Code session) is initiated by the consent decision. See `<RepoAccessRequestModal>` for the modal UX and "Repo access via lazy upgrade with fresh-session injection" for the upgrade mechanics.

---

## Frontend slots

Every slot is a React component that exists in the component tree, capability-flag-gated. In PoC each renders `null`. The layout grid reserves space so v2 lighting up a slot doesn't cause re-layout shifts.

### `<AiSummarySlot>` — Overview tab hero card

Position: hero card at the top of the **Overview** tab (one of three sub-tabs — Overview / Files / Drafts — under the PR header). Renders above the PR description, stats, and PR-root conversation.
Capability flag: `ai.summary`
PoC behavior: returns `null`.
v2 behavior: renders a card with the AI-generated PR summary, expandable for a longer version, with a "stale" indicator if a new iteration arrived after generation.

**Overview-tab placement rationale.** Earlier drafts placed this slot between the sticky PR header and the (then-also-sticky) iteration tabs as a non-sticky band that scrolled away. That placement was discarded when the PR detail view gained the three-tab sub-strip (Overview / Files / Drafts) — putting the AI summary on the Overview tab makes it discoverable when the user lands on a PR (Overview is the default tab) and out of the way while reviewing diffs (which happen on the Files tab). The summary is read once on PR-open and rarely needed again; surfacing it on the same tab as the PR description, stats, and conversation is the natural reading order. The Files tab carries the iteration tabs and the file tree, both load-bearing for active reviewing — sharing that scarce vertical space with a summary the reviewer has already read would be a poor trade.

**Honest layout-reservation policy.** Earlier wording in this doc claimed the slot reserves "natural height" so v2 does not push the rest of the Overview tab downward. The natural height of `null` is zero, so that claim is misleading. The real policy:
- In PoC, the slot renders `null` and consumes 0px. When v2 lights up the slot, it will add vertical space to the Overview tab; the rest of the Overview content *will* move down by the slot's rendered height (typically 60–120px for a one-line summary card with margins).
- The PoC does not reserve a fixed placeholder height in the slot's container, because doing so wastes vertical space for users who never enable the AI summary feature (an explicit non-goal: PoC must be useful and uncompromised by v2's hypothetical layout footprint).
- The "no layout shift on banner arrival" DoD criterion in `01-vision-and-acceptance.md` covers the only PoC-relevant case: remote state changes don't push content. v2 light-up is a configuration change the user opts into, not a remote event; it is fine for the page to reflow once at v2 light-up.

The `claude-design-prompt.md` file's framing — "layout must not shift when v2 lights them up" — is hereby softened to "layout impact at v2 light-up is minimized; some shift is expected and is not considered a bug." The designer should design slots to be visually unobtrusive at sensible heights rather than design around a zero-shift constraint that can't be met.

### `<AiFileFocusBadges>` — file tree

Position: a column on each file tree row, right-aligned.
Capability flag: `ai.fileFocus`
PoC behavior: column collapsed (zero width).
v2 behavior: priority dot (red/yellow/green) per file, with hover tooltip explaining the score.

### `<AiHunkAnnotation>` — diff inline

**Reuses `react-diff-view`'s widget mechanism for the line-anchored case** — the same surface that comment threads use. New UI infrastructure (and styling for "AI annotation, not human comment") is required, but no new positioning or anchoring code.
Capability flag: `ai.hunkAnnotations`
PoC behavior: never inserted.
v2 behavior: inserted between code lines for hunks the AI flags as risky / interesting; renders as a compact card distinguishable from human comment threads.

**Honest scope:** the widget API works cleanly only for line-anchored annotations (between two specific lines in a hunk). Annotations that want to anchor *between hunks* or at *file scope* (e.g., "this entire file looks generated and was probably auto-formatted, so the apparent risk is low") need a separate slot — likely a header chip on the file tree row (`<AiFileScopeAnnotation>`, deferred to v2 design). Don't claim the widget API solves both.

**Stable IDs across reloads.** Each annotation must carry a stable ID that survives diff renumbering when `head_sha` changes. The recommended ID shape: `sha256(prRef + filePath + anchored_line_content + anchor_kind)` — content-addressable and recomputable on reload. The user's "dismissed" state for an annotation is persisted in `state.json.aiState.dismissedAnnotations[stableId]`; without stable IDs, dismissal evaporates on every iteration and v2's signal-collection (which annotations are useful) is unreliable. Dismissal persistence is a P2-4 acceptance criterion.

### `<AiChatDrawer>` — right-side drawer

Position: right edge of the PR view, slides in.
Capability flag: `ai.chat`
PoC behavior: never mounted.
v2 behavior: WebSocket connection to backend chat endpoint; renders streamed Claude responses; intercepts `tool_use` events to display the repo access modal when needed.

### `<RepoAccessRequestModal>` — top-level modal triggered by the model's request

Position: full-screen modal overlay.
Capability flag: `ai.chat` (only during chat sessions).
PoC behavior: scaffolded but never triggered.
v2 behavior: surfaced **at the moment the chat session's model calls the `request_repo_access` MCP tool** — typically mid-conversation, when the user has just asked something the model needs broader repo context to answer. The user's choice determines whether the session is upgraded from state 1 to state 2 (or stays in state 1 if denied). Earlier W29 drafts surfaced this modal at chat-open instead; that has been retracted in favor of lazy consent (see "Repo access via lazy upgrade" above).

**Skipped when "Always allow" is set.** If `aiState.alwaysAllowRepoAccess[<owner>/<repo>]` exists with a valid PAT fingerprint and the entry isn't aged out, the modal does not surface — the upgrade proceeds directly into clone+restart with a "Preparing repo access..." progress UI in the drawer. The modal is the only thing skipped; the clone-or-fetch + worktree creation + session restart still runs lazily on first request.

**Modal copy is entirely host-authored. The model's `request_repo_access` tool takes no arguments and does not contribute any string to the modal.** Copy depends on what `IRepoCloneService.ResolveCloneAsync` returns:

1. **No local clone exists; needs fresh clone**:
   *"AI chat is requesting read-only access to `acme/api-server`'s files to answer your question. PRism will clone the repo into `<localWorkspace>/.prism/clones/acme/api-server/` (~120 MB, ~30 seconds), then continue your conversation. — Allow once / Always allow for this repo / Deny / Cancel."*
2. **User-owned clone exists at `<localWorkspace>/<repo>/`**:
   *"AI chat is requesting read-only access to `acme/api-server`'s files. PRism will use your existing clone at `/Users/me/src/api-server/` (read-only worktree under `.prism/`; your branches and working directory are not touched), then continue your conversation. — Allow once / Always allow for this repo / Deny / Cancel."*
3. **PRism-created clone already exists** (subsequent chat in the same repo without always-allow):
   *"AI chat is requesting read-only access to `acme/api-server`'s files. PRism will use the cached clone in `.prism/clones/`, then continue your conversation. — Allow once / Always allow for this repo / Deny / Cancel."*

The modal also surfaces a size warning if `repo.size > 500_000_000` bytes: *"This is a large repo. Cloning will take several minutes."*

**The user reads the model's reasoning in the chat transcript, not in the modal.** The model's preceding chat-message text — *"To find other call sites I'd need to grep the repo. Let me request access."* — appears in the drawer as part of the conversation, where the user reads it as the model's voice. The modal itself never includes that text; the modal is Prism's authoritative system UI, kept clean of any model-supplied string. This separation is the structural defense against prompt-injection attacks via PR content (a compromised model can shape what it *says*, but cannot shape the modal copy).

**The four user choices:**
- **Allow once** → backend clones if needed, kills the current state-1 session cleanly, starts a fresh state-2 session with `--add-dir` + `--allowedTools "Read,Grep,Glob"` + injected conversation log + an "access just granted, please answer the previous question now" addendum. Drawer says: *"Repo access enabled — continuing your conversation."* The model's `request_repo_access` tool_result was `{ access_granted: true }`, but that result lands in the *killed* session and is never seen by the user; the new state-2 session is what the user sees.
- **Always allow for this repo** → same as Allow once, plus persists `aiState.alwaysAllowRepoAccess[<owner>/<repo>]` with the PAT fingerprint. Future chats on this repo skip the modal (but not the lazy clone) on the next `request_repo_access` call.
- **Deny** → the model's `request_repo_access` tool_result returns `{ access_granted: false }` to the *current* state-1 session. The session continues. The model receives the denial and can answer the question without repo access (or tell the user it can't).
- **Cancel** → same as Deny operationally (the model gets `access_granted: false`); semantically distinct in the UI ("the user closed the modal without choosing"). The drawer surfaces a soft note: *"Repo access not granted; chat continues without it."*

**Modal-storm rate-limit defense (per-session).** A prompt-injecting PR could cause the model to call `request_repo_access` repeatedly within a session — surfacing 30 modals in 30 seconds is a denial-of-attention attack. The MCP server enforces per-session limits on `request_repo_access`: **at most 3 invocations per minute, max 10 per session lifetime**. Calls exceeding either cap return an error tool_result without surfacing the modal: *"Rate limit: too many `request_repo_access` invocations. Wait, or the user must explicitly grant access through chat-drawer settings."* Over-cap events are logged to the forensic event log. The system prompt explicitly states the limits so a well-behaved model never trips them; the cap is a defense against a misbehaving (compromised-context) model.

**Honest threat model: the modal is again a model-triggerable surface, but with attacker-controllable text removed.** A malicious sibling process that obtains the MCP bearer could call `request_repo_access` directly to surface a modal. The modal copy is host-authored — no attacker-shapeable string lands in the modal — so the social-engineering blast radius is limited to "an attacker can make a modal pop up that legitimately asks the user to grant repo access." The user's defense is the same as for legitimate `request_repo_access` calls: they decide based on whether they trust the chat context. Combined with the rate limit and `0600` perms on the MCP-config file, this is consistent with the broader "local-only, single-user, this-machine-already-has-this-PAT" threat model.

### `<AiComposerAssistant>` — inside the comment composer

Position: inside the comment composer toolbar (next to "Save draft") + result panel below the body when active.
Capability flag: `ai.composerAssist`
PoC behavior: button hidden.
v2 behavior: "Refine with AI ✨" button + result panel showing refined version with inline diff vs original + notes section + accept/edit/retry/dismiss actions. Reused for inline comments, replies, and the PR-level summary textarea.

### `<AiDraftSuggestionsPanel>` — top of PR view

Position: collapsible panel above the file tree or as a header section.
Capability flag: `ai.draftSuggestions`
PoC behavior: hidden.
v2 behavior: lists AI-proposed draft comments. Each can be accepted (added to drafts), edited (loaded into composer), or dismissed.

### AI badge slot in stale-draft reconciliation UI

Position: per-stale-draft row in the reconciliation panel.
Capability flag: `ai.draftReconciliation`
PoC behavior: empty.
v2 behavior: shows AI's suggested action ("This comment is now obsolete because the new code addresses it" / "This still applies, here's the new line").

### AI validator results section in submit confirmation modal

Position: dedicated section in the submit dialog.
Capability flag: `ai.preSubmitValidators`
PoC behavior: empty (only deterministic stale-draft / verdict checks run).
v2 behavior: lists `IPreSubmitValidator` results — informational, suggestion, or blocking concerns.

### AI enrichment slots in inbox rows

Position: per-row badges + optional summary panel on hover.
Capability flag: `ai.inboxEnrichment`
PoC behavior: empty.
v2 behavior: row badges (e.g., "Docs PR", "Refactor", "High risk") + hover preview with PR summary.

---

## Configuration schema (PoC documents the shape; v2 uses it)

The `llm` section of `config.json` is reserved in PoC. Every key is documented; the values are read but not acted upon (no LLM provider runs in PoC).

```jsonc
{
  "llm": {
    "provider": "claude-code",
    "model": "claude-opus-4-7",
    "userProfile": {
      "role": null,
      "preferences": {
        "summaryTone": null,
        "summaryLength": null
      }
    },
    "features": {
      "summary":              { "enabled": false, "model": null },
      "fileFocus":            { "enabled": false, "model": null },
      "chat":                 { "enabled": false, "model": null },
      "hunkAnnotations":      { "enabled": false, "model": null },
      "composerAssist":       { "enabled": false, "model": null },
      "draftSuggestions":     { "enabled": false, "model": null },
      "preSubmitValidators":  { "enabled": false, "model": null },
      "draftReconciliation":  { "enabled": false, "model": null },
      "inboxEnrichment":      { "enabled": false, "model": null },
      "inboxRanking":         { "enabled": false, "model": null }
    },
    "apiKeyRef": null
  }
}
```

- `provider` defaults to `"claude-code"`. v2 may support `"anthropic-api"` (requires `apiKeyRef`) and `"ollama"` (local LLM).
- `model` is per-feature overridable. Falling back to top-level `model` if unset, then provider default.
- `userProfile` is injected into Claude's system prompt in v2. Empty schema reserved in PoC.
- `apiKeyRef` is the keychain entry name for non-Claude-Code providers. Not used when `provider == "claude-code"` (auth lives in Claude Code's OAuth). For multi-provider users (e.g., Anthropic-API for one feature + Ollama for another in v2), the namespace is `prism.llm.<providerId>.apiKey` — for example `prism.llm.anthropic-api.apiKey`. This avoids collisions when multiple providers are configured concurrently and gives v2 a deterministic key to look up. Per-feature `apiKeyRef` overrides may be added in v2 if a user wants different credentials per feature.

---

## State schema additions

`state.json` reserves an `aiState` sub-object (empty in PoC; populated in v2):

```jsonc
{
  "version": 1,
  "reviewSessions": { ... },
  "aiState": {
    // populated in v2 with:
    // - dismissed AI suggestions per PR
    // - cached per-PR summaries (or moved to IAiCache)
    // - "always allow repo access" persistence per (owner, repo)
    // - user feedback (accept/reject) on AI suggestions
  }
}
```

---

## Claude Code integration (v2)

PoC does not implement this; the design is documented here so v2 picks it up correctly.

### One-shot inferences (summary, ranking, annotation, etc.)

Spawn `claude` per call:

```bash
claude -p "<prompt>" --output-format json --model claude-opus-4-7 \
  [--append-system-prompt "<system prompt>"]
```

Implemented in `ClaudeCodeLlmProvider.CompleteAsync` via `Process.Start` with stdout capture. ~30 lines of C#. No SDK dependency.

### Sustained chat (PR chat panel)

Spawn `claude` once per chat session with the streaming JSON protocol:

```bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --include-partial-messages \
  [--add-dir <clone-path>] \
  [--allowedTools "Read,Grep,Glob"] \
  [--disallowedTools "Bash,Edit,Write"] \
  [--resume <session-id>]
```

Implementation pattern (`ClaudeCodeLlmProvider.StartSession`):
1. Spawn process with redirected stdin/stdout.
2. Background reader on stdout parses line-delimited JSON events into a `Channel<LlmEvent>`.
3. `SendUserTurnAsync` writes JSON-encoded user turns to stdin.
4. `Events` exposes the channel as `IAsyncEnumerable<LlmEvent>`.
5. `DisposeAsync` closes stdin, awaits process exit.

This is the same protocol the official TypeScript Agent SDK uses — we skip the SDK and talk to the binary directly.

### Repo access via lazy upgrade with fresh-session injection

The chat session **always starts in state 1** (no repo access, no clone, no worktree, no `--add-dir`). When a question requires reading the broader repo, the model calls `request_repo_access` (an MCP tool the host exposes); the user sees a host-authored consent modal; on approval, the backend clones if needed, ends the current Claude Code session cleanly, and starts a *fresh* session with `--add-dir <worktree-path>` and `--allowedTools "Read,Grep,Glob"`, with the prior conversation injected as system-prompt context (per `§ Cross-restart chat resume` § Case B). The user sees no break in the conversation; the model picks up with worktree access and answers the question that triggered the upgrade.

This is **lazy consent**: zero-cost chat-open, zero clone for diff-only conversations, contextual modal at the moment access is actually needed.

Filesystem reads in the upgraded session use Claude Code's **built-in `Read`, `Grep`, `Glob` tools** (internally ripgrep), scoped via `--add-dir`. The MCP server itself never re-implements filesystem reads. The MCP-server surface holds only PR-shaped tools that don't have a filesystem analog plus the consent-bridge tool.

**MCP server tools (the entire surface):**
- `pr_diff_file(path)` — return the diff for a file in the active PR. Always available regardless of repo-access state.
- `pr_existing_comments()` — return existing comments on the PR. Always available.
- `request_repo_access()` — the consent-bridge tool. Takes **no arguments** — the model's reasoning for the request belongs in its chat-message text, not as a parameter. Returns `{ access_granted: true | false }`. On `true`, the chat session is about to be killed and replaced with a fresh session; the model's tool_result is the last thing it does in the current session. On `false`, the current session continues without repo access.

The `request_repo_access` tool taking no arguments is a deliberate defense against attacker-controlled `reason` text. Earlier drafts had the model pass `reason` as an argument and the modal showed it — that was attacker-shapeable via prompt injection from PR content. In this design the modal is **entirely host-authored** and never includes any model-supplied string. The model's reasoning for *why* it's requesting access is its preceding chat-message text, which appears in the chat transcript where the user reads it as the model's voice — not styled as Prism's authoritative system UI.

**Two session states (was three):**

1. **State 1 — no repo access.** The starting state of every chat session. Claude Code launches with `--allowedTools ""`, no `--add-dir`, and the MCP config exposing `pr_diff_file`, `pr_existing_comments`, `request_repo_access`. The model can answer questions about the PR diff and existing comments but cannot read the broader repo. State 1 is the steady state for the substantial fraction of conversations that never need repo access.
2. **State 2 — repo access granted (this session).** Reached by the lazy-upgrade path. Claude Code launches *fresh* with `--allowedTools "Read,Grep,Glob"`, `--add-dir <worktree-path>`, `--disallowedTools "Bash,Edit,Write"`, the MCP config (without `request_repo_access` — the model has the access already, no need to re-request), and `--append-system-prompt <conversation-log + upgrade-context-note>`. State 2 lives until the chat drawer closes; on next chat-open the session starts in state 1 again unless `aiState.alwaysAllowRepoAccess` short-circuits the modal (the *modal* is short-circuited, not the clone — see "Always allow" below).

The earlier W29 design enumerated three states; the third was "always allow with eager clone at chat-open." That collapsed in W31 because clones are now lazy regardless of always-allow. "Always allow" means *the modal is skipped when the model requests access*; the clone still happens at request time, not at chat-open.

**"Always allow" persistence semantics under lazy consent.** When the user clicks "Always allow for this repo" in the modal, `aiState.alwaysAllowRepoAccess[<owner>/<repo>]` is persisted with the PAT fingerprint. On subsequent chat sessions for the same repo:
- The chat still starts in state 1 (no clone, no `--add-dir`). Always-allow doesn't preempt the clone.
- When the model calls `request_repo_access`, the backend skips the modal — the user has already pre-approved this repo. The modal is the only thing skipped; the clone-or-fetch + worktree creation + session restart still runs (with progress UI in the drawer: *"Preparing repo access..."*).
- Always-allow is invalidated by the same conditions as before: persisted entry > 30 days, PAT fingerprint mismatch, clone path missing.

The result: a user who reviews many PRs across many repos with always-allow set never accumulates speculative clones — clones happen only when chat conversations actually need repo access.

**Why the three concerns that killed W29's mid-session approach are addressed:**

1. **Attacker-controllable `reason` text** — closed by removing the `reason` parameter entirely. The modal is host-authored. The model's reasoning is in its chat-message text, which is in the *transcript*, not the modal.
2. **Modal-storm denial-of-attention** — defended by per-session rate limits: max 3 `request_repo_access` invocations per minute, max 10 per session lifetime. Calls exceeding either cap return an error tool_result instructing the model to wait. The system prompt states the limits explicitly so a well-behaved model never trips them.
3. **Mid-session flag toggling requires kill-and-resume per C4** — false now. We don't *toggle flags* on the same session; we *kill cleanly and start fresh* with new flags, using W30's fresh-session-with-injection mechanism. C4's clean-end resume gating applies to the *resume same conversation* path, not to the upgrade path. The upgrade is structurally a Case B (intentional fresh session with injection), not a Case A.

**Auth from Claude Code to the MCP endpoint.** Each chat session generates a one-time bearer token (32 random bytes, base64-encoded) at session start. The backend writes an MCP-config JSON pointing at the HTTP endpoint with the token in the `Authorization` header:

```jsonc
{
  "mcpServers": {
    "prism": {
      "type": "http",                                                   // transport discriminator — required for HTTP MCP servers; without it, Claude Code parses the entry as a stdio command and rejects the file. Empirical verification gated in `00-verification-notes.md` § C5.
      "url": "http://localhost:<port>/api/mcp",
      "headers": { "Authorization": "Bearer <session-token>" }
    }
  }
}
```

The token maps to a per-session `McpSession` in backend memory (`{ sessionId, prRef }` — no `clonePath` or `accessGranted` because filesystem access is via Claude Code's `--add-dir`, not via MCP). The MCP endpoint validates the bearer header on every request and rejects unknown tokens with HTTP 401. Tokens are invalidated when the chat session ends. This auth model is independent of the browser-cookie + Origin-check defense used for the rest of the localhost API — Claude Code is not a browser, has no cookies, and would not pass Origin checks; the bearer token is the only auth surface for MCP requests.

**Lifecycle:**
- One *or more* Claude Code subprocesses per chat conversation, depending on whether repo-access is requested. Most conversations have one subprocess (state 1 only). Conversations where repo access is requested have two: state 1 → killed cleanly → state 2. The user perceives one continuous chat in the drawer regardless.
- Within a single subprocess, `--mcp-config`, `--allowedTools`, `--add-dir`, and the bearer token are fixed for that subprocess's lifetime; they do not toggle in-flight.
- The state-1 → state-2 transition is mediated by `request_repo_access` + W30's fresh-session-with-injection. No `--resume`-after-kill is needed (we don't try to resume the killed state-1 session; we start state 2 *fresh* with the conversation log injected as system-prompt context).
- `Bash`, `Edit`, `Write` are **always disallowed** in both states. `Read`, `Grep`, `Glob` are present in `--allowedTools` only in state 2.

**Critical security constraint:** filesystem access is read-only. **No Bash, no Edit, no Write.** The clone is a research surface, not an execution sandbox. `--disallowedTools "Bash,Edit,Write"` is the hard backstop — even if the model emits a `Bash` tool_use, Claude Code refuses to dispatch it. Path containment is enforced by `--add-dir` (Claude Code rejects reads outside the listed directories).

**Operational constraints documented for the MCP HTTP endpoint:**

- **Token rotation mid-session is not supported.** If the bearer leaks (process-memory introspection by a hostile local process is acknowledged out-of-scope, but a misconfigured logging path that captured the bearer would not be), the only recovery is to **end the chat session and start a new one** — that invalidates the old bearer and issues a new one. Adding a rotate-bearer-mid-session affordance is not a PoC seam; v2 may revisit if a real rotation use-case appears.
- **Per-request size cap on `/api/mcp`.** The endpoint accepts JSON bodies up to **256 KB**; larger bodies are rejected with HTTP 413. Cap is enforced via ASP.NET Core's `RequestSizeLimit` attribute. This guards against a misbehaving (or compromised-context) model spamming huge tool-call payloads — without a cap the backend's per-tool dispatcher could OOM. 256 KB is well above the largest legitimate tool input (a few KB of file paths and grep patterns) and well below any threshold that matters for memory.
- **Orphaned Claude Code subprocess after backend restart.** If the backend restarts while a Claude Code subprocess is still running (subprocess outlives the parent's crash), the subprocess holds a path to a now-stale `mcp-config` JSON file. The new backend instance's startup sweep deletes mcp-config files older than 1 hour — including this orphan's. The orphan's next tool call lands at the new backend's `/api/mcp` endpoint with a stale bearer that no longer maps to any session, returning 401. The orphan's user-facing chat tab is already disconnected (the WebSocket dropped on backend restart); the 401 simply confirms that the tools are unreachable, which is the desired failure mode. The user-facing recovery is to reopen the chat — a fresh subprocess starts with a fresh bearer.

**Why MCP, not a CLI synthetic-tool flag.** Claude Code does not expose a CLI mechanism to register a host-defined tool whose `tool_use`/`tool_result` flows through the stream-json loop. MCP is the only documented mechanism for custom tools. (See [verification-notes § C3](./00-verification-notes.md#c3).)

**Why `--resume` is used for cross-restart but not for the lazy-upgrade path.** Two related but distinct cases:

- **Lazy-upgrade from state 1 to state 2** uses *clean kill + fresh session with injection*, not `--resume`. The model calls `request_repo_access`; we let the model's tool_use complete and receive its tool_result (no dangling tool_use); we cleanly end the state-1 subprocess; we start state-2 fresh with new flags and `--append-system-prompt <conversation-log>`. We don't try to resume the state-1 session — we'd need different flags, and `--resume` with new flags is officially undocumented. Fresh-with-injection sidesteps this entirely (per W30's mechanism).
- **Clean-end-and-resume across backend restarts** uses `--resume` directly. When the user closes the drawer (or the backend shuts down cleanly), the session is ended at a turn boundary via `EndCleanlyAsync`; the Claude Code session's ID is persisted in `state.json.aiState.chatSessions`. On the next reopen of the same chat, the chat-bootstrap path passes the persisted `claudeCodeSessionId` back via `StreamingSessionOptions.ResumeSessionId` — Claude Code resumes the session with full model-internal state preserved. The flags don't change; this is a Case A resume, not a flag-change. See "Cross-restart chat resume" below. (See [verification-notes § C4](./00-verification-notes.md#c4) for the empirical gate on this path.)

### Chat bootstrap UX (during the lazy-upgrade clone)

The `<RepoAccessRequestModal>` resolves quickly; the work that follows ("Preparing repo access...") can take seconds or minutes depending on repo size. The drawer's progress UI during this window is part of the v2 chat experience and is documented here so the design lands once.

- **Determinacy.** When `IRepoCloneService.GetRepoSizeBytesAsync` returns a non-null value (the GitHub API surfaces `repo.size` for most repos), the progress UI is **determinate**: a percentage fill keyed on bytes-received from `git clone`'s `--progress` output, plus an estimated remaining time. When the size is unknown (rare) the UI is indeterminate (a spinner with "Cloning…" copy and the elapsed time).
- **First-time copy.** On the *first* clone of a repo (no `repoCloneMap` entry), the drawer's progress UI also surfaces a one-line note: *"This is a one-time setup for `<owner>/<repo>`. Future chats on this repo will reuse the clone."* Suppressed on subsequent always-allow upgrades that hit an existing clone.
- **Concurrent navigation.** The user can navigate to a different PR while the bootstrap is in flight. Doing so **cancels the bootstrap** (kill+rm per "cancel-during-clone" in `backlog/03-P2-extended-ai.md` § P2-2) — the chat the user navigated away from has no way to surface the result. The new PR starts in state 1 with no preparation in flight.
- **One bootstrap in flight per launch.** The chat orchestrator serializes bootstraps: if a second `request_repo_access` resolves while one is already preparing (different PR, different repo), the second request waits for the first to finish or be canceled before its own clone work starts. This avoids fanning out two large `git clone` operations against a single user's bandwidth and disk.
- **Already-running clone for the same repo.** If a `request_repo_access` resolves for a repo whose clone is already in flight (e.g., from a different chat session that the user opened in another tab), the second request reuses the clone-in-progress: it attaches to the same `Task<CloneResult>` and waits for the shared completion rather than spawning a parallel `git clone`. The first chat to finish proceeds with the worktree; the second sees the clone-ready state and runs only its own `EnsureWorktreeForPrAsync`.

PoC ships none of this (PoC has no chat); the section is here so v2 picks up a coherent design instead of inventing it under feature pressure.

### Cross-restart chat resume

The chat session's persistence story has two cases:

**Case A: same flags, no consent change.** The user reopens a chat that was previously active on the same PR with the same repo-access state. Backend looks up `state.json.aiState.chatSessions[<prismSessionId>]`; if found and `lastTurnEndedCleanly === true`, runs `claude -p --resume <claudeCodeSessionId> [original flags]` with a regenerated bearer token (the MCP config JSON is rewritten at the same path with the new bearer). The user sees a one-line note in the drawer: *"Resumed your chat from <timestamp>."* The model has full context — including its own internal reasoning, prior tool uses and results — exactly as it was when the session ended.

**Case B: flags change OR resume fails.** Three sub-cases force a fresh session:
1. The user explicitly changed repo-access state at chat-open (e.g., previously denied, now wants to allow). Always go fresh; never try `--resume` with new flags.
2. `lastTurnEndedCleanly === false` (the prior session ended via SIGKILL or a process crash mid-turn). C4 says resume from this state is unreliable; don't attempt.
3. `--resume` is attempted and Claude Code rejects it (session expired, CLI version mismatch with stored session, undocumented bug). Backend catches the failure and falls back to fresh-with-injection.

In all three sub-cases the new Claude Code session launches with **the prior conversation log injected as system-prompt context**:

```
Prior conversation context (this is a continuation of a chat the user was having earlier;
the session was restarted because [flag change | session could not be resumed]. Treat the
prior turns as background, not as actual conversation history; the user may reference earlier
points and you should respond as if you remember them):

  [<ISO8601>] User: <full user turn 1>
  [<ISO8601>] Assistant: <assistant turn 1, summarized to ~200 chars if longer than 400; otherwise verbatim>
  [<ISO8601>] User: <user turn 2>
  ...
```

The injection is added via `StreamingSessionOptions.AppendSystemPrompt` (or the equivalent `--append-system-prompt` flag for Claude Code). Token cost: ~30–80 tokens per turn pair after summarization; long chats are bounded by the model's context window. When the projected injection exceeds 50% of the context window, older turns are dropped from the head with a final "[earlier turns omitted]" marker — the most recent turns are the highest-signal for continuity.

The user-facing one-line note differs between cases: *"Resumed your chat from <timestamp>."* (Case A success) vs. *"Couldn't resume your prior session — starting fresh with conversation context preserved."* (Case B fallback) vs. *"Started a fresh chat with new tools — your earlier conversation is included as context."* (Case B sub-case 1, intentional flag change).

**Clean-shutdown discipline (load-bearing for Case A).** `EndCleanlyAsync` is the only path to a resumable session. Drawer-close, backend graceful shutdown, and OS shutdown handlers all call `EndCleanlyAsync` with a 5-second graceful timeout before falling back to SIGTERM, then SIGKILL. The grace timeout matters because some model turns generate for more than a few seconds; cutting them off mid-stream produces a dangling tool_use or a truncated assistant message that breaks resume. Five seconds is enough for almost all turns to finish naturally; the very long turn (>5s) becomes "this session ended unrcleanly, fall back to fresh-with-injection on resume." That's an acceptable degradation — the user still gets continuity via the injection path; they just don't get full model-internal-state restoration.

**`--resume` boundaries that are NOT promises:**
- **Across CLI updates** — if the user's `claude` binary updates between session-end and resume, the stored session may be invalid. Backend falls back to fresh-with-injection on the next resume attempt and surfaces a one-line note.
- **Across credential rotation** — if the user re-authenticated with `claude` in a terminal, the prior session ID may be tied to the old auth. Same fallback.
- **Across machine moves** — Claude Code's session storage is local; resuming on a different machine is not supported. The conversation log in `state.json` survives machine moves (it's our data); the resumable session ID does not.

### Capability detection

In v2, on first run the backend probes:

```bash
claude --version
```

…and sets a runtime flag `claudeCodeAvailable: bool` used by `IAiFeatureFlags`:
- If `claude --version` fails (binary not on PATH) → `claudeCodeAvailable = false`. Show a one-time "Install Claude Code to enable AI features" hint.
- If `claude --version` succeeds → `claudeCodeAvailable = true`. **No authenticated probe.** The user's first real AI call is what surfaces the auth state: a 401 on the first `claude -p` invocation (typically: binary present but `claude` has not been run to authenticate yet) flips `claudeCodeAvailable = false` and surfaces a hint banner: *"Claude Code is installed but not authenticated. Run `claude` in a terminal to log in."* The same banner re-surfaces if a future call 401s after a credential rotation.

**Why no preemptive authenticated probe.** Earlier drafts ran `claude -p "ping" --output-format json` at startup to validate the credential, with a 24h cache keyed on the binary mtime + `--version` output to avoid spending tokens on every restart. Two problems with that approach:
1. The cache key does not catch credential rotation (Claude Code stores credentials in a separate file the cache doesn't track) — a rotated credential the probe says is fine then 401s on the first real call, which is exactly the failure the probe claimed to prevent.
2. Even with cache, every cache miss spends a subscription token; for users on rate-limited Claude tiers, "ping every 24h × N machines" is a small but real ongoing tax with no offsetting benefit (the user has no UI to know when the next probe will fire and no recourse if it lands at a bad time).
The "fail at first real call, recover via banner" UX is more honest than "preemptively validate, lie when the credential rotates." The user's first AI call carries the cost it would carry anyway; what's removed is the silent token spend on backend restart.

**In PoC, the probe does not run.** Every `ai.*` flag is `false` regardless of Claude Code availability, so the probe carries no useful information. It is wired up in P0-1 alongside `ClaudeCodeLlmProvider`. This keeps PoC literally free of any AI-related shellout, consistent with "PoC ships zero AI features" in `spec/01-vision-and-acceptance.md`.

**Future maintenance: CLI compatibility test suite (P3 in spec review).** Anthropic ships frequent Claude Code CLI updates with no formal API-versioning. v2 should ship a small compatibility test suite that runs on every CI build (and ideally on a schedule against Anthropic's latest release): asserts `--version` shape, `-p --output-format stream-json --include-partial-messages` event schema, `--mcp-config` JSON shape, `--allowedTools` / `--disallowedTools` semantics. When the suite fails on a newer CLI release, the maintainer triages before users hit the breakage. Tracked as a v2 follow-up; not a PoC obligation.

---

## DI registration in PoC (sketch)

```csharp
// PRism.Web/Program.cs

services.AddSingleton<IReviewContextFactory, ReviewContextFactory>();    // factory; AI features call factory.For(prRef) per call
services.AddSingleton<IReviewEventBus, InProcessReviewEventBus>();
services.AddSingleton<IAiFeatureFlags, ConfigDrivenAiFeatureFlags>();

// All AI services are no-ops in PoC.
services.AddSingleton<IPrSummarizer, NoopPrSummarizer>();
services.AddSingleton<IFileFocusRanker, NoopFileFocusRanker>();
services.AddSingleton<IHunkAnnotator, NoopHunkAnnotator>();
services.AddSingleton<IPrChatService, NoopPrChatService>();
services.AddSingleton<IInboxRanker, NoopInboxRanker>();
services.AddSingleton<IInboxItemEnricher, NoopInboxItemEnricher>();
services.AddSingleton<IComposerAssistant, NoopComposerAssistant>();
services.AddSingleton<IDraftCommentSuggester, NoopDraftCommentSuggester>();
services.AddSingleton<IDraftReconciliationAssistant, NoopDraftReconciliationAssistant>();
services.AddSingleton<IPreSubmitValidator, NoopPreSubmitValidator>();
services.AddSingleton<IAiCache, NoopAiCache>();
services.AddSingleton<IRepoCloneService, NoopRepoCloneService>();
services.AddSingleton<IUserConsentChannel, NoopUserConsentChannel>();
services.AddSingleton<ILlmProvider, NoopLlmProvider>();
services.AddSingleton<IStreamingLlmProvider, NoopStreamingLlmProvider>();
services.AddSingleton<ITokenUsageTracker, NoopTokenUsageTracker>();
```

In v2, the no-op registrations are replaced with real implementations and the corresponding capability flags flip to `true`.

---

## What this design buys us, concretely

When v2 starts, the developer:
1. Adds `PRism.Llm.ClaudeCode` project with `ClaudeCodeLlmProvider` implementation.
2. Replaces `NoopLlmProvider` and `NoopStreamingLlmProvider` registrations.
3. Adds `PRism.Llm.Caching` project with a real `IAiCache` implementation (file-based or in-memory).
4. Implements specific `IPrSummarizer` etc. one at a time, each in a small class composing `IReviewContext` + `ILlmProvider` + `IAiCache`.
5. As each feature is ready, flips its `features.X.enabled` flag in config to `true` and the corresponding capability flag turns on.
6. The frontend automatically renders the corresponding slot. **No frontend code changes per AI feature.**

Each AI feature is roughly a single class + a prompt + per-feature tests. The PoC's structural work is what makes that possible.

---

## What's NOT seamed (deliberate deferrals)

These items appeared during the architecture sweep but were judged not to require PoC seams. They can be retrofitted in v2 without reshaping existing Core types (additive Core changes are permitted):

- **MCP server registry / user-supplied MCP** — additive config feature with no Core impact.
- **AI feedback loop / telemetry** — observability layer, retrofittable.
- **Internationalization (i18n)** — well-understood retrofit pattern (extract strings into resource files); not structural.
- **Inbox activity rail** (right-side rail in the inbox grid; see [`03-poc-features.md`](03-poc-features.md) § 2 "Activity rail"). Renders cross-PR activity items + a "Watching" repo list, lifted verbatim from [`design/handoff/screens.jsx`](../../design/handoff/screens.jsx) and hand-canned in the frontend. Gated on `ui.aiPreview` directly — no per-rail `ai.*` capability, no `Noop*` / `Placeholder*` interface pair. The PoC seams are scoped to per-PR or per-row enrichment surfaces (`IInboxRanker`, `IInboxItemEnricher`) where the contract shape is well-understood; the activity rail's v2 semantics (cross-repo Events API? aggregated push/comment/CI feed? filtered by reviewer relevance?) are unsettled enough that committing to a contract now would lock in the wrong shape. v2 retrofits this when the activity-feed feature is properly designed; the retrofit is additive (new seam interface + capability flag + DI registration), no existing Core type changes.

`ITokenUsageTracker` was previously listed as "not seamed" but has been seamed in PoC for symmetry with `IRepoCloneService`: both are interfaces consumed by `ClaudeCodeLlmProvider`, both are cheap to declare, and treating them asymmetrically was inconsistent. The PoC interface is:

```csharp
public interface ITokenUsageTracker
{
    Task RecordUsageAsync(string featureId, TokenUsage usage, CancellationToken ct);
    Task<IReadOnlyList<UsageRecord>> GetUsageAsync(DateTimeOffset from, DateTimeOffset to, CancellationToken ct);
}
public record UsageRecord(string FeatureId, TokenUsage Usage, DateTimeOffset Timestamp);
```

PoC ships `NoopTokenUsageTracker` registered as singleton in DI alongside the other AI seams. v2's P0-6 swaps in the real implementation backed by JSONL files under `<dataDir>/usage/`. See `backlog/01-P0-foundations.md` § P0-6.

See `backlog/` for these as explicit v2 items.
