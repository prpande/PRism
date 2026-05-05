/* global React, Icon, Avatar, Logo, VerdictPicker, prFiles, iterations, aiSummary, threads, diff, staleDrafts, DiffRow, CommentThread, AiHunkAnnotation, NewCommentComposer */
const { useState, useMemo } = React;

// ============ FILE TREE ============
const FileTreeRow = ({ file, selected, onSelect, onToggleViewed, aiOn }) => {
  const ext = file.path.split(".").pop();
  const name = file.path.split("/").pop();
  const dir = file.path.replace(`/${name}`, "");
  const statusIcon = {
    added: { ch: "A", tone: "success" },
    modified: { ch: "M", tone: "warning" },
    deleted: { ch: "D", tone: "danger" },
    renamed: { ch: "R", tone: "info" },
  }[file.status] || { ch: "·", tone: "neutral" };

  return (
    <button
      className={`tree-row ${selected ? "is-selected" : ""} ${file.viewed ? "is-viewed" : ""}`}
      onClick={onSelect}
    >
      <span
        className="tree-viewed"
        onClick={(e) => { e.stopPropagation(); onToggleViewed(); }}
        role="checkbox"
        aria-checked={file.viewed}
      >
        {file.viewed && <Icon name="check" size={11} />}
      </span>
      <span className={`tree-status tree-status-${statusIcon.tone}`}>{statusIcon.ch}</span>
      <span className="tree-name">
        <span className="tree-dir">{dir}/</span>
        <span className="tree-base">{name}</span>
      </span>
      <span className="tree-counts">
        <span className="tree-add">+{file.additions}</span>
        <span className="tree-rem">−{file.deletions}</span>
      </span>
      <span className="tree-ai" data-on={aiOn ? "1" : "0"}>
        {aiOn && file.aiFocus && (
          <span className={`ai-focus-dot ai-focus-${file.aiFocus}`} title={`AI focus: ${file.aiFocus}`} />
        )}
      </span>
    </button>
  );
};

const FileTree = ({ files, selectedIdx, onSelect, onToggleViewed, aiOn }) => {
  const viewedCount = files.filter((f) => f.viewed).length;
  return (
    <div className="filetree">
      <div className="filetree-head">
        <div className="row gap-2" style={{ alignItems: "baseline" }}>
          <span className="filetree-title">Files</span>
          <span className="muted tnum" style={{ fontSize: "var(--text-xs)" }}>
            {viewedCount}/{files.length} viewed
          </span>
        </div>
        <button className="btn-icon" aria-label="Filter files"><Icon name="filter" size={14} /></button>
      </div>
      <div className="filetree-progress">
        <div className="filetree-progress-bar" style={{ width: `${(viewedCount / files.length) * 100}%` }} />
      </div>
      <div className="filetree-list">
        {files.map((f, i) => (
          <FileTreeRow
            key={f.path}
            file={f}
            selected={i === selectedIdx}
            onSelect={() => onSelect(i)}
            onToggleViewed={() => onToggleViewed(i)}
            aiOn={aiOn}
          />
        ))}
      </div>
    </div>
  );
};

// ============ PR HEADER (slim — no embedded AI summary; that lives on Overview) ============
const PrHeader = ({ verdict, setVerdict, onSubmit, tab, setTab, fileCount, draftCount }) => (
  <div className="pr-header">
    <div className="pr-header-top">
      <div className="pr-meta col gap-1">
        <div className="row gap-2 muted-2" style={{ fontSize: "var(--text-xs)" }}>
          <span>platform/billing-svc</span>
          <span>·</span>
          <span className="row gap-1"><Icon name="git-pull" size={12} />#1842</span>
        </div>
        <h1 className="pr-title">Refactor LeaseRenewalProcessor to use the new BillingClient batch API</h1>
        <div className="row gap-3 muted-2 pr-subtitle">
          <span className="row gap-1"><Avatar name="amelia.cho" size="sm" /> amelia.cho</span>
          <span className="row gap-1"><Icon name="git-branch" size={12} /> amelia/batch-renewal → main</span>
          <span>· opened 3 days ago</span>
          <span className="chip chip-success"><Icon name="check-circle" size={11} /> CI passing</span>
          <span className="chip">Iter 3 · 12m ago</span>
        </div>
      </div>
      <div className="pr-actions">
        <VerdictPicker value={verdict} onChange={setVerdict} />
        <button className="btn btn-primary" onClick={onSubmit}>
          Submit review
          <span className="kbd" style={{ background: "rgba(255,255,255,0.2)", borderColor: "transparent", color: "currentColor" }}>⌘ ⏎</span>
        </button>
      </div>
    </div>
    <div className="pr-tabs" role="tablist">
      <button
        role="tab"
        aria-selected={tab === "overview"}
        className={`pr-tab ${tab === "overview" ? "is-active" : ""}`}
        onClick={() => setTab("overview")}
      >
        <Icon name="info" size={13} />
        Overview
      </button>
      <button
        role="tab"
        aria-selected={tab === "files"}
        className={`pr-tab ${tab === "files" ? "is-active" : ""}`}
        onClick={() => setTab("files")}
      >
        <Icon name="file-code" size={13} />
        Files
        <span className="pr-tab-count">{fileCount}</span>
      </button>
      <button
        role="tab"
        aria-selected={tab === "drafts"}
        className={`pr-tab ${tab === "drafts" ? "is-active" : ""}`}
        onClick={() => setTab("drafts")}
      >
        <Icon name="message" size={13} />
        Drafts
        {draftCount > 0 && <span className="pr-tab-count pr-tab-count-warn">{draftCount}</span>}
      </button>
    </div>
  </div>
);

// ============ ITERATION TABS — outlined chip cards, clearly clickable ============
const IterationTabs = ({ active, setActive, compareOpen, setCompareOpen, show = true }) => {
  if (!show) return null;
  return (
  <div className="iter-tabs">
    <div className="iter-tabs-strip">
      {iterations.map((it) => (
        <button
          key={it.id}
          className={`iter-chip ${active === it.id ? "is-active" : ""} ${it.id === "all" ? "iter-chip-all" : ""}`}
          onClick={() => setActive(it.id)}
        >
          {it.id === "all" ? (
            <Icon name="rows" size={12} />
          ) : (
            <span className="iter-chip-num">{it.label.replace("Iter ", "")}</span>
          )}
          <span className="iter-chip-label">{it.id === "all" ? "All" : "Iteration"}</span>
          {it.id !== "all" && (
            <span className="iter-chip-meta">
              <span className="iter-add tnum">+{it.additions}</span>
              <span className="iter-rem tnum">−{it.deletions}</span>
            </span>
          )}
          {it.isNew && <span className="iter-new-dot" />}
        </button>
      ))}
      <button className="iter-chip iter-chip-more">
        More iterations
        <Icon name="chevron-down" size={12} />
      </button>
    </div>
    <button
      className={`iter-compare ${compareOpen ? "is-open" : ""}`}
      onClick={() => setCompareOpen(!compareOpen)}
    >
      <Icon name="swap" size={12} />
      Compare
    </button>
  </div>
  );
};

// ============ OVERVIEW TAB — hero summary screen ============
const OverviewTab = ({ aiOn, files, drafts, threads, onJumpToFiles }) => {
  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalRem = files.reduce((s, f) => s + f.deletions, 0);
  const viewedCount = files.filter((f) => f.viewed).length;
  const totalThreads = threads.length;
  return (
    <div className="overview-tab">
      <div className="overview-grid">
        {/* AI summary card — main hero on left */}
        {aiOn && (
          <section className="overview-card overview-card-hero ai-tint">
            <header className="overview-card-head">
              <span className="row gap-2">
                <span className="ai-icon"><Icon name="sparkles" size={12} /></span>
                <span className="ai-summary-label">AI summary</span>
                <span className="muted" style={{ fontSize: "var(--text-xs)" }}>generated 11m ago · iter 3</span>
              </span>
              <button className="btn btn-sm btn-ghost"><Icon name="refresh" size={12} />Re-run</button>
            </header>
            <div className="overview-summary-body">{aiSummary.one_liner}</div>
            <ul className="overview-bullets">
              {aiSummary.bullets.map((b, i) => <li key={i}><span className="ov-bullet-dot" />{b}</li>)}
            </ul>
            {aiSummary.risks.map((r, i) => (
              <div key={i} className={`ai-risk ai-risk-${r.tone}`}>
                <Icon name="alert" size={12} />
                <span>{r.text}</span>
              </div>
            ))}
          </section>
        )}

        {/* PR description */}
        <section className="overview-card">
          <header className="overview-card-head">
            <span style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>Description</span>
            <span className="muted" style={{ fontSize: "var(--text-xs)" }}>by amelia.cho</span>
          </header>
          <div className="overview-desc">
            <p>The renewal worker has been holding leases for the full duration of a per-lease loop, which serializes one HTTP roundtrip per lease. This PR moves to the new <code>BillingClient.RenewBatchAsync</code> API and dispatches batches in parallel via <code>Task.WhenAll</code>.</p>
            <p>Behavior change to call out: <code>WhenAll</code> throws on first batch failure, where the previous loop swallowed individual failures. The renewal worker's caller already handles the throw — see <code>RenewalWorker.cs:142</code>.</p>
            <p>Plan for follow-up: add <code>MaxConcurrency</code> to <code>RenewalBatchOptions</code> in the next iteration once we wire this to the production worker.</p>
          </div>
        </section>

        {/* Stats row */}
        <section className="overview-stats">
          <div className="ov-stat">
            <div className="ov-stat-num tnum">{files.length}</div>
            <div className="ov-stat-label">files changed</div>
            <div className="ov-stat-sub">
              <span className="iter-add tnum">+{totalAdd}</span>
              <span className="iter-rem tnum">−{totalRem}</span>
            </div>
          </div>
          <div className="ov-stat">
            <div className="ov-stat-num tnum">{viewedCount}<span className="muted" style={{ fontSize: "var(--text-md)" }}>/{files.length}</span></div>
            <div className="ov-stat-label">files viewed</div>
            <div className="ov-stat-sub muted">{Math.round((viewedCount / files.length) * 100)}% reviewed</div>
          </div>
          <div className="ov-stat">
            <div className="ov-stat-num tnum">{totalThreads}</div>
            <div className="ov-stat-label">comment threads</div>
            <div className="ov-stat-sub muted">2 unread replies</div>
          </div>
          <div className="ov-stat">
            <div className="ov-stat-num tnum" style={{ color: "var(--warning-fg)" }}>{drafts.length}</div>
            <div className="ov-stat-label">drafts to reconcile</div>
            <div className="ov-stat-sub muted">since iter 3</div>
          </div>
        </section>

        {/* PR-root conversation */}
        <section className="overview-card pr-conv">
          <header className="overview-card-head">
            <span className="row gap-2">
              <span style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>Conversation</span>
              <span className="muted" style={{ fontSize: "var(--text-xs)" }}>{window.prRootThread.length} comments on this PR</span>
            </span>
            <button className="btn btn-sm btn-ghost"><Icon name="check-circle" size={12} />Mark all read</button>
          </header>
          <ol className="pr-conv-list">
            {window.prRootThread.map((c, i) => (
              <li key={c.id} className={`pr-conv-item ${c.isYou ? "is-you" : ""}`}>
                <div className="pr-conv-rail">
                  <Avatar name={c.author} size="sm" />
                  {i < window.prRootThread.length - 1 && <span className="pr-conv-line" />}
                </div>
                <div className="pr-conv-body">
                  <header className="pr-conv-meta">
                    <span className="pr-conv-author">{c.author}{c.isYou && <span className="pr-conv-you">you</span>}</span>
                    <span className="pr-conv-iter">on iter {c.iteration}</span>
                    <span className="pr-conv-time muted">· {c.time}</span>
                  </header>
                  <div className="pr-conv-text">
                    {c.body.split("\n\n").map((p, j) => <p key={j}>{p}</p>)}
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <div className="pr-conv-reply">
            <Avatar name="you" size="sm" />
            <button className="pr-conv-replyfield">Reply to this PR…</button>
          </div>
        </section>

        {/* Action footer */}
        <div className="overview-cta">
          <button className="btn btn-primary btn-lg" onClick={onJumpToFiles}>
            <Icon name="file-code" size={14} />
            Review files
            <Icon name="arrow-right" size={13} />
          </button>
          <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
            <span className="kbd">j</span> next file · <span className="kbd">k</span> previous · <span className="kbd">v</span> mark viewed
          </span>
        </div>
      </div>
    </div>
  );
};

// ============ STALE-DRAFT RECONCILIATION ============
const StaleDraftPanel = ({ drafts, aiOn, onResolve, embedded }) => {
  if (!drafts.length) return null;
  return (
    <div className={`stale-panel ${embedded ? "is-embedded" : ""}`}>
      <div className="stale-head">
        <div className="row gap-2" style={{ alignItems: "baseline" }}>
          <span className="stale-title">Drafts to reconcile</span>
          <span className="chip chip-warning">{drafts.length} need attention</span>
        </div>
        <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
          Iter 3 reshaped some lines your drafts were anchored to. Triage before submit.
        </span>
      </div>
      <div className="stale-list">
        {drafts.map((d) => (
          <div key={d.id} className="stale-row">
            <div className="stale-row-meta">
              <span className={`chip chip-${d.severity === "stale" ? "danger" : "warning"}`}>
                {d.severity === "stale" ? "Stale" : "Moved"}
              </span>
              <span className="mono stale-anchor">
                {d.file.split("/").pop()}:{d.line}
                {d.newLine && <> → :{d.newLine}</>}
              </span>
              <span className="muted stale-note">{d.note}</span>
            </div>
            <div className="stale-body">"{d.body}"</div>
            {aiOn && d.aiSuggestion && (
              <div className="stale-ai ai-tint">
                <span className="ai-icon"><Icon name="sparkles" size={11} /></span>
                <div>
                  <div className="ai-summary-label">AI suggestion</div>
                  <div>{d.aiSuggestion}</div>
                </div>
              </div>
            )}
            <div className="stale-actions">
              <button className="btn btn-sm btn-ghost"><Icon name="eye" size={12} />Show me</button>
              <button className="btn btn-sm btn-ghost"><Icon name="edit" size={12} />Edit</button>
              <button className="btn btn-sm btn-ghost"><Icon name="trash" size={12} />Discard</button>
              <button className="btn btn-sm btn-secondary" onClick={() => onResolve(d.id)}>Keep anyway</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ============ DIFF AREA ============
const DiffArea = ({ file, mode, aiOn, threads, onAddComment }) => {
  const [composing, setComposing] = useState(null);
  // group rows by line for annotation interleaving
  const rendered = useMemo(() => {
    const out = [];
    diff.forEach((row, i) => {
      out.push({ kind: "row", row, key: `r${i}` });
      // attach threads to last add/ctx with this newNum
      if (row.newNum) {
        threads.forEach((t) => {
          if (t.line === row.newNum && t.side === "new") {
            out.push({ kind: "thread", thread: t, key: `t${t.id}` });
          }
        });
      }
    });
    return out;
  }, [threads]);

  return (
    <div className="diff-area">
      <div className="diff-toolbar">
        <div className="row gap-2">
          <Icon name="file-code" size={14} className="muted" />
          <span className="mono diff-filepath">{file.path}</span>
          <span className="row gap-1">
            <span className="chip chip-success">+{file.additions}</span>
            <span className="chip chip-danger">−{file.deletions}</span>
          </span>
        </div>
        <div className="row gap-2">
          <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
            <span className="kbd">j</span> <span className="kbd">k</span> next/prev file
          </span>
          <button className="btn btn-sm btn-ghost" aria-label="Open on GitHub">
            <Icon name="external" size={12} />
          </button>
          <button className="btn btn-sm btn-ghost" aria-label="More">
            <Icon name="more" size={14} />
          </button>
        </div>
      </div>
      <div className={`diff-body diff-mode-${mode}`}>
        {mode === "sbs" && (
          <div className="diff-headers">
            <div className="diff-header">Before</div>
            <div className="diff-header">After</div>
          </div>
        )}
        {rendered.map((it) => {
          if (it.kind === "thread") {
            return <CommentThread key={it.key} thread={it.thread} aiOn={aiOn} />;
          }
          // also inject AI hunk note inline at the warn thread location
          return <DiffRow key={it.key} row={it.row} mode={mode} />;
        })}
        {composing && (
          <NewCommentComposer
            line={composing}
            aiOn={aiOn}
            onCancel={() => setComposing(null)}
            onSave={() => setComposing(null)}
          />
        )}
        <div className="diff-add-comment-bar">
          <button className="btn btn-sm btn-ghost" onClick={() => setComposing(64)}>
            <Icon name="message-plus" size={12} />
            Add comment on selection
          </button>
        </div>
      </div>
    </div>
  );
};

// ============ AI CHAT DRAWER ============
const AiChatDrawer = ({ open, onClose }) => (
  <aside className={`ai-drawer ${open ? "is-open" : ""}`} aria-hidden={!open}>
    <div className="ai-drawer-head">
      <span className="row gap-2">
        <span className="ai-icon"><Icon name="sparkles" size={12} /></span>
        <span style={{ fontWeight: 600 }}>Ask about this PR</span>
      </span>
      <button className="btn-icon" onClick={onClose}><Icon name="x" size={14} /></button>
    </div>
    <div className="ai-drawer-body">
      <div className="ai-msg ai-msg-user">
        Why did we move from sequential renewal to WhenAll? Was throughput the goal or something else?
      </div>
      <div className="ai-msg ai-msg-bot">
        <span className="ai-icon"><Icon name="sparkles" size={11} /></span>
        <div>
          <p>Looking at the PR description and the test changes, the primary goal was tail-latency: the renewal worker was holding a lease for the full duration of the loop, which serialized N HTTP roundtrips. Batching to <code>RenewBatchAsync</code> + <code>WhenAll</code> cuts that to <code>ceil(N / BatchSize)</code> parallel calls.</p>
          <p>One side-effect to confirm: <code>WhenAll</code> changes failure semantics — see the AI hunk note on line 65.</p>
        </div>
      </div>
    </div>
    <div className="ai-drawer-input">
      <textarea className="textarea" placeholder="Ask about this PR…" rows="2" />
      <button className="btn btn-primary btn-sm"><Icon name="send" size={12} /></button>
    </div>
  </aside>
);

window.OverviewTab = OverviewTab;
window.FileTree = FileTree;
window.PrHeader = PrHeader;
window.IterationTabs = IterationTabs;
window.StaleDraftPanel = StaleDraftPanel;
window.DiffArea = DiffArea;
window.AiChatDrawer = AiChatDrawer;
