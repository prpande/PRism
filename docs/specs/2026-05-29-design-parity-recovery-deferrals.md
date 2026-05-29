---
date: 2026-05-29
topic: design-parity-recovery
kind: deferrals-sidecar
source-doc: docs/specs/2026-05-29-design-parity-recovery-design.md
plan-doc: docs/plans/2026-05-29-design-parity-recovery-pr1-foundation.md
---

# Design parity recovery — deferrals sidecar

Companion to [`2026-05-29-design-parity-recovery-design.md`](2026-05-29-design-parity-recovery-design.md) and the PR1 plan [`2026-05-29-design-parity-recovery-pr1-foundation.md`](../plans/2026-05-29-design-parity-recovery-pr1-foundation.md). Captures decisions / deferrals that surface during implementation; new entries are appended below.

---

### D3 — Sibling 401 endpoints (PrSubmit / PrDraftsDiscardAll) not flipped
**Date:** 2026-05-29 (PR1 implementation).
**Spec §:** 4.1.2.
**Decision:** Leave `PrSubmitEndpoints.SubmitAsync`, `ResumeForeignPendingReviewAsync`, `DiscardForeignPendingReviewAsync`, and `PrDraftsDiscardAllEndpoint.DiscardAllAsync` returning 401 (`"unauthorized"` SubmitErrorDto code) on `IsSubscribed == false`. Do NOT flip them to 403 in PR1.
**Why:** These are user-triggered mutating actions (submit, resume, discard). For the dev-mode cascade to fire, the user would have to dispatch one of these actions BEFORE the SSE-subscribe loop completes — which is structurally rare (the subscribe POST is `useEffect`-driven and fires on PR-detail mount, well before any user can click Submit or Resume). The Events/Subscribe path is different because it fires *automatically* on every PR detail navigation, so its 401 is the one that user-visibly bounces. Flipping submit/resume/discard would be a defensive change with no current symptom.
**Reversible:** Yes. If a future report observes a dev-mode bounce from a Submit action, the same 401→403 reasoning applies — flip those endpoints in a follow-up slice. `apiClient.ts`'s 401→prism-auth-rejected dispatch stays the load-bearing trigger; widening the 401→403 conversion is a narrow surface.
**Cross-refs:** Audit performed in PR1 plan Task 2 Step 2.6; affected endpoints enumerated in `grep -rn "Status401Unauthorized" PRism.Web/Endpoints/` output.
