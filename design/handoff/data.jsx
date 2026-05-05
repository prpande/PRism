/* global window */
// Sample data for the prototype.

const inboxData = {
  reviewRequested: [
    {
      id: 1842,
      title: "Refactor LeaseRenewalProcessor to use the new BillingClient batch API",
      repo: "platform/billing-svc",
      author: "amelia.cho",
      age: "12m",
      comments: 4,
      unread: 2,
      ci: "passing",
      iteration: 3,
      category: "Refactor",
      categoryTone: "info",
      additions: 184,
      deletions: 96,
    },
    {
      id: 1839,
      title: "Add bulk-redact endpoint to TenantsController",
      repo: "platform/tenants-api",
      author: "rohan.k",
      age: "1h",
      comments: 0,
      unread: 0,
      ci: "passing",
      iteration: 1,
      category: "Feature",
      categoryTone: "accent",
      additions: 312,
      deletions: 8,
    },
    {
      id: 1827,
      title: "Cache InvoiceTemplates per region; cut cold-path p99 by ~40%",
      repo: "platform/billing-svc",
      author: "jules.t",
      age: "3h",
      comments: 11,
      unread: 5,
      ci: "failing",
      iteration: 2,
      category: "Perf",
      categoryTone: "warning",
      additions: 91,
      deletions: 23,
    },
  ],
  awaitingAuthor: [
    {
      id: 1810,
      title: "Fix: BillingPeriod.Equals must compare UtcStart, not LocalStart",
      repo: "platform/billing-svc",
      author: "you",
      age: "2d",
      comments: 6,
      unread: 1,
      ci: "passing",
      iteration: 4,
      category: "Bug",
      categoryTone: "danger",
      additions: 14,
      deletions: 9,
    },
  ],
  authoredByMe: [
    {
      id: 1798,
      title: "Move AnalyticsHook off the request thread",
      repo: "platform/web-edge",
      author: "you",
      age: "5d",
      comments: 2,
      unread: 0,
      ci: "passing",
      iteration: 2,
      category: "Refactor",
      categoryTone: "info",
      additions: 78,
      deletions: 142,
    },
  ],
  mentioned: [
    {
      id: 1791,
      title: "WIP: experiment — replace Polly retry with custom backoff",
      repo: "platform/billing-svc",
      author: "noah.s",
      age: "1w",
      comments: 18,
      unread: 0,
      ci: "passing",
      iteration: 6,
      category: "Experiment",
      categoryTone: "warning",
      additions: 304,
      deletions: 211,
    },
  ],
  ciFailing: [
    {
      id: 1827,
      title: "Cache InvoiceTemplates per region; cut cold-path p99 by ~40%",
      repo: "platform/billing-svc",
      author: "jules.t",
      age: "3h",
      comments: 11,
      unread: 5,
      ci: "failing",
      iteration: 2,
      category: "Perf",
      categoryTone: "warning",
      additions: 91,
      deletions: 23,
    },
  ],
};

const sectionsConfig = [
  { id: "reviewRequested", label: "Review requested", emphasized: true },
  { id: "awaitingAuthor", label: "Awaiting author" },
  { id: "authoredByMe", label: "Authored by me" },
  { id: "mentioned", label: "Mentioned" },
  { id: "ciFailing", label: "CI failing" },
];

// PR Detail — files
const prFiles = [
  {
    path: "src/Billing/LeaseRenewalProcessor.cs",
    status: "modified",
    additions: 64,
    deletions: 38,
    viewed: false,
    aiFocus: "high",
  },
  {
    path: "src/Billing/Clients/BillingClient.cs",
    status: "modified",
    additions: 42,
    deletions: 12,
    viewed: false,
    aiFocus: "med",
  },
  {
    path: "src/Billing/Clients/IBillingClient.cs",
    status: "modified",
    additions: 8,
    deletions: 2,
    viewed: true,
    aiFocus: null,
  },
  {
    path: "src/Billing/Models/RenewalBatch.cs",
    status: "added",
    additions: 47,
    deletions: 0,
    viewed: false,
    aiFocus: "med",
  },
  {
    path: "src/Billing/Models/RenewalResult.cs",
    status: "modified",
    additions: 11,
    deletions: 7,
    viewed: false,
    aiFocus: null,
  },
  {
    path: "src/Billing/Diagnostics/RenewalMetrics.cs",
    status: "modified",
    additions: 6,
    deletions: 4,
    viewed: true,
    aiFocus: null,
  },
  {
    path: "tests/Billing.Tests/LeaseRenewalProcessorTests.cs",
    status: "modified",
    additions: 132,
    deletions: 41,
    viewed: false,
    aiFocus: "high",
  },
  {
    path: "tests/Billing.Tests/Fakes/FakeBillingClient.cs",
    status: "modified",
    additions: 22,
    deletions: 9,
    viewed: false,
    aiFocus: null,
  },
  {
    path: "docs/billing/renewal-batching.md",
    status: "added",
    additions: 84,
    deletions: 0,
    viewed: false,
    aiFocus: null,
    isMarkdown: true,
  },
  {
    path: "src/Billing.csproj",
    status: "modified",
    additions: 1,
    deletions: 0,
    viewed: true,
    aiFocus: null,
  },
];

// A diff for the selected file. Uses tokenized lines for syntax highlighting.
// Each line: { kind: 'add'|'rem'|'ctx'|'hunk', oldNum, newNum, tokens: [{t:'kw'|'str'|'num'|'cmt'|'type'|'fn'|'attr'|'p', v:string}] }
const diff = [
  {
    kind: "hunk",
    label: "@@ src/Billing/LeaseRenewalProcessor.cs:18 — class header & constructor",
    oldRange: "18,28",
    newRange: "18,34",
  },
  { kind: "ctx", oldNum: 18, newNum: 18, tokens: [
    { t: "p", v: "    " }, { t: "kw", v: "public sealed class " }, { t: "type", v: "LeaseRenewalProcessor" },
  ]},
  { kind: "ctx", oldNum: 19, newNum: 19, tokens: [{ t: "p", v: "    {" }] },
  { kind: "rem", oldNum: 20, newNum: null, tokens: [
    { t: "p", v: "        " }, { t: "kw", v: "private readonly " }, { t: "type", v: "IBillingClient" }, { t: "p", v: " _client;" },
  ]},
  { kind: "add", oldNum: null, newNum: 20, tokens: [
    { t: "p", v: "        " }, { t: "kw", v: "private readonly " }, { t: "type", v: "IBillingClient" }, { t: "p", v: " _client;" },
  ], wordHighlight: false },
  { kind: "add", oldNum: null, newNum: 21, tokens: [
    { t: "p", v: "        " }, { t: "kw", v: "private readonly " }, { t: "type", v: "RenewalBatchOptions" }, { t: "p", v: " _options;" },
  ], wordHighlight: true },
  { kind: "ctx", oldNum: 21, newNum: 22, tokens: [
    { t: "p", v: "        " }, { t: "kw", v: "private readonly " }, { t: "type", v: "ILogger<LeaseRenewalProcessor>" }, { t: "p", v: " _log;" },
  ]},
  { kind: "ctx", oldNum: 22, newNum: 23, tokens: [{ t: "p", v: "" }] },
  { kind: "rem", oldNum: 23, newNum: null, tokens: [
    { t: "p", v: "        " }, { t: "kw", v: "public " }, { t: "fn", v: "LeaseRenewalProcessor" }, { t: "p", v: "(" },
    { t: "type", v: "IBillingClient" }, { t: "p", v: " client, " },
    { t: "type", v: "ILogger<LeaseRenewalProcessor>" }, { t: "p", v: " log)" },
  ]},
  { kind: "add", oldNum: null, newNum: 24, tokens: [
    { t: "p", v: "        " }, { t: "kw", v: "public " }, { t: "fn", v: "LeaseRenewalProcessor" }, { t: "p", v: "(" },
  ], wordHighlight: false },
  { kind: "add", oldNum: null, newNum: 25, tokens: [
    { t: "p", v: "            " }, { t: "type", v: "IBillingClient" }, { t: "p", v: " client," },
  ], wordHighlight: false },
  { kind: "add", oldNum: null, newNum: 26, tokens: [
    { t: "p", v: "            " }, { t: "type", v: "RenewalBatchOptions" }, { t: "p", v: " options," },
  ], wordHighlight: true },
  { kind: "add", oldNum: null, newNum: 27, tokens: [
    { t: "p", v: "            " }, { t: "type", v: "ILogger<LeaseRenewalProcessor>" }, { t: "p", v: " log)" },
  ], wordHighlight: false },
  { kind: "ctx", oldNum: 24, newNum: 28, tokens: [{ t: "p", v: "        {" }] },
  { kind: "ctx", oldNum: 25, newNum: 29, tokens: [{ t: "p", v: "            _client = client;" }] },
  { kind: "add", oldNum: null, newNum: 30, tokens: [
    { t: "p", v: "            _options = options " }, { t: "kw", v: "?? throw new " }, { t: "fn", v: "ArgumentNullException" }, { t: "p", v: "(" }, { t: "kw", v: "nameof" }, { t: "p", v: "(options));" },
  ], wordHighlight: true },
  { kind: "ctx", oldNum: 26, newNum: 31, tokens: [{ t: "p", v: "            _log = log;" }] },
  { kind: "ctx", oldNum: 27, newNum: 32, tokens: [{ t: "p", v: "        }" }] },
  { kind: "ctx", oldNum: 28, newNum: 33, tokens: [{ t: "p", v: "" }] },

  {
    kind: "hunk",
    label: "@@ src/Billing/LeaseRenewalProcessor.cs:54 — Process()",
    oldRange: "54,38",
    newRange: "60,62",
  },
  { kind: "ctx", oldNum: 54, newNum: 60, tokens: [
    { t: "p", v: "        " }, { t: "kw", v: "public async " }, { t: "type", v: "Task<RenewalResult>" }, { t: "p", v: " " }, { t: "fn", v: "ProcessAsync" }, { t: "p", v: "(" },
    { t: "type", v: "IReadOnlyList<LeaseId>" }, { t: "p", v: " ids, " }, { t: "type", v: "CancellationToken" }, { t: "p", v: " ct)" },
  ]},
  { kind: "ctx", oldNum: 55, newNum: 61, tokens: [{ t: "p", v: "        {" }] },
  { kind: "rem", oldNum: 56, newNum: null, tokens: [
    { t: "p", v: "            " }, { t: "kw", v: "var " }, { t: "p", v: "results = " }, { t: "kw", v: "new " }, { t: "type", v: "List<RenewalResult>" }, { t: "p", v: "();" },
  ]},
  { kind: "rem", oldNum: 57, newNum: null, tokens: [
    { t: "p", v: "            " }, { t: "kw", v: "foreach " }, { t: "p", v: "(" }, { t: "kw", v: "var " }, { t: "p", v: "id " }, { t: "kw", v: "in " }, { t: "p", v: "ids)" },
  ]},
  { kind: "rem", oldNum: 58, newNum: null, tokens: [{ t: "p", v: "            {" }] },
  { kind: "rem", oldNum: 59, newNum: null, tokens: [
    { t: "p", v: "                " }, { t: "kw", v: "var " }, { t: "p", v: "r = " }, { t: "kw", v: "await " }, { t: "p", v: "_client." }, { t: "fn", v: "RenewAsync" }, { t: "p", v: "(id, ct);" },
  ]},
  { kind: "rem", oldNum: 60, newNum: null, tokens: [{ t: "p", v: "                results.Add(r);" }] },
  { kind: "rem", oldNum: 61, newNum: null, tokens: [{ t: "p", v: "            }" }] },
  { kind: "add", oldNum: null, newNum: 62, tokens: [
    { t: "cmt", v: "            // Batch into chunks of _options.BatchSize and dispatch in parallel" },
  ]},
  { kind: "add", oldNum: null, newNum: 63, tokens: [
    { t: "p", v: "            " }, { t: "kw", v: "var " }, { t: "p", v: "batches = " }, { t: "fn", v: "RenewalBatch" }, { t: "p", v: "." }, { t: "fn", v: "Partition" }, { t: "p", v: "(ids, _options.BatchSize);" },
  ], wordHighlight: true },
  { kind: "add", oldNum: null, newNum: 64, tokens: [
    { t: "p", v: "            " }, { t: "kw", v: "var " }, { t: "p", v: "results = " }, { t: "kw", v: "await " }, { t: "type", v: "Task" }, { t: "p", v: "." }, { t: "fn", v: "WhenAll" }, { t: "p", v: "(" },
  ], wordHighlight: true },
  { kind: "add", oldNum: null, newNum: 65, tokens: [
    { t: "p", v: "                batches." }, { t: "fn", v: "Select" }, { t: "p", v: "(b => _client." }, { t: "fn", v: "RenewBatchAsync" }, { t: "p", v: "(b, ct)));" },
  ], wordHighlight: true },
  { kind: "ctx", oldNum: 62, newNum: 66, tokens: [
    { t: "p", v: "            " }, { t: "kw", v: "return new " }, { t: "type", v: "RenewalResult" }, { t: "p", v: "(results." }, { t: "fn", v: "SelectMany" }, { t: "p", v: "(r => r.Items));" },
  ]},
  { kind: "ctx", oldNum: 63, newNum: 67, tokens: [{ t: "p", v: "        }" }] },
  { kind: "ctx", oldNum: 64, newNum: 68, tokens: [{ t: "p", v: "    }" }] },
  { kind: "ctx", oldNum: 65, newNum: 69, tokens: [{ t: "p", v: "}" }] },
];

// Existing comment threads, anchored to specific line numbers.
const threads = [
  {
    id: "t1",
    side: "new",
    line: 21, // after the _options field
    resolved: false,
    comments: [
      {
        author: "noah.s",
        time: "2 hours ago",
        body: "Why a separate options type instead of just a `BatchSize` int? Wondering if we plan to extend this — if not it's overkill.",
      },
      {
        author: "amelia.cho",
        time: "1 hour ago",
        body: "We're going to need a `MaxConcurrency` knob in the next iteration once we wire this to the renewal worker. Wanted to land the type now so the next PR is just a field addition.",
      },
    ],
  },
  {
    id: "t2",
    side: "new",
    line: 65, // batches.Select
    resolved: false,
    aiNote: {
      severity: "warn",
      text: "`Task.WhenAll` here will throw on the first failed batch. The previous loop swallowed individual failures and continued. Confirm this change in failure semantics is intentional.",
    },
    comments: [],
  },
];

// PR-root conversation — comments on the PR itself, not anchored to a line.
const prRootThread = [
  {
    id: "r1",
    author: "amelia.cho",
    time: "3 days ago",
    iteration: 1,
    body: "Opening this for early review — the `RenewBatchAsync` API just landed in `BillingClient` 4.2.0. Behavior change to flag: `WhenAll` throws on first batch failure where the previous serial loop swallowed individual failures. The renewal worker's caller already handles the throw (see `RenewalWorker.cs:142`).",
  },
  {
    id: "r2",
    author: "noah.s",
    time: "2 days ago",
    iteration: 1,
    body: "Generally on board with the direction. Two questions before I do a deep pass:\n\n1. Are we OK losing the partial-success semantics? If one tenant's batch fails, the remaining batches in the same wave never get to retry until the next worker tick.\n2. Can we get a `MaxConcurrency` knob? Unbounded `WhenAll` against the billing service made the SRE team nervous last time.",
  },
  {
    id: "r3",
    author: "amelia.cho",
    time: "2 days ago",
    iteration: 1,
    body: "@noah.s — (1) yes, intentional. The retry layer one level up handles this cleanly and the old swallow-and-continue was actually masking a class of bugs we caught last quarter. (2) Agreed, planning a follow-up PR — the type change in this PR sets us up for it to be a one-field addition.",
  },
  {
    id: "r4",
    author: "you",
    time: "1 day ago",
    iteration: 2,
    body: "Took a first pass — left a few line comments. Mostly looks great. The `RenewalBatchOptions` type is clean. My main concern is the failure semantics callout — let's make sure it's documented in the changelog and not just the PR body.",
    isYou: true,
  },
  {
    id: "r5",
    author: "amelia.cho",
    time: "12 minutes ago",
    iteration: 3,
    body: "Pushed iter 3 with the changelog entry and addressed the line comments. Ready for another look.",
  },
];

// Stale-draft reconciliation rows
const staleDrafts = [
  {
    id: "d1",
    severity: "stale",
    file: "src/Billing/LeaseRenewalProcessor.cs",
    line: 59,
    body: "Wrap this in try/catch and continue on failure — we shouldn't drop the rest of the batch.",
    note: "The line this anchored to no longer exists in iteration 3.",
    aiSuggestion: "The new code uses `Task.WhenAll` which throws on first failure. The intent of your draft still applies — consider re-attaching it to line 64 and asking about partial-failure handling.",
  },
  {
    id: "d2",
    severity: "moved",
    file: "src/Billing/Clients/BillingClient.cs",
    line: 112,
    newLine: 118,
    body: "Should this use `IHttpClientFactory` instead of a long-lived HttpClient?",
    note: "Anchor moved 6 lines down due to surrounding edits.",
  },
];

const iterations = [
  { id: "all", label: "All changes", filesChanged: 10, additions: 645, deletions: 222 },
  { id: "i1", label: "Iter 1", filesChanged: 6, additions: 320, deletions: 84, age: "3d ago" },
  { id: "i2", label: "Iter 2", filesChanged: 4, additions: 198, deletions: 110, age: "1d ago" },
  { id: "i3", label: "Iter 3", filesChanged: 5, additions: 127, deletions: 28, age: "12m ago", isNew: true },
];

const aiSummary = {
  one_liner: "Replaces a serial per-lease renewal loop with a batched, parallel WhenAll dispatch behind a new RenewalBatchOptions config.",
  bullets: [
    "Adds RenewalBatchOptions with BatchSize and (planned) MaxConcurrency knobs.",
    "Moves from sequential _client.RenewAsync calls to parallel _client.RenewBatchAsync via Task.WhenAll.",
    "Test coverage looks thorough but missing a partial-batch-failure case — see flagged note in tests/...Tests.cs.",
  ],
  risks: [
    { tone: "warn", text: "Failure semantics changed: WhenAll throws on first batch error; previous loop continued." },
  ],
};

Object.assign(window, {
  inboxData, sectionsConfig, prFiles, diff, threads, prRootThread, staleDrafts, iterations, aiSummary,
});
