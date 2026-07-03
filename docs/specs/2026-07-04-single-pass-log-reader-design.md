---
title: Single-pass AiInteractionLogReader
issue: 542
type: perf/refactor
status: design
origin: none
---

# Single-pass `AiInteractionLogReader.ReadFrom` (#542)

## Problem

`PRism.Web/Ai/AiInteractionLogReader.cs::ReadFrom` opens a fresh `FileStream` for **every
complete line** it consumes:

- `NextLineByteLength(filePath, offset)` opens a `FileStream` and scans from the current
  line's `offset` to that line's terminating `\n` — once per complete line, and
- `EndsWithNewline(filePath, ...)` opens one more, but only for the **final** line: it is
  short-circuited by `!atEof || EndsWithNewline(...)`, so every non-final line skips it.

For a cold-start backfill of a large log (~100k lines / ~20 MB) that is **~n redundant
`FileStream` opens** (≈100k, one per complete line, plus one for the final line). The byte
reads themselves are **O(n) total** — each `NextLineByteLength` scans only its own line from
that line's offset, not from the file start — so the cost this slice pays down is the
per-open **syscall / handle overhead**, not quadratic byte reads. Steady-state ticks read
only the small new tail, so the cost is bounded to the cold-backfill path — which is why it
was scoped-and-deferred from PR #541 (see `docs/plans/2026-06-19-ai-usage-spend-tracker.md`).

`ReadFrom` is `internal`, used only by `AiUsageRollupTailer`. Wire shape and the
`(IReadOnlyList<LogEntry> Entries, long NewOffset)` return contract are **unchanged** — only
the internal read strategy changes.

## Approach

Read the range `[startOffset, snapshotLength)` **once** into a single `byte[]` (snapshot
`stream.Length` before reading so a concurrent append is deferred to the next tick, matching
today's `FileShare.ReadWrite` open), then scan that buffer once for `\n` boundaries. Each
`\n` ends a complete line; the trailing bytes after the last `\n` are a partial line, left
for the next tick. No per-line re-open, no rescan.

The per-call read is capped at `DefaultMaxReadBytes` (64 MiB; overridable via a `maxReadBytes`
parameter for tests). This bounds the transient buffer and keeps `length - startOffset` inside
a 32-bit size on a multi-GB cold backfill (an unbounded `(int)` cast would overflow and the
tick would throw and stall forever, never advancing the offset). A capped read simply stops at
the last `\n` within the cap — the remainder is the ordinary partial-trailing-line case — so
`AiUsageRollupTailer` drains a large backlog over successive ticks with no special handling
(its loop already advances only to the returned offset and re-reads from there next tick). The
cap sits far above the stated worst case (~20 MB) and any single log line, so the common and
stated-large paths read in one call, unchanged.

Rejected: chunked/streaming scan that assembles lines across read-buffer boundaries. It
avoids the transient array but reintroduces cross-chunk `\r\n`/line-split edge cases — the
exact class of bug this seam must not have. The transient array is bounded to the
cold-backfill range, allocated once, and immediately collectable; correctness-simplicity
wins over shaving a one-time allocation on a cold path.

## Behaviour contract to preserve (byte-for-byte)

These are the observable guarantees of the current implementation. The rewrite MUST produce
identical `(Entries, NewOffset)` for every case below. The existing tests in
`AiInteractionLogReaderTests` already pin cases 1, 4, 6, and 8 (plus case 5's `\r\n`
terminator on the Windows CI runner, where `Environment.NewLine` is `\r\n`); cases 2, 3, and
7 are currently untested and are added in Testing below.

1. **Missing file** → `(empty, startOffset)`.
2. **`startOffset > fileLength`** (caller-detected truncation) → `(empty, startOffset)`.
3. **Empty file / `startOffset == fileLength`** → `(empty, startOffset)`.
4. **A line is "complete" iff it is `\n`-terminated.** The bytes after the final `\n` (if
   any) are a partial trailing line: **not emitted, and `NewOffset` stops before them.** An
   unterminated final line is *always* treated as partial, even when it is valid JSON.
5. **Line boundary is `\n`; terminator is that `\n` plus an immediately-preceding `\r`.**
   The scan locates each `\n` as the line boundary; the line's *terminator* is that `\n`,
   together with a `\r` when the byte immediately before the `\n` is `\r`. A line's byte
   length (added to the running offset) **includes** its terminator — `\n` counts 1 byte, a
   `\r\n` counts both. Content passed to the JSON parser **excludes** the terminator,
   including a trailing `\r` when present (mirrors `StreamReader.ReadLine`).
6. **Malformed / non-object / whitespace complete lines are skipped** (no `LogEntry` emitted)
   **but still advance `NewOffset`** past themselves. Only `\n`-terminated lines advance the
   offset.
7. **Byte offsets are UTF-8 byte counts, not char counts** — a multi-byte code point in a
   line must advance the offset by its encoded byte length.
8. **All-complete-lines** → `NewOffset == fileLength`.

Parse rules are unchanged (reuse the existing `TryParse`): a line parses iff it is a JSON
**object** carrying a parseable `timestamp` and a non-null deserialized `AiInteractionRecord`;
`JsonException` / `FormatException` / `InvalidOperationException` (valid JSON but not an
object) are swallowed to a skip.

## Non-goals / edge cases explicitly out of format

- **Lone `\r` (old-Mac) terminators and raw embedded newlines never occur**: the log is
  JSON objects written one-per-line with `Environment.NewLine` (`\n` or `\r\n`); JSON encodes
  interior newlines as the two-character escape `\n`, never a raw `0x0A` byte. Terminator
  detection therefore keys on `\n` only, with an adjacent `\r` folded into the terminator —
  the same split `NextLineByteLength` performs today. Faithfully reproducing
  `StreamReader.ReadLine`'s lone-`\r` splitting is a non-goal (unreachable input).
- **No BOM.** `ai-interactions.log` is written by `File.AppendAllText` (UTF-8, no
  byte-order mark; the file is created BOM-less on first append), so the raw-byte scan reads
  from `startOffset` with **no BOM-stripping step**. The current code decodes via
  `new StreamReader(stream, Encoding.UTF8)`, whose BOM detection *would* strip a leading BOM
  — reproducing that is a non-goal (unreachable input), and doing so would corrupt the byte
  offset. The rewrite must not special-case a BOM.
- **Mid-read truncation** (file shrinks between the length snapshot and the read) does not
  occur for an append-only log; the read fills what is actually available and scans that,
  never throwing.

## Testing

TDD. Keep every existing test in `AiInteractionLogReaderTests` green (they are the primary
oracle). Add byte-precision tests the current suite lacks, each asserting the exact
`NewOffset`:

- **Multi-byte UTF-8** in a line (e.g. a non-ASCII `prRef`): `NewOffset` advances by the
  UTF-8 byte length, and the following line still parses. Guards invariant 7 against a
  char-vs-byte regression.
- **Explicit truncation guard**: `startOffset > fileLength` → `(empty, startOffset)`
  (invariant 2, currently untested).
- **`startOffset == fileLength`** (tail fully consumed) → `(empty, startOffset)` (invariant 3).
- **Explicit `\n`-only terminators** (author bytes directly, not `Environment.NewLine`) so a
  Windows run also exercises the bare-`\n` path: multi-line read yields correct count and
  `NewOffset == fileLength`.
- **Explicit `\r\n`-terminated final line** (author `\r\n` bytes directly, independent of
  `Environment.NewLine`) so a Linux run also exercises the `\r`-strip path: the record parses
  (trailing `\r` excluded from content) **and** `NewOffset == fileLength` (both terminator
  bytes counted). Pins invariant 5's `\r`-strip contract on every platform — the .NET tests
  run on the Windows CI runner today, so without this the `\r`-strip has a Linux-only
  regression window.
- **Blank/whitespace complete line** between two records: skipped, offset advances past it
  (invariant 6, currently untested).

## Files

- Modify: `PRism.Web/Ai/AiInteractionLogReader.cs` — replace the `ReadFrom` loop with the
  single-pass buffer scan; delete `EndsWithNewline` and `NextLineByteLength`; keep `TryParse`
  and `LogEntry` unchanged.
- Test: `tests/PRism.Web.Tests/Ai/AiInteractionLogReaderTests.cs` — add the byte-precision
  cases above.
