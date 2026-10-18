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
			{ value: "session", label: "This conversation", hint: "You see this chat plus the workspace. New entries stay here — no other chat will see them." },
			{ value: "workspace", label: "Workspaces", hint: "Shared across every chat in the workspace folder. Expand any workspace card below to inspect or edit its harness." }
		];
		const KINDS = [
			{ value: "memory", label: "Memory" },
			{ value: "prompt", label: "Prompt" },
			{ value: "skill", label: "Skill" },
			{ value: "subagent", label: "Subagent" }
		];

		const CSS = [
			".dp-root{display:flex;flex-direction:column;gap:14px;font-size:13px}",
			".dp-sub{margin:0;opacity:.7;line-height:1.5}",
			".dp-field{display:flex;flex-direction:column;gap:8px}",
			".dp-label{font-weight:600}",
			".dp-input{flex:1}",
			".dp-hint{opacity:.65;min-height:1.2em}",
			".dp-target{opacity:.5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all}",
			".dp-other{border:none;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:11px;opacity:.7;text-align:left;padding:0;text-decoration:underline}",
			".dp-other:hover{opacity:1}",
			".dp-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
			".dp-switch-row{display:flex;gap:10px;align-items:center;padding:4px 0}",
			".dp-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto}",
			".dp-item{display:flex;gap:8px;align-items:center;padding:8px;border-radius:6px;border:1px solid var(--dsh-border,#444)}",
			".dp-text{flex:1;white-space:pre-wrap;word-break:break-word}",
			".dp-rank{opacity:.45;min-width:1.4em;text-align:right;font-variant-numeric:tabular-nums}",
			".dp-meta{display:block;opacity:.5;font-size:11px;margin-top:3px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
			".dp-badge{display:inline-block;padding:1px 6px;margin-right:6px;border-radius:4px;font-size:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid var(--dsh-border,#555);opacity:.85}",
			".dp-badge-active{border-color:#3b82f6;color:#60a5fa}",
			".dp-pre{margin:0;padding:8px;border-radius:6px;border:1px solid var(--dsh-border,#444);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto}",
			".dp-cards{display:flex;flex-direction:column;gap:8px}",
			".dp-card{border:1px solid var(--dsh-border,#3a3a3a);border-radius:8px;overflow:hidden;background:rgba(255,255,255,0.015)}",
			".dp-card-hdr{width:100%;display:flex;align-items:center;gap:8px;padding:10px 12px;border:none;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}",
			".dp-card-hdr:hover{background:rgba(255,255,255,0.04)}",
			".dp-card-chev{font-size:11px;opacity:.6;width:14px;display:inline-block}",
			".dp-card-title{font-weight:600;flex:1;display:flex;align-items:center;gap:6px;min-width:0}",
			".dp-card-path{opacity:.45;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dp-card-body{padding:10px 12px 12px;border-top:1px solid var(--dsh-border,#333);display:flex;flex-direction:column;gap:10px}",
			".dp-alert{color:#f87171}",
			".dp-empty{opacity:.6;font-style:italic;margin:0}"
		].join("");

		function ensureCss() {
			if (typeof document === "undefined") return;
			if (document.getElementById(CSS_ID)) return;
			const tag = document.createElement("style");
			tag.id = CSS_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
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

		function WorkspaceCard(props) {
			const ws = props.ws;
			const expanded = props.expanded;
			const onToggle = props.onToggle;
			const busy = props.busy;
			const onAction = props.onAction;

			const [draft, setDraft] = React.useState("");
			const [kind, setKind] = React.useState("memory");
			const [armed, setArmed] = React.useState(false);
			const [diffText, setDiffText] = React.useState("");

			const entries = orderEntries(ws.entries || [], ws.ranked || []);
			const snaps = ws.snapshots || [];

			const submitAdd = async () => {
				if (!draft.trim() || busy || !ws.cwd) return;
				await onAction({ op: "add", scope: "workspace", cwd: ws.cwd, text: draft, kind });
				setDraft("");
			};

			return h("div", { className: "dp-card" },
				h("button", {
					type: "button",
					className: "dp-card-hdr",
					onClick: onToggle,
					"aria-expanded": Boolean(expanded)
				},
					h("span", { className: "dp-card-chev" }, expanded ? "\u25be" : "\u25b8"),
					h("span", { className: "dp-card-title" },
						h("span", null, ws.name || "Workspace"),
						ws.isCurrent ? h("span", { className: "dp-badge dp-badge-active" }, "active") : null,
						ws.cwd ? h("span", { className: "dp-card-path", title: ws.cwd }, ws.cwd) : null
					),
					h("span", { className: "dp-badge" }, (ws.count || 0) + ((ws.count || 0) === 1 ? " entry" : " entries"))
				),
				expanded ? h("div", { className: "dp-card-body" },
					ws.cwd ? h("span", { className: "dp-target", title: ws.cwd }, ws.cwd) : null,
					ws.cwd ? h("div", { className: "dp-field" },
						h(SegmentedControl, {
							id: "dp-kind-" + ws.key,
							value: kind,
							options: KINDS,
							onChange: setKind,
							label: "Component kind",
							disabled: busy
						}),
						h("div", { className: "dp-row" },
							h(Input, {
								className: "dp-input",
								type: "text",
								placeholder: "Add a workspace refinement to " + (ws.name || "this folder") + "…",
								value: draft,
								disabled: busy,
								onChange: (e) => setDraft(e.target.value),
								onKeyDown: (e) => { if (e.key === "Enter") submitAdd(); }
							}),
							h(Button, { type: "button", variant: "primary", disabled: busy || !draft.trim(), onClick: submitAdd }, "Add")
						)
					) : null,
					entries.length
						? h("ul", { className: "dp-list" }, entries.map((e, i) => {
							const kindTag = e.kind && e.kind !== "memory" ? (e.name ? e.kind + ":" + e.name : e.kind) : (e.name || "");
							return h("li", { key: e.id, className: "dp-item" },
								h("span", { className: "dp-rank" }, String(i + 1)),
								h("span", { className: "dp-text" },
									e.pinned ? h("span", { className: "dp-badge" }, "pinned") : null,
									kindTag ? h("span", { className: "dp-badge" }, kindTag) : null,
									e.text,
									h("span", { className: "dp-meta" },
										String(e.id).slice(0, 8),
										e.createdAt ? " \u00b7 " + dateOf(e.createdAt) : "",
										e.updatedAt && e.updatedAt !== e.createdAt ? " \u00b7 edited " + dateOf(e.updatedAt) : "",
										e.evidence ? " \u00b7 " + e.evidence : ""
									)
								),
								ws.cwd ? h(Button, {
									type: "button",
									size: "sm",
									disabled: busy,
									onClick: () => onAction({ op: "pin", scope: "workspace", cwd: ws.cwd, id: e.id, pinned: !e.pinned })
								}, e.pinned ? "Unpin" : "Pin") : null,
								ws.cwd ? h(Button, {
									type: "button",
									size: "sm",
									icon: IconCloseOutlineRegular,
									disabled: busy,
									title: "Remove",
									onClick: () => onAction({ op: "remove", scope: "workspace", cwd: ws.cwd, id: e.id })
								}) : null
							);
						}))
						: h("p", { className: "dp-empty" }, "Nothing recorded in " + (ws.name || "this workspace") + " yet."),
					ws.cwd && (entries.length > 0 || snaps.length > 0)
						? h("div", { className: "dp-row" },
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
							}, armed ? "Confirm clear " + entries.length + "?" : "Clear workspace") : null,
							snaps.length > 0 ? h(Button, {
								type: "button",
								size: "sm",
								disabled: busy,
								onClick: async () => {
									setDiffText("");
									await onAction({ op: "rollback", scope: "workspace", cwd: ws.cwd });
								}
							}, "Undo last edit (" + snaps[0].ref + ")") : null,
							snaps.length > 0 ? h(Button, {
								type: "button",
								size: "sm",
								disabled: busy,
								onClick: async () => {
									const d = await call({ op: "diff", scope: "workspace", cwd: ws.cwd, ref: snaps[0].ref });
									setDiffText(d.text || "");
								}
							}, "Latest diff") : null
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
			const [draft, setDraft] = React.useState("");
			const [draftKind, setDraftKind] = React.useState("memory");
			const [busy, setBusy] = React.useState(false);
			const [armed, setArmed] = React.useState(false);

			const applyResponse = React.useCallback((data) => {
				const wsList = data.workspaces || [];
				setOpenCards((prev) => {
					const next = Object.assign({}, prev);
					if (Object.keys(next).length === 0 && wsList.length > 0) {
						const cur = wsList.find((w) => w.isCurrent) || wsList[0];
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
					const data = await call({ op: "add", scope: state.scope, text: draft, kind: draftKind });
					setDraft("");
					applyResponse(data);
				} catch (error) {
					setState((s) => Object.assign({}, s, { error: String((error && error.message) || error) }));
				} finally {
					setBusy(false);
				}
			}, [draft, draftKind, busy, state.scope, applyResponse]);

			const onRemove = React.useCallback(async (id) => {
				setBusy(true);
				try {
					const data = await call({ op: "remove", scope: state.scope, id });
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
					const data = await call({ op: "diff", scope: state.scope, ref });
					setState((s) => Object.assign({}, s, { error: "", diffText: data.text || "" }));
				} catch (error) {
					setState((s) => Object.assign({}, s, { error: String((error && error.message) || error) }));
				} finally {
					setBusy(false);
				}
			}, [state.scope]);

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

			const current = SCOPES.filter((o) => o.value === state.scope)[0] || SCOPES[0];
			const other = SCOPES.filter((o) => o.value !== state.scope)[0] || SCOPES[0];
			const otherCount = state.counts ? (state.counts[other.value] || 0) : 0;
			const cfg = state.cfg || {};
			const sessionTarget = !state.active
				? "Open a chat to see its memory."
				: "this conversation (" + String(state.active.id).replace(/^session-/, "").slice(0, 8) + ")";

			const scopeControl = h(SegmentedControl, {
				id: "dp-scope",
				value: state.scope,
				options: SCOPES.map((o) => ({ value: o.value, label: o.label })),
				onChange: onScope,
				label: "Harness scope",
				disabled: busy
			});

			const sessionView = h(React.Fragment, null,
				h("div", { className: "dp-field" },
					h("label", { className: "dp-label", htmlFor: "dp-note" }, "Add a refinement"),
					h(SegmentedControl, {
						id: "dp-kind",
						value: draftKind,
						options: KINDS,
						onChange: setDraftKind,
						label: "Component kind",
						disabled: busy
					}),
					h("div", { className: "dp-row" },
						h(Input, {
							id: "dp-note",
							className: "dp-input",
							type: "text",
							placeholder: "A durable finding, prompt rule, skill, or subagent spec…",
							"aria-label": "New refinement note",
							value: draft,
							disabled: busy,
							onChange: (e) => setDraft(e.target.value),
							onKeyDown: (e) => { if (e.key === "Enter") onAdd(); }
						}),
						h(Button, { type: "button", variant: "primary", disabled: busy || !draft.trim(), onClick: onAdd }, "Add")
					)
				),
				state.entries.length
					? h("ul", { className: "dp-list" }, state.entries.map((e, i) => {
						const kindTag = e.kind && e.kind !== "memory" ? (e.name ? e.kind + ":" + e.name : e.kind) : (e.name || "");
						return h("li", { key: e.id, className: "dp-item" },
							h("span", { className: "dp-rank", title: "rank" }, String(i + 1)),
							h("span", { className: "dp-text" },
								e.pinned ? h("span", { className: "dp-badge" }, "pinned") : null,
								kindTag ? h("span", { className: "dp-badge" }, kindTag) : null,
								e.text,
								h("span", { className: "dp-meta" },
									String(e.id).slice(0, 8),
									e.createdAt ? " \u00b7 " + dateOf(e.createdAt) : "",
									e.updatedAt && e.updatedAt !== e.createdAt ? " \u00b7 edited " + dateOf(e.updatedAt) : "",
									e.evidence ? " \u00b7 " + e.evidence : ""
								)
							),
							h(Button, {
								type: "button",
								size: "sm",
								icon: IconCloseOutlineRegular,
								disabled: busy,
								"aria-label": "Remove: " + e.text,
								title: "Remove",
								onClick: () => onRemove(e.id)
							})
						);
					}))
					: h("p", { className: "dp-empty" }, state.active
						? "Nothing recorded in this conversation yet."
						: "No active chat, so there is no memory to show."),
				state.entries.length
					? h("div", { className: "dp-row" },
						h(Button, { type: "button", variant: "danger", disabled: busy, onClick: onClear },
							armed ? "Confirm clear " + state.entries.length + " entries?" : "Clear conversation"),
						state.snapshots && state.snapshots.length
							? h(Button, { type: "button", disabled: busy, onClick: () => onRollback(undefined) }, "Undo last edit")
							: null,
						h(Button, { type: "button", icon: IconRefreshOutlineRegular, disabled: busy, onClick: () => load(state.scope) }, "Refresh")
					)
					: null,
				state.snapshots && state.snapshots.length
					? h("div", { className: "dp-field" },
						h("span", { className: "dp-label" }, "Refinement Snapshots & Rollback"),
						h("ul", { className: "dp-list" }, state.snapshots.slice(0, 6).map((s) => h("li", { key: s.id, className: "dp-item" },
							h("span", { className: "dp-text" },
								h("span", { className: "dp-badge" }, String(s.ref || String(s.id).slice(0, 8))),
								s.reason || "update",
								h("span", { className: "dp-meta" }, s.beforeCount + " \u2192 " + s.afterCount + " entries")
							),
							h(Button, { type: "button", size: "sm", disabled: busy, onClick: () => onDiff(s.ref) }, "Diff"),
							h(Button, { type: "button", size: "sm", disabled: busy, onClick: () => onRollback(s.ref) }, "Rollback")
						))),
						state.diffText ? h("pre", { className: "dp-pre" }, state.diffText) : null
					)
					: null
			);

			const workspaceCardsView = h("div", { className: "dp-field" },
				h("div", { className: "dp-row", style: { justifyContent: "space-between" } },
					h("span", { className: "dp-label" }, "Workspace Harnesses (" + state.workspaces.length + ")"),
					h(Button, { type: "button", size: "sm", icon: IconRefreshOutlineRegular, disabled: busy, onClick: () => load("workspace") }, "Refresh")
				),
				state.workspaces.length
					? h("div", { className: "dp-cards" }, state.workspaces.map((ws) => h(WorkspaceCard, {
						key: ws.key,
						ws,
						busy,
						expanded: Boolean(openCards[ws.key]),
						onToggle: () => setOpenCards((prev) => Object.assign({}, prev, { [ws.key]: !prev[ws.key] })),
						onAction: onWorkspaceAction
					})))
					: h("p", { className: "dp-empty" }, "No workspaces discovered yet. Open a chat in any workspace folder first.")
			);

			return h("div", { className: "dp-root" },
				h("h2", { className: "dp-h" }, "Prime Harness"),
				h("p", { className: "dp-sub" },
					"Run ",
					h("code", null, "/refine"),
					" to have the agent review this conversation and record what should outlive it, ",
					h("code", null, "/refine --rollback"),
					" to undo a pass, or manage entries below. Notes are re-ranked by relevance, snapshotted on every edit, and re-injected after compaction."
				),
				h("div", { className: "dp-field" },
					h("span", { className: "dp-label" }, "Default Write Scope"),
					scopeControl,
					h("span", { className: "dp-hint" }, current.hint),
					state.scope === "session" ? h("span", { className: "dp-target", title: sessionTarget }, sessionTarget) : null,
					otherCount > 0
						? h("button", {
							type: "button",
							className: "dp-other",
							onClick: () => onScope(other.value)
						}, otherCount + (otherCount === 1 ? " entry" : " entries") + " in " + other.label.toLowerCase() + " \u2192")
						: null
				),
				h("div", { className: "dp-switch-row" },
					h(Switch, {
						checked: cfg.autoRefineOnCompact !== false,
						onChange: onAuto,
						label: "Review this chat after it is compacted",
						title: "Ask the agent to record anything durable once the history is condensed."
					}),
					h("span", { className: "dp-label", onClick: () => onAuto(cfg.autoRefineOnCompact === false), style: { cursor: "pointer" } },
						"Auto-refine after context compaction"
					)
				),
				state.error ? h("p", { className: "dp-alert", role: "alert" }, state.error) : null,
				state.loading
					? h("p", { className: "dp-hint" }, "Loading…")
					: (state.scope === "workspace" ? workspaceCardsView : sessionView),
				state.repl
					? h("div", { className: "dp-row" },
						h("span", { className: "dp-target" },
							state.repl.active
								? "RLM Python REPL active (" + state.repl.evalCount + " evals \u00b7 vars: " + (state.repl.variables.length ? state.repl.variables.join(", ") : "none") + ")"
								: "RLM Python REPL idle"
						),
						h(Button, { type: "button", size: "sm", disabled: busy, onClick: onResetRepl }, "Reset REPL")
					)
					: null
			);
		}

		const name = NS;
		const inject = ["slots"];

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
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});