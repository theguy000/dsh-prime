window.__ModuleLoader__.load({
	id: "dsh-prime",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		/* The harness's own atoms, so this page matches every other settings page
		   instead of re-styling native controls. primitives is already in the client
		   module graph, and a shipped settings bundle requires it the same way. */
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
		/* Two layers, matching the host: this conversation, and this folder. `global`
		   is gone — one machine-wide bucket mixes every repository together. */
		const SCOPES = [
			{ value: "session", label: "This conversation", hint: "Recorded here, used here." },
			{ value: "workspace", label: "This workspace", hint: "Shared with every chat in this folder." }
		];

		/* Only layout this page owns. Buttons, inputs, the switch, and the segmented
		   control are primitives, so their look belongs to the harness theme rather
		   than to a private stylesheet that would drift from it. */
		const CSS = [
			".dp-root{display:flex;flex-direction:column;gap:14px;font-size:13px}",
			".dp-sub{margin:0;opacity:.7;line-height:1.5}",
			".dp-field{display:flex;flex-direction:column;gap:8px}",
			".dp-label{font-weight:600}",
			".dp-input{flex:1}",
			".dp-hint{opacity:.65;min-height:1.2em}",
			".dp-target{opacity:.5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all}",
			".dp-row{display:flex;gap:8px;align-items:center}",
			".dp-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;max-height:340px;overflow:auto}",
			".dp-item{display:flex;gap:8px;align-items:center;padding:8px;border-radius:6px;border:1px solid var(--dsh-border,#444)}",
			".dp-text{flex:1;white-space:pre-wrap;word-break:break-word}",
			".dp-rank{opacity:.45;min-width:1.4em;text-align:right;font-variant-numeric:tabular-nums}",
			".dp-meta{display:block;opacity:.5;font-size:11px;margin-top:3px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
			".dp-alert{color:#f87171}",
			".dp-empty{opacity:.6;font-style:italic}"
		].join("");

		function ensureCss() {
			if (typeof document === "undefined") return;
			if (document.getElementById(CSS_ID)) return;
			const tag = document.createElement("style");
			tag.id = CSS_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** POST to the plugin's own host route; same-origin so the cookie/loopback check passes. */
		async function call(body) {
			const res = await fetch(new URL(API, window.location.origin).toString(), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				cache: "no-store",
				credentials: "same-origin"
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok || data.ok === false) throw new Error(data.error || ("request failed (" + res.status + ")"));
			return data;
		}

		/** @returns `YYYY-MM-DD` for a stored timestamp. */
		function dateOf(ms) {
			const at = Number(ms);
			if (!Number.isFinite(at) || at <= 0) return "";
			return new Date(at).toISOString().slice(0, 10);
		}

		/** Order server entries by the server's ranking, newest first on ties. */
		function orderEntries(entries, ranked) {
			const rank = new Map((ranked || []).map((id, i) => [id, i]));
			return (entries || []).slice().sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
		}

		function PrimeHarnessSection() {
			/* `active` is the session/folder the host resolved for this panel. The page
			   is global while the stores are not, so it has to say what it is showing. */
			const [state, setState] = React.useState({ loading: true, error: "", cfg: null, scope: "session", entries: [], active: null });
			const [draft, setDraft] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [armed, setArmed] = React.useState(false);

			const load = React.useCallback(async (scope) => {
				setBusy(true);
				try {
					const data = await call({ op: "get", scope });
					setState({
						loading: false,
						error: "",
						cfg: data.config,
						scope: data.scope,
						entries: orderEntries(data.entries, data.ranked),
						active: data.active || null
					});
				} catch (error) {
					setState((s) => Object.assign({}, s, { loading: false, error: String((error && error.message) || error) }));
				} finally {
					setBusy(false);
				}
			}, []);

			React.useEffect(() => { load(undefined); }, [load]);

			const onScope = React.useCallback(async (scope) => {
				try {
					await call({ op: "setScope", scope });
					await load(scope);
				} catch (error) {
					setState((s) => Object.assign({}, s, { error: String((error && error.message) || error) }));
				}
			}, [load]);

			const onAdd = React.useCallback(async () => {
				if (!draft.trim() || busy) return;
				setBusy(true);
				try {
					const data = await call({ op: "add", scope: state.scope, text: draft });
					setDraft("");
					setState((s) => Object.assign({}, s, { error: "", entries: orderEntries(data.entries, data.ranked), active: data.active || s.active }));
				} catch (error) {
					setState((s) => Object.assign({}, s, { error: String((error && error.message) || error) }));
				} finally {
					setBusy(false);
				}
			}, [draft, busy, state.scope]);

			const onRemove = React.useCallback(async (id) => {
				setBusy(true);
				try {
					const data = await call({ op: "remove", scope: state.scope, id });
					setState((s) => Object.assign({}, s, { error: "", entries: data.entries }));
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
			const cfg = state.cfg || {};
			/* The stores are per-conversation and per-folder while this page is one page,
			   so name the target outright: "nothing recorded" and "showing a different
			   folder" look identical otherwise, and that is exactly how an empty list got
			   read as data loss. */
			const target = !state.active
				? "Open a chat to see its memory."
				: state.scope === "workspace"
					? state.active.cwd
					: "this conversation (" + String(state.active.id).replace(/^session-/, "").slice(0, 8) + ")";
			/* The harness's own segmented control: correct roles, arrow-key walking,
			   and the sliding indicator, for free — and it keeps this page looking like
			   the rest of Settings rather than a one-off. Two options never needed a
			   dropdown. */
			const scopeControl = h(SegmentedControl, {
				id: "dp-scope",
				value: state.scope,
				options: SCOPES.map((o) => ({ value: o.value, label: o.label })),
				onChange: onScope,
				label: "Harness scope",
				disabled: busy
			});

			const addRow = h("div", { className: "dp-row" },
				h(Input, {
					id: "dp-note",
					className: "dp-input",
					type: "text",
					placeholder: "A durable finding worth keeping…",
					"aria-label": "New refinement note",
					value: draft,
					disabled: busy,
					onChange: (e) => setDraft(e.target.value),
					onKeyDown: (e) => { if (e.key === "Enter") onAdd(); }
				}),
				h(Button, { type: "button", variant: "primary", disabled: busy || !draft.trim(), onClick: onAdd }, "Add")
			);

			const items = state.entries.length
				? h("ul", { className: "dp-list" }, state.entries.map((e, i) => h("li", { key: e.id, className: "dp-item" },
					h("span", { className: "dp-rank", title: "rank" }, String(i + 1)),
					h("span", { className: "dp-text" },
						e.text,
						/* The ref is the handle the agent needs to correct or delete this entry, so
						   show the same eight characters the prompt renders. Evidence rides along:
						   an entry that cannot say why it exists is one to delete. */
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
				)))
				: h("p", { className: "dp-empty" }, state.active
					? "Nothing recorded in " + current.label.toLowerCase() + " yet."
					: "No active chat, so there is no memory to show.");

			return h("div", { className: "dp-root" },
				h("h2", { className: "dp-h" }, "Prime Harness"),
				h("p", { className: "dp-sub" },
					"Run ",
					h("code", null, "/refine"),
					" to have the agent review this conversation and record what should outlive it, or add one below. Notes are re-ranked by relevance and re-injected after every compaction, so they survive context loss."
				),
				h("div", { className: "dp-field" },
					h("span", { className: "dp-label" }, "Scope"),
					scopeControl,
					h("span", { className: "dp-hint" }, current.hint),
					h("span", { className: "dp-target", title: target }, target)
				),
				h(Switch, {
					checked: cfg.autoRefineOnCompact !== false,
					onChange: onAuto,
					label: "Review this chat after it is compacted",
					title: "Ask the agent to record anything durable once the history is condensed."
				}),
				h("div", { className: "dp-field" },
					h("label", { className: "dp-label", htmlFor: "dp-note" }, "Add a refinement"),
					addRow
				),
				state.error ? h("p", { className: "dp-alert", role: "alert" }, state.error) : null,
				state.loading ? h("p", { className: "dp-hint" }, "Loading…") : items,
				state.entries.length
					? h("div", { className: "dp-row" },
						h(Button, { type: "button", variant: "danger", disabled: busy, onClick: onClear },
							armed ? "Confirm clear " + state.entries.length + " entries?" : "Clear " + current.label.toLowerCase()),
						h(Button, { type: "button", icon: IconRefreshOutlineRegular, disabled: busy, onClick: () => load(state.scope) }, "Refresh")
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
