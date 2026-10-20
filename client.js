window.__ModuleLoader__.load({
id: "dsh-prime",
factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

const React = require("react");
const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
const Button = primitives.Button;
const Input = primitives.Input;
const SegmentedControl = primitives.SegmentedControl;
const Switch = primitives.Switch;
const IconCloseOutlineRegular = primitives.IconCloseOutlineRegular;
const IconRefreshOutlineRegular = primitives.IconRefreshOutlineRegular;
const h = React.createElement;

const NS = "dsh-prime";
const API = "/prime/api";
const CSS_ID = NS + "-settings-css";
const SCOPES = [
{ value: "session", label: "Conversation", hint: "Saved to this chat only; the agent still reads both layers." },
{ value: "workspace", label: "Workspaces", hint: "Shared across every chat in the same repository folder." }
];
const KINDS = [
{ value: "memory", label: "Memory", placeholder: "Add a durable fact or constraint…" },
{ value: "prompt", label: "Prompt", placeholder: "Add a standing behavioral or routing rule…" },
{ value: "skill", label: "Skill", placeholder: "Describe the reusable workflow steps…" },
{ value: "subagent", label: "Subagent", placeholder: "Describe the specialist subagent role & instructions…" }
];

const CSS = [
".dp-root{display:flex;flex-direction:column;gap:16px;font-size:13px;color:inherit;padding-bottom:12px}",
".dp-hdr{display:flex;flex-direction:column;gap:4px}",
".dp-h{margin:0;font-size:16px;font-weight:600;letter-spacing:-0.01em}",
".dp-sub{margin:0;opacity:.62;font-size:12.5px;line-height:1.5}",
".dp-sub code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;padding:1px 5px;border-radius:4px;background:rgba(127,127,127,0.12)}",
".dp-group{border:1px solid var(--dsh-border,rgba(127,127,127,0.2));border-radius:10px;background:rgba(127,127,127,0.025);overflow:hidden}",
".dp-group-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 14px}",
".dp-group-row+.dp-group-row{border-top:1px solid var(--dsh-border,rgba(127,127,127,0.14))}",
".dp-group-info{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}",
".dp-group-title{font-weight:500;font-size:13px;display:flex;align-items:center;gap:8px}",
".dp-group-desc{font-size:11.5px;opacity:.58;line-height:1.35}",
".dp-link{border:none;background:transparent;color:#60a5fa;cursor:pointer;font:inherit;font-size:11.5px;padding:0}",
".dp-link:hover{text-decoration:underline}",
".dp-sec-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 2px 0}",
".dp-sec-title{font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;opacity:.65;display:flex;align-items:center;gap:8px}",
".dp-sec-actions{display:flex;align-items:center;gap:6px}",
".dp-pill-btn{border:1px solid var(--dsh-border,rgba(127,127,127,0.22));background:transparent;color:inherit;font:inherit;font-size:11px;padding:3px 9px;border-radius:999px;cursor:pointer;opacity:.7;transition:opacity .12s,background .12s}",
".dp-pill-btn:hover{opacity:1;background:rgba(127,127,127,0.08)}",
".dp-pill-btn-on{opacity:1;background:rgba(127,127,127,0.14);font-weight:500}",
".dp-kinds{display:flex;align-items:center;gap:4px;flex-wrap:wrap}",
".dp-kind-pill{border:1px solid transparent;background:rgba(127,127,127,0.08);color:inherit;font:inherit;font-size:11.5px;padding:3px 10px;border-radius:6px;cursor:pointer;opacity:.68;transition:all .12s}",
".dp-kind-pill:hover{opacity:.95}",
".dp-kind-pill-active{opacity:1;font-weight:500;background:rgba(59,130,246,0.14);border-color:rgba(59,130,246,0.4);color:#60a5fa}",
".dp-compose{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:8px;background:rgba(127,127,127,0.035);border:1px solid var(--dsh-border,rgba(127,127,127,0.16))}",
".dp-row{display:flex;gap:8px;align-items:center}",
".dp-input{flex:1}",
".dp-name-input{width:150px;flex:0 0 150px}",
".dp-cards{display:flex;flex-direction:column;gap:6px}",
".dp-card{border:1px solid var(--dsh-border,rgba(127,127,127,0.2));border-radius:10px;overflow:hidden;background:rgba(127,127,127,0.02);transition:border-color .12s}",
".dp-card-open{border-color:var(--dsh-border,rgba(127,127,127,0.32));background:rgba(127,127,127,0.03)}",
".dp-card-hdr{width:100%;display:flex;align-items:center;gap:8px;padding:9px 12px;border:none;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}",
".dp-card-hdr:hover{background:rgba(127,127,127,0.04)}",
".dp-card-chev{font-size:10px;opacity:.5;width:12px;display:inline-block;transition:transform .12s}",
".dp-card-title{font-weight:600;font-size:13px;flex:1;display:flex;align-items:center;gap:8px;min-width:0}",
".dp-card-path{opacity:.42;font-weight:400;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
".dp-card-body{padding:10px 12px 12px;border-top:1px solid var(--dsh-border,rgba(127,127,127,0.14));display:flex;flex-direction:column;gap:10px}",
".dp-card-ftr{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:6px;border-top:1px solid var(--dsh-border,rgba(127,127,127,0.1));font-size:11.5px}",
".dp-ftr-group{display:flex;align-items:center;gap:6px}",
".dp-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;max-height:300px;overflow:auto}",
".dp-item{display:flex;gap:10px;align-items:flex-start;padding:7px 10px;border-radius:7px;border:1px solid var(--dsh-border,rgba(127,127,127,0.14));background:rgba(127,127,127,0.015)}",
".dp-item:hover{border-color:var(--dsh-border,rgba(127,127,127,0.26))}",
".dp-rank{opacity:.38;font-size:11px;min-width:1.4em;padding-top:2px;text-align:right;font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
".dp-text{flex:1;white-space:pre-wrap;word-break:break-word;line-height:1.45;font-size:12.5px}",
".dp-meta{display:flex;align-items:center;gap:6px;opacity:.45;font-size:10.5px;margin-top:3px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
".dp-item-actions{display:flex;align-items:center;gap:4px;opacity:.55;transition:opacity .12s}",
".dp-item:hover .dp-item-actions{opacity:1}",
".dp-badge{display:inline-flex;align-items:center;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:500;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid var(--dsh-border,rgba(127,127,127,0.25));opacity:.85}",
".dp-tag-inline{margin-right:6px}",
".dp-badge-active{border-color:rgba(59,130,246,0.45);background:rgba(59,130,246,0.1);color:#60a5fa;opacity:1}",
".dp-badge-pin{border-color:rgba(245,158,11,0.45);background:rgba(245,158,11,0.1);color:#fbbf24;opacity:1}",
".dp-badge-prompt{border-color:rgba(96,165,250,0.4);color:#93c5fd}",
".dp-badge-skill{border-color:rgba(52,211,153,0.4);color:#6ee7b7}",
".dp-badge-subagent{border-color:rgba(192,132,252,0.4);color:#d8b4fe}",
".dp-count{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;opacity:.6;padding:1px 7px;border-radius:999px;background:rgba(127,127,127,0.1)}",
".dp-count-pos{opacity:.95;background:rgba(59,130,246,0.14);color:#60a5fa;font-weight:500}",
".dp-pre{margin:0;padding:8px 10px;border-radius:6px;background:rgba(0,0,0,0.2);border:1px solid var(--dsh-border,rgba(127,127,127,0.2));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto}",
".dp-alert{margin:0;padding:8px 12px;border-radius:8px;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);color:#f87171;font-size:12px}",
".dp-empty{opacity:.5;font-size:12px;margin:2px 0}",
/* The refine row reuses the built-in card's structure, so these mirror
 * GenericCommandCard.module.css rather than inventing a look. */
".dp-refine-row{flex-direction:column;display:flex}",
".dp-pill-broken{font-size:11px;color:var(--dsw-alias-state-error-primary)}",
".dp-refine-sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}",
".dp-refine-summary{min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));text-overflow:ellipsis;white-space:nowrap;flex:auto;overflow:hidden}",
".dp-refine-summary[data-error],.dp-refine-body[data-error]{color:var(--dsw-alias-state-error-primary)}",
".dp-refine-body{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);max-height:260px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-markdown-code-block-small);white-space:pre-wrap;margin:4px 0 4px 4px;padding:12px 16px;overflow:auto}",
".dp-visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}"
].join("");

function ensureCss() {
if (typeof document === "undefined") return;
let tag = document.getElementById(CSS_ID);
if (!tag) {
tag = document.createElement("style");
tag.id = CSS_ID;
document.head.appendChild(tag);
}
tag.textContent = CSS;
}

function shortPath(p) {
if (!p || typeof p !== "string") return "";
return p
.replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~")
.replace(/^\/Users\/[^/]+/, "~")
.replace(/^\/home\/[^/]+/, "~");
}

function detectClientSessionId() {
try {
if (typeof window === "undefined") return undefined;
const m = /[?&]session(?:Id)?=([^&#]+)/i.exec(window.location.search || "") ||
/\/sessions?\/([A-Za-z0-9_-]{6,})/i.exec(window.location.pathname || "") ||
/\/sessions?\/([A-Za-z0-9_-]{6,})/i.exec(window.location.hash || "");
if (m && m[1]) return decodeURIComponent(m[1]);
} catch {}
return undefined;
}

async function call(body) {
const payload = Object.assign({ sessionId: detectClientSessionId() }, body);
const res = await fetch(new URL(API, window.location.origin).toString(), {
method: "POST",
headers: { "content-type": "application/json" },
body: JSON.stringify(payload),
cache: "no-store",
credentials: "same-origin"
});
const data = await res.json().catch(() => ({}));
if (!res.ok || data.ok === false) throw new Error(data.error || ("request failed (" + res.status + ")"));
return data;
}

function dateOf(ms) {
const at = Number(ms);
if (!Number.isFinite(at) || at <= 0) return "";
return new Date(at).toISOString().slice(0, 10);
}

function orderEntries(entries, ranked) {
const rank = new Map((ranked || []).map((id, i) => [id, i]));
return (entries || []).slice().sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
}

function ComposeBox(props) {
const kind = props.kind;
const setKind = props.setKind;
const nameVal = props.nameVal;
const setNameVal = props.setNameVal;
const draft = props.draft;
const setDraft = props.setDraft;
const busy = props.busy;
const onSubmit = props.onSubmit;
const targetLabel = props.targetLabel;

const kindMeta = KINDS.find((k) => k.value === kind) || KINDS[0];
const needsName = kind === "skill" || kind === "subagent";

return h("div", { className: "dp-compose" },
h("div", { className: "dp-kinds", role: "tablist", "aria-label": "Component kind" },
KINDS.map((k) => h("button", {
key: k.value,
type: "button",
className: "dp-kind-pill" + (kind === k.value ? " dp-kind-pill-active" : ""),
disabled: busy,
onClick: () => setKind(k.value)
}, k.label))
),
h("div", { className: "dp-row" },
needsName ? h(Input, {
className: "dp-name-input",
type: "text",
placeholder: kind === "skill" ? "skill-name" : "role-name",
value: nameVal,
disabled: busy,
onChange: (e) => setNameVal(e.target.value),
onKeyDown: (e) => { if (e.key === "Enter") onSubmit(); }
}) : null,
h(Input, {
className: "dp-input",
type: "text",
placeholder: targetLabel ? (kindMeta.placeholder.replace(/…$/, "") + " in " + targetLabel + "…") : kindMeta.placeholder,
value: draft,
disabled: busy,
onChange: (e) => setDraft(e.target.value),
onKeyDown: (e) => { if (e.key === "Enter") onSubmit(); }
}),
h(Button, { type: "button", variant: "primary", disabled: busy || !draft.trim(), onClick: onSubmit }, "Add")
)
);
}

function EntryList(props) {
const entries = props.entries || [];
const busy = props.busy;
const onPin = props.onPin;
const onRemove = props.onRemove;

return h("ul", { className: "dp-list" }, entries.map((e, i) => {
const kind = e.kind && e.kind !== "memory" ? e.kind : "";
const kindTag = kind ? (e.name ? kind + ":" + e.name : kind) : (e.name || "");
const kindClass = kind ? " dp-badge-" + kind : "";
return h("li", { key: e.id, className: "dp-item" },
h("span", { className: "dp-rank" }, String(i + 1)),
h("span", { className: "dp-text" },
e.pinned ? h("span", { className: "dp-badge dp-badge-pin dp-tag-inline" }, "pinned") : null,
kindTag ? h("span", { className: "dp-badge dp-tag-inline" + kindClass }, kindTag) : null,
e.text,
h("span", { className: "dp-meta" },
String(e.id).slice(0, 8),
e.createdAt ? " · " + dateOf(e.createdAt) : "",
e.updatedAt && e.updatedAt !== e.createdAt ? " · edited " + dateOf(e.updatedAt) : ""
)
),
h("div", { className: "dp-item-actions" },
onPin ? h(Button, {
type: "button",
size: "sm",
disabled: busy,
onClick: () => onPin(e)
}, e.pinned ? "Unpin" : "Pin") : null,
onRemove ? h(Button, {
type: "button",
size: "sm",
icon: IconCloseOutlineRegular,
disabled: busy,
title: "Remove",
onClick: () => onRemove(e)
}) : null
)
);
}));
}

function WorkspaceCard(props) {
const ws = props.ws;
const expanded = props.expanded;
const onToggle = props.onToggle;
const busy = props.busy;
const onAction = props.onAction;

const [draft, setDraft] = React.useState("");
const [kind, setKind] = React.useState("memory");
const [nameVal, setNameVal] = React.useState("");
const [armed, setArmed] = React.useState(false);
const [diffText, setDiffText] = React.useState("");

const entries = orderEntries(ws.entries || [], ws.ranked || []);
const snaps = ws.snapshots || [];
const count = ws.count || 0;

const submitAdd = async () => {
if (!draft.trim() || busy || !ws.cwd) return;
await onAction({
op: "add",
scope: "workspace",
cwd: ws.cwd,
text: draft,
kind,
name: (kind === "skill" || kind === "subagent") && nameVal.trim() ? nameVal.trim() : undefined
});
setDraft("");
setNameVal("");
};

return h("div", { className: "dp-card" + (expanded ? " dp-card-open" : "") },
h("button", {
type: "button",
className: "dp-card-hdr",
onClick: onToggle,
"aria-expanded": Boolean(expanded)
},
h("span", { className: "dp-card-chev" }, expanded ? "▾" : "▸"),
h("span", { className: "dp-card-title" },
h("span", null, ws.name || "Workspace"),
ws.isCurrent ? h("span", { className: "dp-badge dp-badge-active" }, "active") : null,
ws.cwd ? h("span", { className: "dp-card-path", title: ws.cwd }, shortPath(ws.cwd)) : null
),
h("span", { className: "dp-count" + (count > 0 ? " dp-count-pos" : "") }, String(count))
),
expanded ? h("div", { className: "dp-card-body" },
ws.cwd ? h(ComposeBox, {
kind,
setKind,
nameVal,
setNameVal,
draft,
setDraft,
busy,
onSubmit: submitAdd,
targetLabel: ws.name || "workspace"
}) : null,
entries.length
? h(EntryList, {
entries,
busy,
onPin: ws.cwd ? (e) => onAction({ op: "pin", scope: "workspace", cwd: ws.cwd, id: e.id, pinned: !e.pinned }) : null,
onRemove: ws.cwd ? (e) => onAction({ op: "remove", scope: "workspace", cwd: ws.cwd, id: e.id }) : null
})
: h("p", { className: "dp-empty" }, "No entries recorded in " + (ws.name || "this workspace") + " yet."),
ws.cwd && (entries.length > 0 || snaps.length > 0)
? h("div", { className: "dp-card-ftr" },
h("div", { className: "dp-ftr-group" },
snaps.length > 0 ? h(Button, {
type: "button",
size: "sm",
disabled: busy,
onClick: async () => {
setDiffText("");
await onAction({ op: "rollback", scope: "workspace", cwd: ws.cwd });
}
}, "Undo (" + snaps[0].ref + ")") : null,
snaps.length > 0 ? h(Button, {
type: "button",
size: "sm",
disabled: busy,
onClick: async () => {
if (diffText) { setDiffText(""); return; }
const d = await call({ op: "diff", scope: "workspace", cwd: ws.cwd, ref: snaps[0].ref });
setDiffText(d.text || "");
}
}, diffText ? "Hide diff" : "Latest diff") : null
),
entries.length > 0 ? h(Button, {
type: "button",
variant: "danger",
size: "sm",
disabled: busy,
onClick: async () => {
if (!armed) { setArmed(true); return; }
setArmed(false);
await onAction({ op: "clear", scope: "workspace", cwd: ws.cwd });
}
}, armed ? "Confirm clear " + entries.length + "?" : "Clear all") : null
)
: null,
diffText ? h("pre", { className: "dp-pre" }, diffText) : null
) : null
);
}

function PrimeHarnessSection() {
const [state, setState] = React.useState({
loading: true,
error: "",
cfg: null,
scope: "session",
entries: [],
workspaces: [],
snapshots: [],
repl: null,
active: null,
counts: null,
diffText: ""
});
const [openCards, setOpenCards] = React.useState({});
const [showEmptyWs, setShowEmptyWs] = React.useState(false);
const [draft, setDraft] = React.useState("");
const [draftKind, setDraftKind] = React.useState("memory");
const [draftName, setDraftName] = React.useState("");
const [busy, setBusy] = React.useState(false);
const [armed, setArmed] = React.useState(false);

const applyResponse = React.useCallback((data) => {
const wsList = data.workspaces || [];
setOpenCards((prev) => {
const next = Object.assign({}, prev);
if (Object.keys(next).length === 0 && wsList.length > 0) {
const cur = wsList.find((w) => w.isCurrent) || wsList.find((w) => (w.count || 0) > 0) || wsList[0];
if (cur) next[cur.key] = true;
}
return next;
});
setState((s) => ({
loading: false,
error: "",
cfg: data.config || s.cfg,
scope: data.scope || s.scope,
entries: orderEntries(data.entries, data.ranked),
workspaces: wsList,
snapshots: data.snapshots || [],
repl: data.repl !== undefined ? data.repl : s.repl,
active: data.active !== undefined ? data.active : s.active,
counts: data.counts || s.counts,
diffText: s.diffText || ""
}));
}, []);

const load = React.useCallback(async (scope) => {
setBusy(true);
try {
const data = await call({ op: "get", scope });
applyResponse(data);
} catch (error) {
setState((s) => Object.assign({}, s, { loading: false, error: String((error && error.message) || error) }));
} finally {
setBusy(false);
}
}, [applyResponse]);

React.useEffect(() => { load(undefined); }, [load]);

const onScope = React.useCallback(async (scope) => {
try {
await call({ op: "setScope", scope });
await load(scope);
} catch (error) {
setState((s) => Object.assign({}, s, { error: String((error && error.message) || error) }));
}
}, [load]);

const onWorkspaceAction = React.useCallback(async (reqBody) => {
setBusy(true);
try {
await call(reqBody);
await load("workspace");
} catch (error) {
setState((s) => Object.assign({}, s, { error: String((error && error.message) || error) }));
} finally {
setBusy(false);
}
}, [load]);

const onAdd = React.useCallback(async () => {
if (!draft.trim() || busy) return;
setBusy(true);
try {
const data = await call({
op: "add",
scope: state.scope,
text: draft,
kind: draftKind,
name: (draftKind === "skill" || draftKind === "subagent") && draftName.trim() ? draftName.trim() : undefined
});
setDraft("");
setDraftName("");
applyResponse(data);
} catch (error) {
setState((s) => Object.assign({}, s, { error: String((error && error.message) || error) }));
} finally {
setBusy(false);
}
}, [draft, draftKind, draftName, busy, state.scope, applyResponse]);

const onPinSession = React.useCallback(async (entry) => {
setBusy(true);
try {
const data = await call({ op: "pin", scope: state.scope, id: entry.id, pinned: !entry.pinned });
applyResponse(data);
} catch (error) {
setState((s) => Object.assign({}, s, { error: String((error && error.message) || error) }));
} finally {
setBusy(false);
}
}, [state.scope, applyResponse]);

const onRemove = React.useCallback(async (entry) => {
setBusy(true);
try {
const data = await call({ op: "remove", scope: state.scope, id: entry.id });
applyResponse(data);
} catch (error) {
setState((s) => Object.assign({}, s, { error: String((error && error.message) || error) }));
} finally {
setBusy(false);
}
}, [state.scope, applyResponse]);

const onRollback = React.useCallback(async (ref) => {
setBusy(true);
try {
const data = await call({ op: "rollback", scope: state.scope, ref });
setState((s) => Object.assign({}, s, { diffText: "" }));
applyResponse(data);
} catch (error) {
setState((s) => Object.assign({}, s, { error: String((error && error.message) || error) }));
} finally {
setBusy(false);
}
}, [state.scope, applyResponse]);

const onDiff = React.useCallback(async (ref) => {
setBusy(true);
try {
if (state.diffText) {
setState((s) => Object.assign({}, s, { diffText: "" }));
return;
}
const data = await call({ op: "diff", scope: state.scope, ref });
setState((s) => Object.assign({}, s, { error: "", diffText: data.text || "" }));
} catch (error) {
setState((s) => Object.assign({}, s, { error: String((error && error.message) || error) }));
} finally {
setBusy(false);
}
}, [state.scope, state.diffText]);

const onResetRepl = React.useCallback(async () => {
setBusy(true);
try {
const data = await call({ op: "resetRepl", scope: state.scope });
setState((s) => Object.assign({}, s, { error: "", repl: data.repl || null }));
} catch (error) {
setState((s) => Object.assign({}, s, { error: String((error && error.message) || error) }));
} finally {
setBusy(false);
}
}, [state.scope]);

const onClear = React.useCallback(async () => {
if (!armed) { setArmed(true); return; }
setArmed(false);
setBusy(true);
try {
await call({ op: "clear", scope: state.scope });
await load(state.scope);
} catch (error) {
setState((s) => Object.assign({}, s, { error: String((error && error.message) || error) }));
} finally {
setBusy(false);
}
}, [armed, state.scope, load]);

const onAuto = React.useCallback(async (value) => {
try {
const data = await call({ op: "setAuto", value });
setState((s) => Object.assign({}, s, { error: "", cfg: data.config }));
} catch (error) {
setState((s) => Object.assign({}, s, { error: String((error && error.message) || error) }));
}
}, []);

const current = SCOPES.find((o) => o.value === state.scope) || SCOPES[0];
const other = SCOPES.find((o) => o.value !== state.scope) || SCOPES[0];
const otherCount = state.counts ? (state.counts[other.value] || 0) : 0;
const cfg = state.cfg || {};
const snaps = state.snapshots || [];

const emptyWsCount = state.workspaces.filter((w) => !w.isCurrent && (w.count || 0) === 0).length;
const visibleWorkspaces = showEmptyWs
? state.workspaces
: state.workspaces.filter((w) => w.isCurrent || (w.count || 0) > 0 || openCards[w.key]);

const sessionView = h("div", { className: "dp-card dp-card-open" },
h("div", { className: "dp-card-hdr", style: { cursor: "default" } },
h("span", { className: "dp-card-title" },
h("span", null, state.active
? "Conversation " + String(state.active.id).replace(/^session-/, "").slice(0, 8)
: "Current Conversation"),
state.active && state.active.cwd
? h("span", { className: "dp-card-path", title: state.active.cwd }, shortPath(state.active.cwd))
: null
),
h("span", { className: "dp-count" + (state.entries.length > 0 ? " dp-count-pos" : "") }, String(state.entries.length))
),
h("div", { className: "dp-card-body" },
state.active ? h(ComposeBox, {
kind: draftKind,
setKind: setDraftKind,
nameVal: draftName,
setNameVal: setDraftName,
draft,
setDraft,
busy,
onSubmit: onAdd,
targetLabel: "this chat"
}) : null,
state.entries.length
? h(EntryList, {
entries: state.entries,
busy,
onPin: onPinSession,
onRemove: onRemove
})
: h("p", { className: "dp-empty" }, state.active
? "No entries recorded in this conversation yet."
: "Open a chat first to inspect or add session-scoped entries."),
(state.entries.length > 0 || snaps.length > 0)
? h("div", { className: "dp-card-ftr" },
h("div", { className: "dp-ftr-group" },
snaps.length > 0 ? h(Button, {
type: "button",
size: "sm",
disabled: busy,
onClick: () => onRollback(undefined)
}, "Undo (" + snaps[0].ref + ")") : null,
snaps.length > 0 ? h(Button, {
type: "button",
size: "sm",
disabled: busy,
onClick: () => onDiff(snaps[0].ref)
}, state.diffText ? "Hide diff" : "Latest diff") : null
),
state.entries.length > 0 ? h(Button, {
type: "button",
variant: "danger",
size: "sm",
disabled: busy,
onClick: onClear
}, armed ? "Confirm clear " + state.entries.length + "?" : "Clear all") : null
)
: null,
state.diffText ? h("pre", { className: "dp-pre" }, state.diffText) : null
)
);

const workspaceCardsView = h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
h("div", { className: "dp-sec-bar" },
h("span", { className: "dp-sec-title" },
"Workspaces (" + visibleWorkspaces.length + (emptyWsCount > 0 && !showEmptyWs ? " of " + state.workspaces.length : "") + ")"
),
h("div", { className: "dp-sec-actions" },
emptyWsCount > 0 ? h("button", {
type: "button",
className: "dp-pill-btn" + (showEmptyWs ? " dp-pill-btn-on" : ""),
onClick: () => setShowEmptyWs((v) => !v)
}, showEmptyWs ? "Hide empty (" + emptyWsCount + ")" : "Show empty (" + emptyWsCount + ")") : null,
h(Button, { type: "button", size: "sm", icon: IconRefreshOutlineRegular, disabled: busy, onClick: () => load("workspace") }, "Refresh")
)
),
visibleWorkspaces.length
? h("div", { className: "dp-cards" }, visibleWorkspaces.map((ws) => h(WorkspaceCard, {
key: ws.key,
ws,
busy,
expanded: Boolean(openCards[ws.key]),
onToggle: () => setOpenCards((prev) => Object.assign({}, prev, { [ws.key]: !prev[ws.key] })),
onAction: onWorkspaceAction
})))
: h("p", { className: "dp-empty" }, "No workspaces discovered yet.")
);

return h("div", { className: "dp-root" },
h("div", { className: "dp-hdr" },
h("h2", { className: "dp-h" }, "Prime Harness"),
h("p", { className: "dp-sub" },
"Scoped continual memory (",
h("code", null, "/refine"),
") that survives compaction and re-injects verified facts, prompt rules, skills, and subagent roles."
)
),
h("div", { className: "dp-group" },
h("div", { className: "dp-group-row" },
h("div", { className: "dp-group-info" },
h("span", { className: "dp-group-title" },
"Default write scope",
otherCount > 0 ? h("button", {
type: "button",
className: "dp-link",
onClick: () => onScope(other.value)
}, otherCount + " in " + other.label.toLowerCase() + " →") : null
),
h("span", { className: "dp-group-desc" }, current.hint)
),
h(SegmentedControl, {
id: "dp-scope",
value: state.scope,
options: SCOPES.map((o) => ({ value: o.value, label: o.label })),
onChange: onScope,
label: "Harness scope",
disabled: busy
})
),
h("div", { className: "dp-group-row" },
h("div", { className: "dp-group-info" },
h("span", { className: "dp-group-title" }, "Auto-refine after compaction"),
h("span", { className: "dp-group-desc" }, "Queue a background refinement pass when conversation history is compacted.")
),
h(Switch, {
checked: cfg.autoRefineOnCompact !== false,
onChange: onAuto,
label: "Auto-refine after context compaction"
})
),
state.repl && state.repl.active ? h("div", { className: "dp-group-row" },
h("div", { className: "dp-group-info" },
h("span", { className: "dp-group-title" }, "RLM Python REPL"),
h("span", { className: "dp-group-desc" },
state.repl.evalCount + " evals · vars: " + (state.repl.variables.length ? state.repl.variables.join(", ") : "none")
)
),
h(Button, { type: "button", size: "sm", disabled: busy, onClick: onResetRepl }, "Reset REPL")
) : null
),
state.error ? h("p", { className: "dp-alert", role: "alert" }, state.error) : null,
state.loading
? h("p", { className: "dp-empty" }, "Loading…")
: (state.scope === "workspace" ? workspaceCardsView : sessionView)
);
}

const name = NS;
const inject = ["slots"];

/* The `refine` command's own row.
 *
 * Built-in commands render through `GenericCommandCard`, which hardcodes
 * `t("command.running")` for the running label. That label cannot be changed
 * from a plugin: `runningSummary` is a prop only the internal compaction card
 * receives, and `locale.register` throws on a duplicate namespace+locale, so
 * `chat`/`en` cannot be extended. A keyed `commandview` entry is the supported
 * way to own one command's row, which is exactly how `/compact` gets its card.
 *
 * The primitives are the same ones the built-in card uses (DisclosureRow +
 * TextShimmer + the command icon), so the row looks and shimmers identically —
 * only the four words differ. */
const RefineIcon = primitives.IconApiOutlineRegular;
const TextShimmer = primitives.TextShimmer;
const DisclosureRow = primitives.DisclosureRow;

function RefineCommandRow({ node }) {
const [expanded, setExpanded] = React.useState(false);
const text = node.outcome ? node.outcome.text : undefined;
const state = node.outcome === null ? "running" : node.outcome.kind === "error" ? "error" : "ok";
const running = state === "running";
const summary = running ? "Refining…" : text !== undefined ? text : state === "error" ? "Failed" : "Done";
const body = text !== undefined && text.includes("\n") ? text : null;
const open = expanded && body !== null;
const toggle = React.useCallback(() => setExpanded((v) => !v), []);
return h("div", { className: "dp-refine-row", "data-state": state },
running ? h("span", { className: "dp-visually-hidden" }, "Refining the harness") : null,
h(DisclosureRow, {
icon: h(RefineIcon, { size: 14 }),
title: node.name || "refine",
running,
open,
expandable: body !== null,
expandOnRowClick: true,
keepContentWhenOpen: true,
onToggle: toggle,
collapsedContent: h(React.Fragment, null,
h("span", { className: "dp-refine-sep", "data-shimmer-decoration": true, "aria-hidden": true }),
h("span", { className: "dp-refine-summary", "data-error": state === "error" || undefined },
h(TextShimmer, null, summary)
)
),
children: open ? h("pre", { className: "dp-refine-body", "data-error": state === "error" || undefined }, body) : undefined
})
);
}

/* ---- The header pill: "N subagents" becomes "N refines" ------------------
 *
 * `@deepseek-ai/dsh-client-ui-subagent` owns one cell of the Session header
 * actions list (`id: "subagent-catalog"`) that counts direct children, and one
 * single-slot entry in the breadcrumb slot for a child session's own children.
 * The count text lives in that package's own dictionaries, and
 * `locale.register` refuses a second dictionary for one namespace, so the words
 * cannot be patched. The CELL can be replaced: a list slot keeps one entry per
 * id and elects the lowest priority, so re-registering the shipped id at
 * `priority: -1` takes it over - the exact shadowing the registry's own
 * duplicate error suggests.
 *
 * The replacement renders the shipped component (read from `slots.entries`,
 * the registry's documented inspection surface, which keeps shadowed entries),
 * forwards every prop including the entry's own `inject` face, and swaps only
 * `t`. So the pill keeps its dropdown, keyboard handling, metrics and
 * navigation; only four keys change.
 *
 * A child is a pass when the host labelled it `refine HH:MM` (`runForkedPass`).
 * Anything else - an `rlm` worker, a workflow, a standard-mode subagent - keeps
 * the shipped wording, because "4 subagents" is then the truth. There is no
 * preset id on the client's session summaries, so the children are the signal.
 *
 * If a future ui-subagent renames that cell id the lookup finds nothing and the
 * pill says so in text, instead of quietly rendering a second pill beside it. */
const SLOT_ACTIONS = "conversation.session.header.actions";
const SLOT_LINEAGE = "conversation.session.header.lineage";
const REFINE_LABEL = /^refine \d/;
/* ponytail: English only. Translating needs the zh wording DSH never published
 * for these keys, so a zh page keeps its own "<n> \u4e2a\u5b50\u4ee3\u7406". */
const REFINE_WORDS = {
"count.total.one": "{count} refine",
"count.total.other": "{count} refines",
"count.running.one": "{count} refine running",
"count.running.other": "{count} refines running"
};

function refineWords(t) {
return (key, params) => {
const text = REFINE_WORDS[key];
if (text === undefined) return t(key, params);
return text.replace("{count}", params === undefined ? "" : String(params.count));
};
}

/* True only when every direct child is a pass: an empty catalog is not one. */
function useOnlyRefines(useSessions, sessionId) {
return useSessions((state) => {
const snapshot = state.projectionsBySession[sessionId];
const catalog = snapshot === undefined ? undefined : snapshot.values.subagentCatalog;
return catalog !== undefined && catalog.length > 0 && catalog.every((entry) => REFINE_LABEL.test(entry.label || ""));
});
}

/* One pass-through replacement for one pill cell.
 *
 * Errors are caught HERE, inside our own boundary, and never forwarded: an
 * ordinary slot entry that throws is ABDICATED, and the cell silently falls
 * back to the entry it shadowed - indistinguishable from a pill that never
 * loaded. A boundary turns that into text on the pill. */
function pillPatch(ctx, slot, sessionOf, targetId) {
class PillBoundary extends React.Component {
constructor(props) {
super(props);
this.state = { failure: undefined };
}
static getDerivedStateFromError(error) {
return { failure: (error && error.message) || String(error) };
}
render() {
if (this.state.failure !== undefined) return h("span", { className: "dp-pill-broken" }, "prime pill: " + this.state.failure);
return this.props.children;
}
}
function PillBody(props) {
const sessionId = sessionOf(props);
const onlyRefines = useOnlyRefines(props.useSessions, sessionId);
const words = React.useMemo(() => (onlyRefines ? refineWords(props.t) : props.t), [props.t, onlyRefines]);
let shipped;
let broken;
try {
shipped = ctx.slots.entries(slot).filter((entry) => entry.component !== PrimePill && (targetId === undefined || entry.options.id === targetId))[0];
} catch (error) {
broken = (error && error.message) || String(error);
}
if (broken !== undefined) return h("span", { className: "dp-pill-broken" }, "prime pill: " + broken);
if (shipped === undefined) return h("span", { className: "dp-pill-broken" }, "prime pill: no entry in " + slot);
const injected = typeof shipped.inject === "function" ? shipped.inject(sessionId) : undefined;
return h(shipped.component, { ...injected, ...props, t: words });
}
function PrimePill(props) {
return h(PillBoundary, null, h(PillBody, props));
}
return PrimePill;
}

function apply(ctx) {
ctx.effect(() => {
ensureCss();
return () => {
if (typeof document === "undefined") return;
const tag = document.getElementById(CSS_ID);
if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
};
}, NS + ": styles");
ctx.slots.inject("settings.section", () => ctx.slots.register({
name: "settings.section",
id: NS,
order: 65,
label: () => "Prime Harness"
}, () => h(PrimeHarnessSection, null)));
ctx.slots.inject("conversation.chat.commandview", () => ctx.slots.register({
name: "conversation.chat.commandview",
id: NS + ":refine",
key: "refine"
}, RefineCommandRow));

ctx.slots.inject(SLOT_ACTIONS, () => ctx.slots.register({
name: SLOT_ACTIONS,
id: "subagent-catalog",
order: 10,
priority: -1,
locale: "subagent"
}, pillPatch(ctx, SLOT_ACTIONS, (props) => props.sessionId, "subagent-catalog")));
ctx.slots.inject(SLOT_LINEAGE, () => ctx.slots.register({
name: SLOT_LINEAGE,
priority: -1,
locale: "subagent"
}, pillPatch(ctx, SLOT_LINEAGE, (props) => props.lineageSessionId)));
}

exports.name = name;
exports.inject = inject;
exports.apply = apply;
return module.exports;
}
});
