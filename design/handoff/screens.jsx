/* global React, Icon, Avatar, Logo, VerdictPicker, inboxData, sectionsConfig */
const { useState, useMemo } = React;

// ============ INBOX ============
// Diff sparkline — a 60px-wide horizontal bar split between additions/deletions,
// scaled relative to the largest PR in the inbox so all rows share a visual scale.
const DiffBar = ({ additions, deletions, max }) => {
  const total = additions + deletions;
  if (!total) return null;
  const widthPct = Math.min(100, (total / max) * 100);
  const addPct = (additions / total) * 100;
  return (
    <span className="diffbar" title={`+${additions} −${deletions}`}>
      <span className="diffbar-track">
        <span className="diffbar-fill" style={{ width: `${widthPct}%` }}>
          <span className="diffbar-add" style={{ width: `${addPct}%` }} />
          <span className="diffbar-del" style={{ width: `${100 - addPct}%` }} />
        </span>
      </span>
    </span>
  );
};

// Friendly relative-time bucket — "fresh" / "today" / "older" — used to drive
// a left-edge accent on rows with very recent activity.
const freshness = (age) => {
  if (/m$/.test(age) && parseInt(age, 10) < 30) return "fresh";
  if (/^(m|h)$/.test(age.slice(-1))) return "today";
  return "older";
};

const InboxRow = ({ pr, aiOn, onOpen, maxDiff }) => {
  const fr = freshness(pr.age);
  return (
    <button
      className={`inbox-row inbox-row-${fr}`}
      onClick={onOpen}
    >
      <span className="inbox-row-status">
        {pr.ci === "failing" ? (
          <span className="dot dot-danger" title="CI failing" />
        ) : pr.unread > 0 ? (
          <span className="dot dot-accent" title="Unread updates" />
        ) : (
          <span className="dot" style={{ opacity: 0 }} />
        )}
      </span>
      <span className="inbox-row-main">
        <span className="inbox-row-title">{pr.title}</span>
        <span className="inbox-row-meta">
          <span className="row gap-1">
            <Icon name="git-branch" size={11} className="muted" />
            <span className="mono">{pr.repo}</span>
          </span>
          <span className="dotsep">·</span>
          <span className="row gap-1">
            <Avatar name={pr.author} size="sm" />
            <span>{pr.author}</span>
          </span>
          <span className="dotsep">·</span>
          <span className="mono muted-2">iter {pr.iteration}</span>
          <span className="dotsep">·</span>
          <span>{pr.age} ago</span>
        </span>
      </span>
      <span className="inbox-row-tail">
        {aiOn && pr.category && (
          <span className={`chip chip-${pr.categoryTone}`}>
            <Icon name="sparkles" size={10} />
            {pr.category}
          </span>
        )}
        <DiffBar additions={pr.additions} deletions={pr.deletions} max={maxDiff} />
        <span className="inbox-row-counts">
          <span className="tnum chip-success">+{pr.additions}</span>
          <span className="tnum chip-danger">−{pr.deletions}</span>
        </span>
        {pr.comments > 0 && (
          <span className="row gap-1 muted-2 tnum inbox-row-comments">
            <Icon name="message" size={12} />
            {pr.comments}
            {pr.unread > 0 && <span className="unread-badge">{pr.unread}</span>}
          </span>
        )}
      </span>
    </button>
  );
};

const InboxSection = ({ section, prs, aiOn, onOpen, defaultOpen = true, maxDiff }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`inbox-section ${section.emphasized ? "is-emphasized" : ""}`}>
      <button className="inbox-section-head" onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
        <span className="inbox-section-label">{section.label}</span>
        <span className="inbox-section-count">{prs.length}</span>
        {section.note && <span className="inbox-section-note muted-2">{section.note}</span>}
      </button>
      {open && (
        <div className="inbox-section-body">
          {prs.length === 0 ? (
            <div className="inbox-empty">
              <Icon name="check-circle" size={14} className="muted-2" />
              Nothing here. You're caught up.
            </div>
          ) : (
            prs.map((pr) => <InboxRow key={pr.id} pr={pr} aiOn={aiOn} onOpen={() => onOpen(pr)} maxDiff={maxDiff} />)
          )}
        </div>
      )}
    </section>
  );
};

// Right rail — activity feed. The thing that makes the page feel alive.
const ActivityFeed = () => {
  const items = [
    { who: "amelia.cho", what: "pushed iter 3 to", pr: "#1842", when: "12m" },
    { who: "noah.s", what: "commented on", pr: "#1810", when: "1h" },
    { who: "jules.t", what: "force-pushed", pr: "#1827", when: "3h" },
    { who: "rohan.k", what: "opened", pr: "#1839", when: "1h" },
    { who: "amelia.cho", what: "replied to your comment on", pr: "#1842", when: "2h" },
    { who: "ci-bot", what: "marked CI failing on", pr: "#1827", when: "3h", system: true },
  ];
  return (
    <aside className="inbox-rail">
      <div className="inbox-rail-section">
        <header className="inbox-rail-head">
          <span style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>Activity</span>
          <span className="muted-2" style={{ fontSize: "var(--text-xs)" }}>last 24h</span>
        </header>
        <ol className="activity-list">
          {items.map((it, i) => (
            <li key={i} className="activity-item">
              <div className="activity-rail">
                {it.system ? (
                  <span className="activity-icon system"><Icon name="alert" size={11} /></span>
                ) : (
                  <Avatar name={it.who} size="sm" />
                )}
                {i < items.length - 1 && <span className="activity-line" />}
              </div>
              <div className="activity-body">
                <div className="activity-text">
                  <span className="activity-who">{it.who}</span>
                  {" "}{it.what}{" "}
                  <a className="activity-pr mono" href="#">{it.pr}</a>
                </div>
                <div className="activity-time muted-2">{it.when} ago</div>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="inbox-rail-section">
        <header className="inbox-rail-head">
          <span style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>Watching</span>
        </header>
        <ul className="watch-list">
          {[
            { repo: "platform/billing-svc", count: 2 },
            { repo: "platform/tenants-api", count: 1 },
            { repo: "platform/web-edge", count: 0 },
          ].map((r) => (
            <li key={r.repo} className="watch-item">
              <Icon name="git-branch" size={12} className="muted-2" />
              <span className="mono grow">{r.repo}</span>
              {r.count > 0 ? (
                <span className="watch-count">{r.count}</span>
              ) : (
                <span className="muted-2" style={{ fontSize: 11 }}>idle</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
};

const InboxScreen = ({ aiOn, onOpenPr, hasUpdate, onReload }) => {
  // Compute the largest PR's diff size so DiffBars share a scale across sections.
  const allPrs = useMemo(() => Object.values(inboxData).flat(), []);
  const maxDiff = useMemo(
    () => Math.max(...allPrs.map((p) => p.additions + p.deletions), 1),
    [allPrs],
  );

  return (
    <div className="inbox-screen">
      {hasUpdate && (
        <div className="banner">
          <Icon name="info" size={14} />
          <span className="grow">3 PRs have updates since you last loaded.</span>
          <button className="btn btn-sm btn-ghost" onClick={onReload}>
            <Icon name="refresh" size={12} />
            Reload
          </button>
          <button className="btn-icon" aria-label="Dismiss"><Icon name="x" size={14} /></button>
        </div>
      )}

      <div className="inbox-shell">
        <div className="inbox-toolbar">
          <div className="inbox-paste">
            <Icon name="git-pull" size={14} className="muted" />
            <input
              className="inbox-paste-input"
              placeholder="Paste a PR URL to open it…"
              type="text"
            />
            <span className="kbd">⌘K</span>
          </div>
          <button className="btn btn-secondary btn-sm">
            <Icon name="filter" size={12} />
            Filter
          </button>
        </div>

        <div className="inbox-grid">
          <div className="inbox-sections">
            {sectionsConfig.map((s) => (
              <InboxSection
                key={s.id}
                section={s}
                prs={inboxData[s.id] || []}
                aiOn={aiOn}
                onOpen={onOpenPr}
                defaultOpen={s.id !== "ciFailing" && s.id !== "mentioned"}
                maxDiff={maxDiff}
              />
            ))}
            <div className="inbox-footer">
              <Icon name="info" size={12} />
              <span>2 PRs hidden — your token doesn't cover <span className="mono">platform/secrets</span> or <span className="mono">platform/audit</span>.</span>
              <a href="#">Configure token scope</a>
            </div>
          </div>
          <ActivityFeed />
        </div>
      </div>
    </div>
  );
};

// ============ SETUP ============
const SetupScreen = ({ onContinue }) => {
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const submit = () => {
    setLoading(true);
    setError(null);
    setTimeout(() => {
      setLoading(false);
      if (token.length < 10) {
        setError("That doesn't look like a valid PAT — they start with ghp_ or github_pat_.");
      } else {
        onContinue?.();
      }
    }, 700);
  };

  return (
    <div className="setup-screen">
      <div className="setup-bg" aria-hidden />
      <div className="setup-card">
        <div className="setup-brand">
          <Logo />
        </div>
        <h1 className="setup-title">Connect to GitHub</h1>
        <p className="setup-sub">
          PRism runs locally and talks to GitHub on your behalf using a personal access token. Your
          token never leaves this machine.
        </p>

        <div className="setup-section">
          <div className="setup-section-head">
            <span className="setup-num">1</span>
            <span>Generate a token on GitHub</span>
          </div>
          <a className="setup-link" href="#">
            <Icon name="external" size={12} />
            Open the PAT page (fine-grained, repo-scoped)
          </a>
          <div className="setup-scopes">
            <span className="setup-scopes-label">Required scopes</span>
            <div className="setup-scope-list">
              {["repo", "read:user", "read:org"].map((s) => (
                <span key={s} className="setup-scope mono">
                  {s}
                  <button className="btn-icon btn-icon-sm" aria-label={`Copy ${s}`}>
                    <Icon name="copy" size={11} />
                  </button>
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="setup-section">
          <div className="setup-section-head">
            <span className="setup-num">2</span>
            <span>Paste it below</span>
          </div>
          <div className="setup-input-wrap">
            <textarea
              className="textarea"
              placeholder="ghp_…   or   github_pat_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              style={{ paddingRight: "32px", minHeight: "60px", letterSpacing: showToken ? "normal" : "0.1em", WebkitTextSecurity: showToken ? "none" : "disc" }}
            />
            <button
              className="btn-icon setup-eye"
              onClick={() => setShowToken(!showToken)}
              aria-label={showToken ? "Hide token" : "Show token"}
            >
              <Icon name={showToken ? "eye-off" : "eye"} size={14} />
            </button>
          </div>
          {error && (
            <div className="setup-error">
              <Icon name="alert" size={12} />
              {error}
            </div>
          )}
        </div>

        <button
          className="btn btn-primary btn-lg setup-continue"
          disabled={!token || loading}
          onClick={submit}
        >
          {loading ? (
            <>
              <span className="spinner" />
              Validating…
            </>
          ) : (
            <>
              Continue
              <Icon name="arrow-right" size={14} />
            </>
          )}
        </button>

        <div className="setup-fineprint">
          <Icon name="lock" size={11} />
          <span>Stored in your OS keychain. Revoke anytime from GitHub settings.</span>
        </div>
      </div>
    </div>
  );
};

// ============ SUBMIT MODAL ============
const SubmitModal = ({ open, verdict, aiOn, onCancel, onConfirm }) => {
  if (!open) return null;
  const verdictMeta = {
    approve: { icon: "check-circle", tone: "success", label: "Approve" },
    request: { icon: "alert", tone: "danger", label: "Request changes" },
    comment: { icon: "message", tone: "info", label: "Comment" },
  }[verdict];
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 className="modal-title">Submit review</h2>
          <button className="btn-icon" onClick={onCancel} aria-label="Close"><Icon name="x" size={14} /></button>
        </div>
        <div className="modal-body">
          <div className="submit-section">
            <div className="submit-row">
              <span className="submit-label">Verdict</span>
              <span className={`submit-verdict submit-verdict-${verdictMeta.tone}`}>
                <Icon name={verdictMeta.icon} size={14} />
                {verdictMeta.label}
              </span>
            </div>
            <div className="submit-row">
              <span className="submit-label">Summary</span>
              <div className="submit-summary">
                Looks good in shape. The batched dispatch matches what we discussed in the design doc. One
                concern about failure semantics — see thread on line 65. <a href="#" className="muted-2">show all</a>
              </div>
            </div>
            <div className="submit-row">
              <span className="submit-label">Comments</span>
              <div className="submit-counts">
                <span className="chip chip-info"><Icon name="message-plus" size={11} /> 3 new</span>
                <span className="chip"><Icon name="message" size={11} /> 1 reply</span>
              </div>
            </div>
          </div>

          {aiOn && (
            <div className="submit-section ai-tint" style={{ padding: "var(--s-3) var(--s-4)", borderRadius: "var(--radius-3)" }}>
              <div className="row gap-2" style={{ alignItems: "flex-start" }}>
                <span className="ai-icon"><Icon name="sparkles" size={12} /></span>
                <div className="grow">
                  <div className="ai-summary-head">
                    <span className="ai-summary-label">AI validator</span>
                    <span className="chip chip-success"><Icon name="check" size={10} /> 2 checks passed</span>
                    <span className="chip chip-warning"><Icon name="alert" size={10} /> 1 heads-up</span>
                  </div>
                  <ul className="validator-list">
                    <li><Icon name="check" size={12} className="muted" /> Verdict matches comment severity</li>
                    <li><Icon name="check" size={12} className="muted" /> No drafts left in stale state</li>
                    <li>
                      <Icon name="alert" size={12} style={{ color: "var(--warning)" }} />
                      Your "Request changes" verdict cites failure semantics — consider also requesting a partial-failure test case.
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
            Once submitted, all drafts will be posted to GitHub atomically.
          </span>
          <div className="row gap-2">
            <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
            <button className="btn btn-primary" onClick={onConfirm}>
              Confirm submit
              <Icon name="arrow-right" size={12} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============ KEYBOARD CHEATSHEET ============
const Cheatsheet = ({ open, onClose }) => {
  if (!open) return null;
  const groups = [
    { label: "Navigation", keys: [
      { k: ["j"], v: "Next file" },
      { k: ["k"], v: "Previous file" },
      { k: ["g", "i"], v: "Go to inbox" },
      { k: ["g", "p"], v: "Open PR by URL" },
      { k: ["⌘", "K"], v: "Command palette" },
    ]},
    { label: "Review", keys: [
      { k: ["c"], v: "New comment on selection" },
      { k: ["v"], v: "Toggle file viewed" },
      { k: ["a"], v: "Approve" },
      { k: ["r"], v: "Request changes" },
      { k: ["⌘", "⏎"], v: "Submit review" },
    ]},
    { label: "Diff view", keys: [
      { k: ["d"], v: "Toggle side-by-side / unified" },
      { k: ["w"], v: "Cycle whitespace display" },
      { k: ["["], v: "Previous iteration" },
      { k: ["]"], v: "Next iteration" },
    ]},
    { label: "Help", keys: [
      { k: ["?"], v: "Toggle this cheatsheet" },
      { k: ["Esc"], v: "Close overlays" },
    ]},
  ];
  return (
    <div className="cheatsheet-overlay" onClick={onClose}>
      <div className="cheatsheet" onClick={(e) => e.stopPropagation()}>
        <div className="cheatsheet-head">
          <span className="row gap-2"><Icon name="keyboard" size={14} /><span style={{ fontWeight: 600 }}>Keyboard shortcuts</span></span>
          <button className="btn-icon" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="cheatsheet-grid">
          {groups.map((g) => (
            <div key={g.label} className="cheatsheet-group">
              <h4>{g.label}</h4>
              {g.keys.map((row, i) => (
                <div key={i} className="cheatsheet-row">
                  <span className="cheatsheet-keys">
                    {row.k.map((k, j) => (
                      <React.Fragment key={j}>
                        <span className="kbd">{k}</span>
                        {j < row.k.length - 1 && <span className="muted" style={{ fontSize: "var(--text-xs)" }}>then</span>}
                      </React.Fragment>
                    ))}
                  </span>
                  <span className="cheatsheet-desc">{row.v}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

window.InboxScreen = InboxScreen;
window.SetupScreen = SetupScreen;
window.SubmitModal = SubmitModal;
window.Cheatsheet = Cheatsheet;
