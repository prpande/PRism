/* global React, ReactDOM, Logo, Icon, useTweaks, TweaksPanel, TweakSection, TweakSelect, TweakToggle, TweakColor, TweakRadio, PrHeader, IterationTabs, StaleDraftPanel, FileTree, DiffArea, AiChatDrawer, InboxScreen, SetupScreen, SubmitModal, Cheatsheet, prFiles, threads, inboxData */
const { useState, useEffect, useMemo, useRef } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "dark",
  "density": "comfortable",
  "diffMode": "sbs",
  "aiOn": true,
  "accent": "indigo",
  "showStale": true
}/*EDITMODE-END*/;

const ACCENTS = {
  indigo: { h: 245, c: 0.085, label: "Indigo" },
  amber: { h: 75, c: 0.10, label: "Amber" },
  teal: { h: 195, c: 0.075, label: "Teal" },
};

// Find a PR object by id across all inbox sections (so we can render tab labels)
const findPr = (id) => {
  for (const k of Object.keys(inboxData)) {
    const hit = inboxData[k].find((p) => p.id === id);
    if (hit) return hit;
  }
  return null;
};

// Demo: pre-open 3 PR tabs so the pattern is immediately legible
const INITIAL_TABS = [1842, 1839, 1827];
const INITIAL_ACTIVE = 1842; // currently focused PR

function App() {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // Tab state — `view` is 'inbox' | 'setup' | a PR id
  const [openTabs, setOpenTabs] = useState(INITIAL_TABS);
  const [view, setView] = useState(INITIAL_ACTIVE);
  const [unreadTabs, setUnreadTabs] = useState(new Set([1827])); // PRs with new activity
  const [overflowOpen, setOverflowOpen] = useState(false);

  // Per-PR state — the prototype's working PR (#1842) keeps its state;
  // other tabs display a lightweight "loading" stub when focused (a real app
  // would fan this out, but we only need #1842 deeply mocked).
  const [verdict, setVerdict] = useState("comment");
  const [submitOpen, setSubmitOpen] = useState(false);
  const [cheatOpen, setCheatOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [activeIter, setActiveIter] = useState("all");
  const [compareOpen, setCompareOpen] = useState(false);
  const [prTab, setPrTab] = useState("overview");
  const [selectedFile, setSelectedFile] = useState(0);
  const [files, setFiles] = useState(prFiles);
  const [hasUpdate, setHasUpdate] = useState(true);

  // Apply theme/density/accent to root
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", tweaks.theme);
    root.setAttribute("data-density", tweaks.density);
    const a = ACCENTS[tweaks.accent] || ACCENTS.indigo;
    root.style.setProperty("--accent-h", a.h);
    root.style.setProperty("--accent-c", a.c);
  }, [tweaks.theme, tweaks.density, tweaks.accent]);

  // Open a PR — push to tabs if not already open, then focus
  const openPr = (pr) => {
    const id = pr.id;
    setOpenTabs((tabs) => (tabs.includes(id) ? tabs : [...tabs, id]));
    setView(id);
    // Clear unread on focus
    setUnreadTabs((s) => {
      if (!s.has(id)) return s;
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  };

  const closeTab = (id, e) => {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    setOpenTabs((tabs) => {
      const next = tabs.filter((t) => t !== id);
      // If we just closed the active tab, focus the neighbor or fall back to inbox
      if (view === id) {
        const idx = tabs.indexOf(id);
        const nextActive = next[idx] || next[idx - 1] || "inbox";
        setView(nextActive);
      }
      return next;
    });
  };

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
      if (e.key === "?") { e.preventDefault(); setCheatOpen((o) => !o); }
      if (e.key === "Escape") { setCheatOpen(false); setSubmitOpen(false); setChatOpen(false); setOverflowOpen(false); }
      // ⌘W — close active PR tab
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w" && typeof view === "number") {
        e.preventDefault();
        closeTab(view);
        return;
      }
      // ⌘1-9 — jump to nth open PR tab
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        const n = parseInt(e.key, 10) - 1;
        if (openTabs[n] !== undefined) {
          e.preventDefault();
          setView(openTabs[n]);
          setUnreadTabs((s) => {
            if (!s.has(openTabs[n])) return s;
            const next = new Set(s);
            next.delete(openTabs[n]);
            return next;
          });
        }
        return;
      }
      // PR-context shortcuts only fire when a PR is focused
      if (typeof view === "number") {
        if (e.key === "j") setSelectedFile((i) => Math.min(files.length - 1, i + 1));
        if (e.key === "k") setSelectedFile((i) => Math.max(0, i - 1));
        if (e.key === "v") {
          setFiles((fs) => fs.map((f, i) => i === selectedFile ? { ...f, viewed: !f.viewed } : f));
        }
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); setSubmitOpen(true); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [files.length, selectedFile, view, openTabs]);

  const toggleViewed = (i) => {
    setFiles((fs) => fs.map((f, idx) => idx === i ? { ...f, viewed: !f.viewed } : f));
  };

  const aiOn = tweaks.aiOn;
  const isPrView = typeof view === "number";

  // The currently-focused PR meta (for tab strip + page rendering)
  const activePr = isPrView ? findPr(view) : null;

  // Inbox unread badge — count rows marked unread > 0
  const inboxUnread = useMemo(() => {
    let n = 0;
    Object.values(inboxData).forEach((arr) => arr.forEach((p) => { if (p.unread > 0) n += 1; }));
    return n;
  }, []);

  // Tab strip overflow handling — show first N inline, rest in chevron menu.
  // Threshold is generous (6) since most reviewers won't exceed that.
  const VISIBLE_TAB_LIMIT = 6;
  const visibleTabs = openTabs.slice(0, VISIBLE_TAB_LIMIT);
  const overflowTabs = openTabs.slice(VISIBLE_TAB_LIMIT);

  return (
    <div className="app">
      {/* Row 1 — app chrome (persistent) */}
      <header className="app-nav">
        <Logo />
        <nav className="app-nav-tabs">
          <button
            className={`app-nav-tab ${view === "inbox" ? "is-active" : ""}`}
            onClick={() => setView("inbox")}
          >
            Inbox
            {inboxUnread > 0 && <span className="app-nav-badge">{inboxUnread}</span>}
          </button>
          <button
            className={`app-nav-tab ${view === "setup" ? "is-active" : ""}`}
            onClick={() => setView("setup")}
          >Setup</button>
        </nav>
        <div className="app-nav-spacer" />
        <div className="app-nav-search">
          <Icon name="search" size={13} />
          <span className="grow">Jump to PR or file…</span>
          <span className="kbd">⌘K</span>
        </div>
        {aiOn && isPrView && (
          <button className="btn btn-secondary btn-sm" onClick={() => setChatOpen(true)}>
            <Icon name="sparkles" size={12} />
            Ask AI
          </button>
        )}
        <button className="btn-icon" onClick={() => setCheatOpen(true)} aria-label="Keyboard shortcuts">
          <Icon name="keyboard" size={15} />
        </button>
        <div className="avatar avatar-sm" style={{ background: "oklch(0.55 0.10 30)" }}>YO</div>
      </header>

      {/* Row 2 — dynamic PR tab strip (only renders when ≥1 tab open) */}
      {openTabs.length > 0 && (
        <div className="pr-tabbar" role="tablist" aria-label="Open pull requests">
          <div className="pr-tabbar-inner">
            {visibleTabs.map((id, idx) => {
              const pr = findPr(id);
              if (!pr) return null;
              const isActive = view === id;
              const isUnread = unreadTabs.has(id);
              return (
                <div
                  key={id}
                  role="tab"
                  aria-selected={isActive}
                  className={`pr-tabbar-tab ${isActive ? "is-active" : ""} ${isUnread ? "is-unread" : ""}`}
                  onClick={() => setView(id)}
                  onAuxClick={(e) => { if (e.button === 1) closeTab(id, e); }}
                  title={`${pr.title} — ${pr.repo}`}
                >
                  <span className="pr-tabbar-num">#{pr.id}</span>
                  <span className="pr-tabbar-title">{pr.title}</span>
                  {isUnread && <span className="pr-tabbar-dot" aria-label="Unread activity" />}
                  <button
                    className="pr-tabbar-close"
                    aria-label={`Close ${pr.title}`}
                    onClick={(e) => closeTab(id, e)}
                  >
                    <Icon name="x" size={12} />
                  </button>
                  {idx < 9 && <span className="pr-tabbar-shortcut">⌘{idx + 1}</span>}
                </div>
              );
            })}
            {overflowTabs.length > 0 && (
              <div className="pr-tabbar-overflow">
                <button
                  className="pr-tabbar-more"
                  onClick={() => setOverflowOpen((o) => !o)}
                  aria-haspopup="menu"
                  aria-expanded={overflowOpen}
                >
                  <Icon name="chevron-down" size={12} />
                  {overflowTabs.length} more
                </button>
                {overflowOpen && (
                  <div className="pr-tabbar-menu" role="menu">
                    {overflowTabs.map((id) => {
                      const pr = findPr(id);
                      if (!pr) return null;
                      return (
                        <button
                          key={id}
                          className="pr-tabbar-menu-item"
                          onClick={() => { setView(id); setOverflowOpen(false); }}
                        >
                          <span className="pr-tabbar-menu-num">#{pr.id}</span>
                          <span className="pr-tabbar-menu-title">{pr.title}</span>
                          <button
                            className="pr-tabbar-menu-close"
                            aria-label={`Close ${pr.title}`}
                            onClick={(e) => closeTab(id, e)}
                          >
                            <Icon name="x" size={11} />
                          </button>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <main className="app-body">
        {view === "inbox" && (
          <InboxScreen
            aiOn={aiOn}
            onOpenPr={openPr}
            hasUpdate={hasUpdate}
            onReload={() => setHasUpdate(false)}
          />
        )}
        {view === "setup" && (
          <SetupScreen onContinue={() => setView("inbox")} />
        )}
        {isPrView && view === 1842 && (
          <div className="pr-page">
            <PrHeader
              verdict={verdict}
              setVerdict={setVerdict}
              onSubmit={() => setSubmitOpen(true)}
              tab={prTab}
              setTab={setPrTab}
              fileCount={files.length}
              draftCount={tweaks.showStale ? window.staleDrafts.length : 0}
            />
            <IterationTabs
              active={activeIter}
              setActive={setActiveIter}
              compareOpen={compareOpen}
              setCompareOpen={setCompareOpen}
              show={prTab === "files"}
            />
            {hasUpdate && (
              <div className="banner">
                <Icon name="info" size={14} />
                <span className="grow">amelia.cho pushed iter 3 just now — 2 of your drafts may need attention.</span>
                <button className="btn btn-sm btn-secondary" onClick={() => setHasUpdate(false)}>
                  <Icon name="refresh" size={12} />
                  Reload
                </button>
                <button className="btn-icon" aria-label="Dismiss" onClick={() => setHasUpdate(false)}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            )}
            {prTab === "overview" && (
              <window.OverviewTab
                aiOn={aiOn}
                files={files}
                drafts={tweaks.showStale ? window.staleDrafts : []}
                threads={threads}
                onJumpToFiles={() => setPrTab("files")}
              />
            )}
            {prTab === "files" && (
              <div className="pr-main">
                <FileTree
                  files={files}
                  selectedIdx={selectedFile}
                  onSelect={setSelectedFile}
                  onToggleViewed={toggleViewed}
                  aiOn={aiOn}
                />
                <DiffArea
                  file={files[selectedFile]}
                  mode={tweaks.diffMode}
                  aiOn={aiOn}
                  threads={threads}
                />
              </div>
            )}
            {prTab === "drafts" && tweaks.showStale && (
              <div className="overview-tab">
                <div className="overview-grid">
                  <StaleDraftPanel drafts={window.staleDrafts} aiOn={aiOn} onResolve={() => {}} embedded />
                </div>
              </div>
            )}
          </div>
        )}
        {/* Stub for non-deeply-mocked PR tabs — keeps the prototype honest:
            real app would render full PR detail for any tab. */}
        {isPrView && view !== 1842 && activePr && (
          <div className="pr-stub">
            <div className="pr-stub-card">
              <div className="pr-stub-num">#{activePr.id}</div>
              <h2 className="pr-stub-title">{activePr.title}</h2>
              <div className="pr-stub-meta">{activePr.repo} · by {activePr.author} · iter {activePr.iteration}</div>
              <p className="pr-stub-note">
                This PR tab is open but not deeply mocked in the prototype.<br />
                In the real app, the same Overview / Files / Drafts UI you see in <button className="link" onClick={() => setView(1842)}>#1842</button> renders here too.
              </p>
              <div className="pr-stub-actions">
                <button className="btn btn-secondary" onClick={() => setView(1842)}>
                  Go to mocked PR
                </button>
                <button className="btn btn-ghost" onClick={() => closeTab(view)}>
                  Close tab
                  <span className="kbd">⌘W</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      <AiChatDrawer open={chatOpen && aiOn} onClose={() => setChatOpen(false)} />

      <SubmitModal
        open={submitOpen}
        verdict={verdict}
        aiOn={aiOn}
        onCancel={() => setSubmitOpen(false)}
        onConfirm={() => setSubmitOpen(false)}
      />
      <Cheatsheet open={cheatOpen} onClose={() => setCheatOpen(false)} />

      <TweaksPanel title="Tweaks">
        <TweakSection label="Appearance">
          <TweakRadio
            label="Theme"
            value={tweaks.theme}
            onChange={(v) => setTweak("theme", v)}
            options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
          />
          <TweakRadio
            label="Density"
            value={tweaks.density}
            onChange={(v) => setTweak("density", v)}
            options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]}
          />
          <TweakSelect
            label="Accent"
            value={tweaks.accent}
            onChange={(v) => setTweak("accent", v)}
            options={Object.keys(ACCENTS).map((k) => ({ value: k, label: ACCENTS[k].label }))}
          />
        </TweakSection>
        <TweakSection label="View">
          <TweakRadio
            label="Diff mode"
            value={tweaks.diffMode}
            onChange={(v) => setTweak("diffMode", v)}
            options={[{ value: "sbs", label: "Side-by-side" }, { value: "unified", label: "Unified" }]}
          />
        </TweakSection>
        <TweakSection label="AI augmentation">
          <TweakToggle
            label="Show v2 AI surfaces"
            value={tweaks.aiOn}
            onChange={(v) => setTweak("aiOn", v)}
          />
          <TweakToggle
            label="Show stale-draft panel"
            value={tweaks.showStale}
            onChange={(v) => setTweak("showStale", v)}
          />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
