/* global React */

// Icon set — Lucide-inspired, drawn as inline SVGs for crispness.
// All icons use currentColor and 1.5 stroke.
const Icon = ({ name, size = 16, className = "", style = {} }) => {
  const props = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    className,
    style,
    "aria-hidden": "true",
  };
  switch (name) {
    case "check":
      return <svg {...props}><path d="M20 6L9 17l-5-5" /></svg>;
    case "check-circle":
      return <svg {...props}><circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></svg>;
    case "x":
      return <svg {...props}><path d="M18 6L6 18M6 6l12 12" /></svg>;
    case "chevron-down":
      return <svg {...props}><path d="M6 9l6 6 6-6" /></svg>;
    case "chevron-right":
      return <svg {...props}><path d="M9 6l6 6-6 6" /></svg>;
    case "chevron-left":
      return <svg {...props}><path d="M15 6l-6 6 6 6" /></svg>;
    case "arrow-right":
      return <svg {...props}><path d="M5 12h14M13 5l7 7-7 7" /></svg>;
    case "search":
      return <svg {...props}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>;
    case "file":
      return <svg {...props}><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><path d="M14 3v5h5" /></svg>;
    case "file-code":
      return <svg {...props}><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><path d="M14 3v5h5" /><path d="M10 13l-2 2 2 2M14 13l2 2-2 2" /></svg>;
    case "folder":
      return <svg {...props}><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>;
    case "git-branch":
      return <svg {...props}><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M18 9a9 9 0 01-9 9" /></svg>;
    case "git-pull":
      return <svg {...props}><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><line x1="6" y1="8.5" x2="6" y2="15.5" /><circle cx="18" cy="18" r="2.5" /><path d="M14 6h4a2 2 0 012 2v8" /></svg>;
    case "message":
      return <svg {...props}><path d="M21 12a8 8 0 01-12 7l-5 1 1-5a8 8 0 1116-3z" /></svg>;
    case "message-plus":
      return <svg {...props}><path d="M21 12a8 8 0 01-12 7l-5 1 1-5a8 8 0 1116-3z" /><path d="M9 12h6M12 9v6" /></svg>;
    case "eye":
      return <svg {...props}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>;
    case "eye-off":
      return <svg {...props}><path d="M3 3l18 18" /><path d="M10.5 6.3a10 10 0 0111.5 5.7 10 10 0 01-2.6 3.6M6.4 6.4A10 10 0 002 12s3.5 7 10 7c1.7 0 3.3-.4 4.7-1.1" /><path d="M14.1 14.1a3 3 0 01-4.2-4.2" /></svg>;
    case "settings":
      return <svg {...props}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3h.1a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8v.1a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></svg>;
    case "keyboard":
      return <svg {...props}><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6" /></svg>;
    case "external":
      return <svg {...props}><path d="M14 4h6v6" /><path d="M10 14L20 4" /><path d="M20 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1h5" /></svg>;
    case "send":
      return <svg {...props}><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" /></svg>;
    case "alert":
      return <svg {...props}><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" /><path d="M12 9v4M12 17h.01" /></svg>;
    case "info":
      return <svg {...props}><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg>;
    case "refresh":
      return <svg {...props}><path d="M3 12a9 9 0 0115.5-6.3L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 01-15.5 6.3L3 16" /><path d="M3 21v-5h5" /></svg>;
    case "play":
      return <svg {...props}><polygon points="6 4 20 12 6 20 6 4" /></svg>;
    case "minus":
      return <svg {...props}><path d="M5 12h14" /></svg>;
    case "plus":
      return <svg {...props}><path d="M12 5v14M5 12h14" /></svg>;
    case "edit":
      return <svg {...props}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 113 3L7 19l-4 1 1-4z" /></svg>;
    case "trash":
      return <svg {...props}><path d="M3 6h18" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /><path d="M10 11v6M14 11v6M9 6V4a2 2 0 012-2h2a2 2 0 012 2v2" /></svg>;
    case "sparkles":
      return <svg {...props}><path d="M12 3l1.9 4.6L19 9.5l-4.6 1.9L12 16l-2.4-4.6L5 9.5l5.1-1.9z" /><path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z" /></svg>;
    case "command":
      return <svg {...props}><path d="M18 3a3 3 0 00-3 3v12a3 3 0 003 3 3 3 0 003-3 3 3 0 00-3-3H6a3 3 0 00-3 3 3 3 0 003 3 3 3 0 003-3V6a3 3 0 00-3-3 3 3 0 00-3 3 3 3 0 003 3h12a3 3 0 003-3 3 3 0 00-3-3z" /></svg>;
    case "copy":
      return <svg {...props}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>;
    case "swap":
      return <svg {...props}><path d="M7 16V4M3 8l4-4 4 4" /><path d="M17 8v12M21 16l-4 4-4-4" /></svg>;
    case "split":
      return <svg {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></svg>;
    case "rows":
      return <svg {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 12h18" /></svg>;
    case "circle":
      return <svg {...props}><circle cx="12" cy="12" r="9" /></svg>;
    case "circle-dot":
      return <svg {...props}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" fill="currentColor" /></svg>;
    case "filter":
      return <svg {...props}><path d="M3 4h18l-7 9v6l-4-2v-4z" /></svg>;
    case "more":
      return <svg {...props}><circle cx="5" cy="12" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="19" cy="12" r="1.4" fill="currentColor" /></svg>;
    case "user":
      return <svg {...props}><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>;
    case "users":
      return <svg {...props}><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.9M16 3.1A4 4 0 0119 7a4 4 0 01-3 3.9" /></svg>;
    case "at":
      return <svg {...props}><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 006 0v-1a10 10 0 10-3.9 7.9" /></svg>;
    case "play-circle":
      return <svg {...props}><circle cx="12" cy="12" r="9" /><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" /></svg>;
    case "github":
      return <svg {...props}><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 00-1-2.6c3.3-.4 6.8-1.6 6.8-7.3a5.7 5.7 0 00-1.6-4 5.3 5.3 0 00-.1-3.9s-1.3-.4-4.1 1.5a14 14 0 00-7.4 0C5.8.7 4.5 1.1 4.5 1.1a5.3 5.3 0 00-.1 3.9 5.7 5.7 0 00-1.6 4c0 5.7 3.5 6.9 6.8 7.3a3.4 3.4 0 00-1 2.6V23" /></svg>;
    case "lock":
      return <svg {...props}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg>;
    case "key":
      return <svg {...props}><circle cx="7" cy="15" r="4" /><path d="M10 12l11-11M16 7l3 3M14 9l3 3" /></svg>;
    case "panel-right":
      return <svg {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg>;
    default:
      return <svg {...props}><circle cx="12" cy="12" r="2" fill="currentColor" /></svg>;
  }
};

// Verdict picker — segmented control
const VerdictPicker = ({ value, onChange }) => {
  const opts = [
    { id: "comment", label: "Comment", icon: "message", tint: "neutral" },
    { id: "approve", label: "Approve", icon: "check-circle", tint: "success" },
    { id: "request", label: "Request changes", icon: "alert", tint: "danger" },
  ];
  return (
    <div className="verdict-picker" role="radiogroup" aria-label="Review verdict">
      {opts.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          className={`verdict-opt ${value === o.id ? `is-active is-${o.tint}` : ""}`}
          onClick={() => onChange(o.id)}
        >
          <Icon name={o.icon} size={14} />
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
};

// Tooltip — minimal
const Tip = ({ children, label }) => (
  <span className="tip-wrap">
    {children}
    <span className="tip">{label}</span>
  </span>
);

// Avatar with initials
const Avatar = ({ name, size = "" }) => {
  const initials = (name || "?")
    .split(" ")
    .map((s) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  // deterministic hue from name
  const hue = [...(name || "?")].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const cls = size ? `avatar avatar-${size}` : "avatar";
  return (
    <span
      className={cls}
      style={{ background: `oklch(0.55 0.10 ${hue})` }}
      aria-label={name}
    >
      {initials}
    </span>
  );
};

// Logo
const Logo = ({ withWord = true }) => (
  <span className="logo-row">
    <span className="logo-mark" aria-hidden>P</span>
    {withWord && <span className="logo-word">Rism</span>}
  </span>
);

Object.assign(window, {
  Icon, VerdictPicker, Tip, Avatar, Logo,
});
