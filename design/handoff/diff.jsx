/* global React, Icon, Avatar */
const { useState } = React;

// Render a single tokenized line of code.
const TokenizedLine = ({ tokens }) => (
  <>{tokens.map((tk, i) => {
    if (tk.t === "p") return <span key={i}>{tk.v}</span>;
    return <span key={i} className={`tok tok-${tk.t}`}>{tk.v}</span>;
  })}</>
);

// One row in the diff (side-by-side has L/R; unified has 1)
const DiffRow = ({ row, mode = "sbs" }) => {
  if (row.kind === "hunk") {
    return (
      <div className="diff-hunk">
        <span className="diff-hunk-range">@@ {row.oldRange} → {row.newRange} @@</span>
        <span className="diff-hunk-label">{row.label.replace(/^@@ [^—]+— /, "")}</span>
      </div>
    );
  }
  if (mode === "unified") {
    const cls = `diff-line diff-${row.kind} ${row.wordHighlight ? "has-word-hl" : ""}`;
    const sign = row.kind === "add" ? "+" : row.kind === "rem" ? "-" : " ";
    return (
      <div className={cls}>
        <span className="diff-num">{row.oldNum ?? ""}</span>
        <span className="diff-num">{row.newNum ?? ""}</span>
        <span className="diff-sign">{sign}</span>
        <span className="diff-code"><TokenizedLine tokens={row.tokens} /></span>
      </div>
    );
  }
  // side-by-side
  const isAdd = row.kind === "add";
  const isRem = row.kind === "rem";
  return (
    <div className={`diff-line-sbs ${row.wordHighlight ? "has-word-hl" : ""}`}>
      <div className={`diff-half ${isRem ? "diff-rem" : "diff-ctx"}`}>
        <span className="diff-num">{row.oldNum ?? ""}</span>
        <span className="diff-sign">{isRem ? "-" : " "}</span>
        <span className="diff-code">
          {isRem || row.kind === "ctx" ? <TokenizedLine tokens={row.tokens} /> : <span className="diff-empty" />}
        </span>
      </div>
      <div className={`diff-half ${isAdd ? "diff-add" : "diff-ctx"}`}>
        <span className="diff-num">{row.newNum ?? ""}</span>
        <span className="diff-sign">{isAdd ? "+" : " "}</span>
        <span className="diff-code">
          {isAdd || row.kind === "ctx" ? <TokenizedLine tokens={row.tokens} /> : <span className="diff-empty" />}
        </span>
      </div>
    </div>
  );
};

// Comment thread inline widget
const CommentThread = ({ thread, aiOn, onReply }) => {
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState("");
  return (
    <div className="thread-widget">
      <div className="thread-anchor">
        <span className="thread-anchor-line">line {thread.line}</span>
        {thread.resolved && <span className="chip chip-success">Resolved</span>}
      </div>
      <div className="thread-body">
        {thread.comments.map((c, i) => (
          <div className="comment" key={i}>
            <Avatar name={c.author} size="sm" />
            <div className="comment-content">
              <div className="comment-meta">
                <span className="comment-author">{c.author}</span>
                <span className="muted comment-time">{c.time}</span>
              </div>
              <div className="comment-body">{c.body}</div>
            </div>
          </div>
        ))}
        {aiOn && thread.aiNote && (
          <div className="ai-note">
            <span className="ai-icon"><Icon name="sparkles" size={11} /></span>
            <div>
              <div className="ai-note-meta">
                <span>AI hunk note</span>
                <span className={`chip chip-${thread.aiNote.severity === "warn" ? "warning" : "info"}`}>
                  {thread.aiNote.severity === "warn" ? "Heads up" : "Info"}
                </span>
              </div>
              <div className="ai-note-body">{thread.aiNote.text}</div>
            </div>
          </div>
        )}
        {replying ? (
          <div className="reply-composer">
            <textarea
              className="textarea"
              placeholder="Reply…"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              autoFocus
            />
            <div className="row gap-2" style={{ justifyContent: "flex-end", marginTop: "8px" }}>
              {aiOn && (
                <button className="btn btn-sm btn-ghost ai-btn">
                  <Icon name="sparkles" size={12} />
                  Refine with AI
                </button>
              )}
              <button className="btn btn-sm btn-ghost" onClick={() => { setReplying(false); setReplyText(""); }}>
                Cancel
              </button>
              <button className="btn btn-sm btn-secondary">Save draft</button>
            </div>
          </div>
        ) : (
          <button className="thread-reply-btn" onClick={() => setReplying(true)}>
            <Icon name="message-plus" size={13} />
            Reply
          </button>
        )}
      </div>
    </div>
  );
};

// Inline AI hunk annotation (different from a thread — it's a free AI note between code lines)
const AiHunkAnnotation = ({ note }) => (
  <div className="ai-hunk">
    <span className="ai-icon"><Icon name="sparkles" size={11} /></span>
    <div className="ai-hunk-body">
      <div className="ai-hunk-meta">
        <span>AI</span>
        <span className={`chip chip-${note.severity === "warn" ? "warning" : "info"}`}>
          {note.severity === "warn" ? "Behavior change" : "Note"}
        </span>
      </div>
      <div>{note.text}</div>
      <div className="ai-hunk-actions">
        <button className="btn btn-sm btn-ghost"><Icon name="message-plus" size={12} />Quote in comment</button>
        <button className="btn btn-sm btn-ghost"><Icon name="x" size={12} />Dismiss</button>
      </div>
    </div>
  </div>
);

// Composer for a new comment (anchored to a line)
const NewCommentComposer = ({ line, aiOn, onCancel, onSave }) => {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(false);
  return (
    <div className="thread-widget thread-new">
      <div className="thread-anchor">
        <span className="thread-anchor-line">new comment · line {line}</span>
      </div>
      <div className="thread-body">
        <div className="composer-tabs">
          <button className={`tab ${!preview ? "is-active" : ""}`} onClick={() => setPreview(false)}>Write</button>
          <button className={`tab ${preview ? "is-active" : ""}`} onClick={() => setPreview(true)}>Preview</button>
        </div>
        {preview ? (
          <div className="composer-preview">{text || <span className="muted">Nothing to preview</span>}</div>
        ) : (
          <textarea
            className="textarea"
            placeholder="Leave a comment. Markdown supported."
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
        )}
        <div className="composer-actions">
          {aiOn ? (
            <button className="btn btn-sm btn-ghost ai-btn">
              <Icon name="sparkles" size={12} />
              Refine with AI
            </button>
          ) : <span />}
          <div className="row gap-2">
            <button className="btn btn-sm btn-ghost" onClick={onCancel}>Discard</button>
            <button className="btn btn-sm btn-secondary" onClick={() => onSave?.(text)}>Save draft</button>
          </div>
        </div>
      </div>
    </div>
  );
};

window.DiffRow = DiffRow;
window.CommentThread = CommentThread;
window.AiHunkAnnotation = AiHunkAnnotation;
window.NewCommentComposer = NewCommentComposer;
