// Desktop assets must stay inside the loaded extension directory in pi-gui 1.0.1.
export async function mount(root, host) {
	root.style.cssText = "padding:20px;font:14px system-ui;color:inherit";
	root.innerHTML = `<h2>Pi Durable pilot</h2><p>Fixed target: ticket 48489581088 · portal 5627913</p><label>Mode <select aria-label="Runner mode"><option value="offline">Offline proof</option><option value="live">Live investigation</option></select></label><p aria-live="polite" id="connection">Connecting…</p><button id="start">Start scoped investigation</button> <button id="reattach">Reattach / refresh</button> <button id="cancel">Cancel job</button><p id="approvals"></p><pre id="evidence" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>`;
	const connection = root.querySelector("#connection"),
		evidence = root.querySelector("#evidence"),
		mode = root.querySelector("select");
	const bindings = host.services.open({
		services: [{ id: "pi.durable.pilot" }],
		assertAccess() {
			if (host.signal.aborted) throw new Error("View disconnected");
		},
		onError(error) {
			connection.textContent = error.message;
		},
	});
	const api = bindings.use({ id: "pi.durable.pilot", local: false });
	// Chord accepts Context structurally; this is the mount-owned cancellation context.
	const context = {
		get abortSignal() {
			return host.signal;
		},
		value() {
			return undefined;
		},
	};
	await bindings.ready(context);
	let jobId,
		closed = false,
		busy = false;
	async function refresh() {
		if (closed || busy) return;
		busy = true;
		try {
			const state = JSON.parse(await api.inspect(mode.value, context));
			connection.textContent = state.connected
				? "Connected to detached runner"
				: "Disconnected";
			root.querySelector("#approvals").textContent = state.approvals;
			const jobs = state.jobs?.jobs ?? [];
			jobId = jobs.at(-1)?.id;
			evidence.textContent = JSON.stringify(state, null, 2);
		} catch (error) {
			connection.textContent = error.message;
		} finally {
			busy = false;
		}
	}
	root.querySelector("#start").onclick = async () => {
		try {
			const result = JSON.parse(await api.start(mode.value, context));
			evidence.textContent = JSON.stringify(result, null, 2);
			if (!result.ok) {
				connection.textContent = result.error?.message ?? "Blocked";
				return;
			}
			await refresh();
		} catch (error) {
			connection.textContent = error.message;
		}
	};
	root.querySelector("#reattach").onclick = refresh;
	root.querySelector("#cancel").onclick = async () => {
		if (jobId) {
			await api.cancel(mode.value, jobId, context);
			await refresh();
		}
	};
	mode.onchange = refresh;
	const timer = setInterval(refresh, 1000);
	await refresh();
	return async () => {
		closed = true;
		clearInterval(timer);
		await bindings.dispose(context);
		root.replaceChildren();
	};
}
