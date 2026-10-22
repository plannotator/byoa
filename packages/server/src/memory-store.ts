// The in-process store: durable records in Maps and one SessionHub per
// person. Right for one server process (a local app, a single container,
// tests). A restart forgets connections too, so every agent pairs again;
// an app with more than one process, or that restarts often, implements
// PairingStore and ConnectionStore on its database (store.ts).

import { SessionHub } from "./hub.ts";
import type { ByoaStore, ConnectionRecord, Hub, PairingRecord } from "./store.ts";

export function memoryStore(): ByoaStore {
	const pairings = new Map<string, PairingRecord>();
	const connections = new Map<string, ConnectionRecord>();
	const hubs = new Map<string, Hub>();

	const prune = (now: number): void => {
		for (const [id, p] of pairings) if (p.expires_at <= now) pairings.delete(id);
	};

	return {
		pairings: {
			insert(pairing) {
				prune(pairing.created_at);
				for (const p of pairings.values()) if (p.user_code_hash === pairing.user_code_hash) return false;
				pairings.set(pairing.id, { ...pairing });
				return true;
			},
			findByUserCode(hash, now) {
				for (const p of pairings.values())
					if (p.user_code_hash === hash && p.status === "pending" && p.expires_at > now) return { ...p };
				return null;
			},
			findByDeviceCode(hash) {
				for (const p of pairings.values()) if (p.device_code_hash === hash) return { ...p };
				return null;
			},
			notePoll(id, now) {
				const p = pairings.get(id);
				if (p === undefined) return null;
				const previous = p.last_poll_at;
				p.last_poll_at = now;
				return previous;
			},
			decide(id, decision, approver, now) {
				const p = pairings.get(id);
				if (p === undefined || p.status !== "pending" || p.expires_at <= now) return false;
				p.status = decision;
				p.approved_by = approver;
				return true;
			},
			collect(id, connection, now) {
				const p = pairings.get(id);
				if (p === undefined || p.status !== "approved" || p.expires_at <= now) return false;
				p.status = "collected";
				connections.set(connection.id, { ...connection });
				return true;
			},
		},
		connections: {
			byTokenHash(hash) {
				for (const c of connections.values()) if (c.token_hash === hash) return { ...c };
				return null;
			},
			get(id) {
				const c = connections.get(id);
				return c === undefined ? null : { ...c };
			},
			listByUser(userId) {
				return [...connections.values()].filter((c) => c.user_id === userId).map((c) => ({ ...c }));
			},
			revoke(id, now) {
				const c = connections.get(id);
				if (c === undefined) return null;
				c.revoked_at ??= now;
				return { ...c };
			},
			touch(id, now) {
				const c = connections.get(id);
				if (c !== undefined) c.last_seen_at = now;
			},
		},
		hub(userId, config) {
			let hub = hubs.get(userId);
			if (hub === undefined) {
				hub = new SessionHub(config);
				hubs.set(userId, hub);
			}
			return hub;
		},
	};
}
