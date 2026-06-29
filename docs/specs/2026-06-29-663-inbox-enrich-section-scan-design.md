# #663 — Drop the lock-held O(results × sections × items) section scan in enrichment-apply

**Issue:** [#663](https://github.com/prpande/PRism/issues/663) · **Tier:** T2 · **Risk:** hands-off · **Date:** 2026-06-29

## Problem

`InboxRefreshOrchestrator.OnInboxEnrichmentsReady` applies a settled AI-enrichment
batch while holding `_writerLock`. Inside its per-result loop it re-scans every
section for every result to discover which sections to mark changed:

```csharp
foreach (var r in evt.Results)                                  // R results
    ...
    foreach (var kv in current.Sections)                         // × S sections
        if (kv.Value.Any(p => p.Reference.PrId == r.PrId))       // × N items (linear .Any)
            changedSections.Add(kv.Key);
```

That inner block is `O(R × S × N)` over the whole inbox, run **on the enricher
callback thread under the writer lock**. Both `R` (batch size) and `N` (PRs across
all sections) grow with inbox size, so a large multi-repo inbox does more redundant
work per settled batch.

**Honest framing of the win.** This is **asymptotic / CPU-complexity hygiene**, not
a measured contention fix. The dominant `_writerLock` holder is `RefreshAsync`,
which holds the lock across `QueryAllAsync` + `batchReader.ReadAsync` + enricher I/O
(seconds of network) before releasing in `finally`; the enrichment-apply scan this
spec optimizes is microseconds-to-milliseconds of CPU by comparison. Collapsing
`O(R × S × N)` → `O(N + R)` removes redundant work on a lock-held path and is worth
doing on its own merits (the issue scopes it as a pure no-behavior-change
optimization), but it will not measurably move lock contention while RefreshAsync's
lock-across-I/O remains the larger source. That larger source is **out of scope**
here.

A second, lower-impact instance lives on the same per-tick path: `ComputeDiff`
builds a fresh `Dictionary<PrReference, PrInboxItem> newByRef` per section per
refresh tick and only ever consumes it via `ContainsKey` in the removal check.

## Fix

### Primary — fold the section-key resolution into the existing single pass

The orchestrator already builds `liveByPrId` (a `PrId → first item` map) one block
above the loop, for the `#410` content-token guard. Extend that **same single
walk** of `current.Sections` to also record, per PrId, every section key it appears
in. The per-result loop then does an O(1) dictionary lookup for both the token
check (representative item) and the changed-section marking (the section-key list),
making the whole apply `O(N + R)` instead of `O(R × S × N)`.

```csharp
// one pass over current.Sections
var liveByPrId = new Dictionary<string, (PrInboxItem Item, List<string> Sections)>(StringComparer.Ordinal);
foreach (var (sectionKey, items) in current.Sections)
    foreach (var p in items)
    {
        if (!liveByPrId.TryGetValue(p.Reference.PrId, out var entry))
            liveByPrId[p.Reference.PrId] = entry = (p, new List<string>());   // first occurrence == today's g.First()
        if (!entry.Sections.Contains(sectionKey)) entry.Sections.Add(sectionKey);
    }
```

In the loop, `live` becomes `entry.Item`, and the section scan becomes
`foreach (var key in entry.Sections) changedSections.Add(key);`.

### Behavior-preservation invariant (the one real judgment)

The current scan marks **every** section that contains the PrId. A PR legitimately
appears in more than one section (covered today by
`PR_in_two_non_paired_sections_with_placeholder_enricher_does_not_throw`: a PR in
two sections outside the deduplicator's configured pairs). So the folded map must
carry **all** section keys per PrId — `PrId → (item, List<string> sectionKeys)` —
**not** the issue's literally-suggested single-valued `Dictionary<PrId, string
sectionKey>`, which would drop the extra section(s) and change the published
`InboxUpdated.ChangedSectionIds`.

- **Representative item:** first occurrence in `current.Sections` enumeration order
  == today's `GroupBy(...).First()`. Unchanged.
- **Section keys:** every section the PrId appears in. `.Contains` guards against a
  duplicate key (a PrId twice in one section), matching `.Any()` adding the section
  once; the consuming `changedSections` is a `HashSet` anyway.

### Secondary — `newByRef` dictionary → `HashSet<PrReference>`

`ComputeDiff`'s `newByRef` is consumed only by `!newByRef.ContainsKey(o.Reference)`.
Replace it with `var newRefs = new HashSet<PrReference>(kv.Value.Select(p => p.Reference));`
and `if (!newRefs.Contains(o.Reference))`. `oldByRef` stays a dictionary (its value
is read for the field comparison). `PrReference` is a record with structural
equality, so the set keys correctly.

**Throw-vs-silence asymmetry (intentional, inert).** `ToDictionary(p => p.Reference)`
throws `ArgumentException` on a duplicate reference within one section; the `HashSet`
silently dedups instead. Each section is materialized from a distinct GitHub
search/query and never carries a duplicate ref, so this path does not throw today —
the change is observationally inert on every realizable batch. `oldByRef` stays
`ToDictionary`, so the old/new sides are deliberately asymmetric (the removal check
only needs set membership; the field comparison needs the value).

## Acceptance criteria

1. `OnInboxEnrichmentsReady` does no per-result section scan; section keys come from
   an O(1) lookup into a map built in one pre-loop pass.
2. Published `InboxUpdated(ChangedSectionIds, NewOrUpdatedPrCount)` and the committed
   snapshot (`Enrichments`, `AiEnrichmentSettled`) are equivalent to today for every
   **realizable** batch (no duplicate ref within a single section) — **including a PR
   in two sections** (new test). The `ChangedSectionIds` *set* is identical;
   equivalence holds regardless of dictionary enumeration order because the old scan
   and the new map enumerate the **same** `current.Sections` in the same order and
   both feed a `HashSet`. (The only non-realizable divergence is the inert
   throw-vs-silence case in the secondary change above.)
3. `ComputeDiff` uses a `HashSet<PrReference>` for the removal check.
4. All existing `InboxRefreshOrchestratorTests` pass unchanged.

## Testing

- **New characterization test** `OnInboxEnrichmentsReady_marks_all_sections_for_a_multi_section_PR`:
  a PR in two non-paired sections, publish a token-matched `InboxEnrichmentsReady`,
  assert the published `InboxUpdated.ChangedSectionIds` contains **both** section
  keys. This is the discriminator — it goes **red** against the naive single-valued
  dict and **green** against the section-preserving map, demonstrating the test has
  teeth around the exact subtlety above. It is a **forward regression guard**: it
  passes against both today's nested scan and the corrected map, and only fails
  against the rejected single-valued-dict shape (so it is not a red-on-main test).
  Build it on a **real `ReviewEventBus`** via the existing `BuildOrchestrator`
  helper — `RecordingEventBus`'s `Subscribe` is a no-op, so subscribing to it would
  make the handler never fire and the assertion pass vacuously.
- Full `PRism.Core.Tests` suite green (no behavior change elsewhere).

## Out of scope / non-goals

- No change to locking strategy, lock scope, ordering, event payload shape, or the
  `#410` token guard / `#508` chip-less-settle behavior.
- Not micro-optimizing the network/IO paths; this is CPU-under-lock only.
