# `claude --resume` clean-end empirical probe (P0-1b Slice 3 / #479) — design

- **Issue:** [#479 — [AI] P0-1b — `claude --resume` clean-end empirical probe (C4 gate)](https://github.com/prpande/PRism/issues/479)
- **Parent root:** #404. **Slice 1** (contracts) shipped (PR #480, `a251c0e7`); **Slice 2** (real provider) shipped (PR #483, `413e6e71`). This slice is the **third and final** P0-1b slice.
- **Base branch:** `V2`. **Tier/risk:** T3, **gated B2** (subprocess + egress; the resume path replays prior conversation context).
- **Seeds:** parent design § 6 + verification-notes § C4 (the load-bearing empirical gate) + the **probe results recorded in § 2 below** (two runs: an initial run and a production-faithful re-run prompted by adversarial doc-review).

## 1. Problem & context

The cross-restart chat-resume UX (P2-2, under #412) assumes `claude --resume <session-id>` restores a prior session's full conversation context when that session ended cleanly (verification-notes § C4). This was **officially undocumented** and flagged as the one genuinely empirically-blocked decision in P0-1b: until the probe runs, we cannot know whether to (a) ship resume as spec'd, (b) degrade P2-2 to fresh-with-injection, or (c) treat the stored session id as vestigial.

This slice runs that probe, pins the contract and UX to the observed outcome, and lands the deferred `ResumeSessionId` field on `StreamingSessionOptions` (§ 4.3 of the parent design reserved the slot). It is mostly a **spike plus a one-field contract addition** — the empirical result is the deliverable, and it gates the small amount of code.

**Why land the field with the probe rather than with its consumer (#412):** doing so closes the P0-1b contract surface and the **B2 subprocess seam** now, so #412 is pure consumer wiring that does not re-enter provider/subprocess code (a gated surface). #412 inherits a tested, version-pinned seam instead of re-opening it.

## 2. Probe results — **full-context resume (Outcome #1), confirmed under the production environment**

Run against the authenticated `claude` **v2.1.177** on the owner's machine, 2026-06-14, using the **same streaming flags and user-turn wire format the Slice-2 provider emits** (`-p --verbose --input-format stream-json --output-format stream-json --include-partial-messages --allowedTools Read,Glob,Grep --disallowedTools Bash,PowerShell,Edit,Write,NotebookEdit`; user turn `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`). Drivers + raw transcripts retained under `.scratch/` (gitignored): `probe.sh` (run 1), `probe3.sh` (re-run), `s1/s2/A1/A2/B/C1/C2*.jsonl`.

### 2.1 Run 1 — outcome and anti-confirmation

Planted an arbitrary tag `ZX9-QUOKKA-42` in session 1; closed stdin → clean exit (code 0); captured `session_id` from the init line; ran `claude … --resume <id>` and asked for the tag **without restating it**. Model replied exactly `ZX9-QUOKKA-42`. Anti-confirmation checks (all hold): tag **absent from the asking prompt** (verified — appears only in the planting turn), arbitrary token (no credible guess/hallucination), `SessionStart:resume` hook fired with the **same `session_id`**, no contamination path.

### 2.2 Re-run (production-faithful) — prompted by adversarial doc-review

Run 1 used the *worktree* cwd and ambient env. The Slice-2 provider spawns `claude` from a **confined, stable working directory** (`ClaudeCodeProviderOptions.WorkingDirectory`, the per-user `…\PRism\llm-cwd` base) with `CLAUDE_CONFIG_DIR` **unset** (`ClaudeCliEnvironment` strips it). Because `claude` keys session transcripts **per-working-directory slug** (`~/.claude/projects/<cwd-slug>/<id>.jsonl`), run 1 did not exercise the production spawn. The re-run closes that gap:

| Trial | Setup | Result |
|-------|-------|--------|
| **A — production-faithful** | plant → resume **both from the real `…\PRism\llm-cwd` base**, `CLAUDE_CONFIG_DIR` unset (= production) | **Recalled** `AAA9-NARWHAL-71` → full-context resume holds in the production cwd/config. |
| **B — negative control** | a **fresh** session (no `--resume`) asked for trial-A's tag | Did **not** know the tag → rules out any ambient channel (memory/hook/CLAUDE.md); recall in A is genuinely from the resumed transcript. |
| **C — cross-cwd** | plant in the PROD base, resume **from a different cwd** | `claude` errored **"No conversation found with session ID" (exit 1)** → resume is **cwd-sensitive**. |

`claude` also started and ran cleanly under the fully-stripped allowlist env (8 vars only) from the PROD cwd, confirming the production env does not break startup. (An `env -i` harness made `claude` emit UTF-16 stdout — an MSYS console artifact the real .NET `StreamReader` path does not exhibit; the normal-env re-run produced clean UTF-8, matching the provider.)

### 2.3 Operational invariants the re-run establishes

1. **Resume is working-directory-scoped.** `--resume <id>` only finds the transcript when invoked from the **same cwd** the session was created in. Production satisfies this because the provider confines cwd to a **stable** base — `PRism.Web/Program.cs` sets `WorkingDirectory = Path.Combine(dataDir, "llm-cwd")`, and `dataDir` is the deterministic OS-resolved per-user path (`DataDirectoryResolver.Resolve()`) unless overridden. So the invariant reduces to **same `dataDir` between plant and resume**: it holds for the default desktop case (stable across restarts), and under a `--dataDir` override that differs between runs (e.g. parallel-agent testing's per-instance `(port, dataDir)` pairs) the resume simply does not find its transcript and **degrades to fresh-with-injection** via the fail-hard path (invariant 2) — degraded, not broken. This is now a **documented contract invariant**, not an assumption: a resume MUST reuse the original session's `WorkingDirectory`.
2. **A failed resume fails hard, it does not silently start fresh.** A cwd mismatch (or unknown id) makes `claude` exit 1 with `"No conversation found"` and emit no init/result. The future caller (#412) MUST detect resume failure and **fall back to fresh-with-injection** — it cannot assume a resume attempt yields a usable session.
3. **Session-id idempotence is observed but not contractual.** The post-resume `session_id` equaled the resumed id in both runs (N=2 on v2.1.177). The undocumented CLI could adopt a fork-on-resume model later, so callers MUST **re-persist the post-resume `ProviderSessionId` as the new key** rather than assume `post-resume id == ResumeSessionId`.

### 2.4 What the outcome pins (scoped to v2.1.177)

| Decision | Pinned value |
|----------|--------------|
| P2-2 cross-restart UX | **Keep the full-context "Resumed your chat" promise — as of `claude` v2.1.177.** Resume restores prior context (§ 2.1, § 2.2-A). |
| `claudeCodeSessionId` in `aiState.chatSessions` | **Meaningful** — it is the resume key, not vestigial. Persist the *cwd* (or rely on the stable base) alongside it (§ 2.3-1). |
| `ResumeSessionId` contract field | **Add it.** Set → `--resume <id>` → context-restoring resume; null → fresh session. It is an **optimization the caller MAY use** — callers MAY always fall back to fresh-with-injection if resume is unavailable/unreliable (§ 2.3-2). |
| Eligibility | Only sessions whose end was clean (`SessionEndState.LastTurnEndedCleanly == true`) are resume candidates (§ C4 sub-case 1). The probe used a raw stdin-close clean exit as a **proxy** for the provider's `EndCleanlyAsync` clean-end; the plan adds an integration assertion that an `EndCleanlyAsync`-ended session is resumable (§ 8). This is a **caller** contract, documented on the field — not provider-enforced (the provider holds no handle to the prior session's end-state). |
| Durability | The pin is **version-conditional** (one CLI version; `--resume` survival across a CLI update is untested — § 6). #412 carries a re-verification requirement (§ 5). |

## 3. Scope & non-goals

**In scope:**
- Add `ResumeSessionId` to `StreamingSessionOptions` as a **nullable optional appended param** (source-non-breaking), with XML doc pinning the § 2.3 / § 2.4 semantics — including the same-cwd requirement, the fail-hard behavior, and the re-persist-the-new-id guidance.
- Wire it in `ClaudeCodeStreamingProvider.StartSession`: when non-null, append `--resume <id>`. Validate the id with a **single-CLI-token shape check** (reject embedded whitespace, leading `--`, empty). *Note:* this is an **analogous** check to `ValidateToolNames`, not the same justification — the tool-name comma rule exists because tool names are comma-joined into one token (`string.Join(",", …)`); a session id is its own argv element, so a comma cannot split it. Implement as a separately-named `ValidateCliToken` (or an inline-commented reuse) so the comma rule is not copied with the misleading list-injection rationale. Comma rejection is kept only as conservative shape validation.
- Unit tests: present → `--resume <id>` appended in order; null → flag omitted; malformed id (whitespace / leading `--` / empty) → rejected.
- Documentation: record the outcome + invariants in the parent design § 6, verification-notes § C4 (resolve the gating checkbox), the project AI README, and the `StreamingSessionOptions` deferred-fields note. (This documentation is **in-scope**, not optional — listed here, not in § 6's non-gating set.)

**Out of scope (explicitly):**
- **Session-id ownership enforcement** — see § 5. No application-service layer exists yet to host it; recorded as a requirement binding #412's gate, backed by a **mechanical tripwire** (§ 5) so it cannot be silently skipped.
- **The two non-gating probes** — dangling-`tool_use` resume and CLI-update survival (§ 6). Tracked, unrun.
- **Any #412 chat wiring** — the consumer of `ResumeSessionId`, including resume-failure fallback (§ 2.3-2), cwd persistence (§ 2.3-1), and the ownership check (§ 5). This slice lands only the contract + the verified provider behavior behind it.

## 4. Contract change

```csharp
public sealed record StreamingSessionOptions(
    string? Model = null,
    string? AppendSystemPrompt = null,
    string? WorkingDirectory = null,
    IReadOnlyList<string>? AllowedTools = null,
    IReadOnlyList<string>? DisallowedTools = null,
    string? ResumeSessionId = null);   // NEW — appended, optional, non-breaking
```

`ResumeSessionId` is a provider-originated opaque value (a prior session's `ProviderSessionId`). Null = start a fresh session (today's behavior, unchanged). Non-null = resume that session via `--resume`, restoring its full conversation context (§ 2). **The resume MUST use the same `WorkingDirectory` as the original session** (§ 2.3-1); a resume that cannot find its transcript fails hard, so passing `ResumeSessionId` is an **optimization** and the caller MUST be prepared to fall back to fresh-with-injection (§ 2.3-2). The caller is responsible for only passing ids of cleanly-ended, **caller-owned** sessions (§ 2.4, § 5) — Slice 3 documents this responsibility but does not implement an enforcement point for it.

**`AppendSystemPrompt` on resume (forward note for #412):** resuming re-spawns the process, so `--append-system-prompt` is re-evaluated at resume time and may diverge from the prompt the original session ran with. The parent-Slice-2 constraint (no mutable-source content through `AppendSystemPrompt`) applies to the resume spawn too; #412 must document its handling.

## 5. Security — session-id ownership (requirement + tripwire, not Slice-3 enforcement)

Parent design § 7 invariant: ownership verification for any `--resume` path is enforced at the **application service layer** (the component mapping an incoming request to a resume call), not at the provider/session. That layer is part of **#412 (PR chat)**, which the owner sequenced **after** all P0-1b slices (parent § 11a). Therefore **Slice 3 has no application-service layer in which to enforce ownership**. Confirmed in code: `PRism.Web` registers `IStreamingLlmProvider` but has **zero consumers** ("No consumer resolves IStreamingLlmProvider yet"); no HTTP path reaches `StartSession`.

**Decision:** record ownership verification as a requirement binding #412's gate — but, because the field becomes *spawnable* now (`--resume <id>` reaches a real subprocess) and its only Slice-3 guard is a **transport** check (not authorization), back the requirement with a **mechanical tripwire** so #412 cannot wire a caller and forget the auth check. The plan MUST add one of:
- a failing/`Skip`-with-reason guard test referencing #412 that turns red when any production caller sets `ResumeSessionId`, or
- an architecture/grep test asserting the **only** setter of `ResumeSessionId` in V2 is test code until #412 lands.

This converts "no consumer yet" from an assumption into a verified property, closing the gap between *no consumer* and *no reachable caller*.

**Forward-requirements binding #412 (documented now, enforced there):**
- Ownership: a resume request from a principal other than the originator is rejected **before** `--resume` is invoked.
- Confidentiality: `ProviderSessionId` / `claudeCodeSessionId` are not emitted at `Information`-level structured logs (resume key) and never returned to a non-originating caller.
- Resume-failure handling and cwd/`AppendSystemPrompt` handling per § 2.3 / § 4.

The provider still carries the single-token injection guard (§ 3) regardless — transport safety, orthogonal to authorization. *(Optional defense-in-depth the plan may add: a `Guid.TryParse` shape assertion, since observed ids are UUIDs — not required given the pre-split `Arguments` array + `UseShellExecute = false` spawn.)*

## 6. Tracked, non-gating (do not block this slice)

- **Dangling-`tool_use` resume** — forward-compat; sessions ending uncleanly are flagged `LastTurnEndedCleanly == false` and fall through to fresh-with-injection, so this path is never a `--resume` candidate. Stays an unchecked box on #479.
- **`--resume` survival across a CLI update** — spec assumes "no" (fall back to fresh-with-injection). Not tested here; stays tracked. The version-conditional pin (§ 2.4) and the #412 re-verification requirement (§ 5) cover the durability risk.

## 7. Risk classification & gates

- **Tier:** T3. **Risk:** B2 (AI foundation seam; the spawn gains a `--resume` arg; the resume path replays prior context). **Gated** — owner reviews this spec/approach before the plan and before the subprocess-touching code.
- **Egress delta over Slice 2:** minimal. No new network destination, no new credential path — `--resume` replays a server-side session the same account created. Env allowlist, tool deny-list, and working-dir confinement are unchanged from Slice 2.
- The human merge is the safety boundary; `ce-doc-review` dispositions are recorded in the PR `## Proof`.

## 8. Exit criteria

- [x] Probe run and **production-faithful re-run** complete; outcome + operational invariants recorded here (§ 2). To be propagated to parent § 6, verification-notes § C4 (gating checkbox resolved), and the project AI README.
- [x] `ResumeSessionId` added to `StreamingSessionOptions` with semantics-pinning XML doc (same-cwd, fail-hard, re-persist-new-id, fallback); deferred-fields note updated.
- [x] Provider appends `--resume <id>` when set; single-CLI-token guard applied via a correctly-named/commented validator (§ 3).
- [x] Unit tests green: present→flag-in-order, null→omitted, malformed-id→rejected. Clean-end ↔ resume-eligible pinned by the documentary characterization test (§ 2.4) and validated live through the real provider's `EndCleanlyAsync` path (manual driver, non-durable). The **durable** `[Integration]` resume assertion is deferred to #412 (recorded as a forward AC on the #479 issue body).
- [x] **Mechanical tripwire** in place (§ 5) that fails if a production caller wires `ResumeSessionId` before #412's ownership check exists.
- [x] Session-id ownership + confidentiality + resume-failure handling recorded as **unchecked ACs on the #479 issue body** (concrete artifact, not just spec prose), binding #412.
- [x] Full backend build + test suite green; secrets scan clean.
- [x] `ce-doc-review` dispositions recorded in PR `## Proof`; owner spec + plan gates cleared. **B2 → owner merges (no auto-merge).**

## 9. Resolved decisions

- **(2026-06-14) Probe outcome is full-context resume (#1), confirmed under the production cwd/env** (§ 2.2-A). P2-2 keeps the full-context promise *as of v2.1.177*; `ResumeSessionId` is meaningful.
- **(2026-06-14) Resume is working-directory-scoped and fails hard on mismatch** (§ 2.2-C, § 2.3). Production's stable confined base satisfies the same-cwd requirement; the contract documents it and #412 owns resume-failure fallback.
- **(2026-06-14) Ownership enforcement is a #412-bound requirement backed by a Slice-3 mechanical tripwire** (§ 5) — no application-service layer exists in this slice, but the field is spawnable, so the tripwire prevents a silent gap.
- **(2026-06-14) Same-session-id-on-resume is observed (N=2), not relied upon** (§ 2.3-3) — callers re-persist the post-resume id.
- **(2026-06-14) Process: short spec → owner gate → plan → owner gate → impl** (owner-chosen). The empirical unknown that motivated `needs-design` is resolved by the probe + faithful re-run; this doc is the design artifact.

Will close the P0-1b design arc once shipped and the § 8 exit criteria are met: #404 stays open as the roadmap root until this slice lands, then closes.
