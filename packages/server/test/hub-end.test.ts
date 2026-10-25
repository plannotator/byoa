// Hub.subscribe's onEnd: a hub that can no longer deliver (a Durable Object
// adapter whose event stream read failed after a reset) ends the
// subscription. The tab's SSE stream then closes cleanly, so the browser's
// EventSource reconnects and gets a fresh session list.

import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryStore, SessionHub, type ByoaStore, type HubEvent, type UiEvent } from "../src/index.ts";
import { makeApp, settle, sseReader } from "./harness.ts";

/** memoryStore's durable half, and hubs whose subscriptions a test can end
 * (or make fail) the way a remote hub would. */
function endingStore(opts: { failSubscribe?: boolean } = {}) {
	const durable = memoryStore();
	const hubs = new Map<string, SessionHub>();
	const ends: (() => void)[] = [];
	class EndingHub extends SessionHub {
		override subscribe(listener: (event: HubEvent) => void, onEnd?: () => void): () => void {
			if (opts.failSubscribe) throw new Error("the object was reset");
			if (onEnd !== undefined) ends.push(onEnd);
			return super.subscribe(listener);
		}
	}
	const store: ByoaStore = {
		pairings: durable.pairings,
		connections: durable.connections,
		hub(userId, config) {
			let hub = hubs.get(userId);
			if (hub === undefined) hubs.set(userId, (hub = new EndingHub(config)));
			return hub;
		},
	};
	return { store, ends };
}

test("onEnd closes the tab's stream; a new stream starts with the session list", async () => {
	const { store, ends } = endingStore();
	const app = makeApp({ store });
	const { token } = await app.pair();
	const id = await app.register(token);

	const first = sseReader(await app.call("GET", "/byoa/ui/events", { user: "ramos" }));
	await settle();
	assert.equal(first.events()[0]?.type, "sessions");
	assert.equal(ends.length, 1);

	ends[0]?.();
	await settle();
	assert.ok(first.ended(), "the stream closed");

	const second = sseReader(await app.call("GET", "/byoa/ui/events", { user: "ramos" }));
	await settle();
	const snapshot = second.events()[0];
	assert.equal(snapshot?.type, "sessions");
	assert.equal(snapshot?.data.connections[0].sessions[0].id, id);
	assert.ok(!second.ended());
	await second.cancel();
});

test("byoa.subscribe: onEnd runs once, after the events already on their way, then nothing more", async () => {
	const { store, ends } = endingStore();
	const app = makeApp({ store });
	const { token } = await app.pair();
	const id = await app.register(token);
	const seen: string[] = [];
	let endCalls = 0;
	app.byoa.subscribe("ramos", (event: UiEvent) => void seen.push(event.type), () => {
		seen.push("end");
		endCalls++;
	});
	ends[0]?.();
	ends[0]?.();
	await settle();
	assert.deepEqual(seen, ["sessions", "end"]);
	assert.equal(endCalls, 1);
	await app.byoa.send("ramos", id, { text: "after the end" });
	await settle();
	assert.deepEqual(seen, ["sessions", "end"], "an ended subscription hears nothing more");
});

test("onEnd after the tab went away does nothing", async () => {
	const { store, ends } = endingStore();
	const app = makeApp({ store });
	let endCalls = 0;
	const stop = app.byoa.subscribe("ramos", () => undefined, () => void endCalls++);
	await settle();
	stop();
	ends[0]?.();
	await settle();
	assert.equal(endCalls, 0);
});

test("a hub that fails to subscribe ends the stream instead of leaving it silent", async () => {
	const { store } = endingStore({ failSubscribe: true });
	const app = makeApp({ store });
	const sse = sseReader(await app.call("GET", "/byoa/ui/events", { user: "ramos" }));
	await settle();
	assert.ok(sse.ended());
	let ended = false;
	app.byoa.subscribe("ramos", () => undefined, () => void (ended = true));
	await settle();
	assert.ok(ended);
});

test("SessionHub never ends a subscription by itself", async () => {
	const app = makeApp();
	const { token } = await app.pair();
	await app.register(token);
	let ended = false;
	const stop = app.byoa.subscribe("ramos", () => undefined, () => void (ended = true));
	await app.clock.advance(10 * 60_000);
	assert.equal(ended, false);
	stop();
});
