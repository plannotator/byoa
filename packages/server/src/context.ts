// What every door module needs from createByoa, in one object, so the door
// modules stay plain functions of (context, request).

import type { ByoaStore, ConnectionRecord, Hub } from "./store.ts";
import type { ByoaOptions, ByoaUser, Clock, UiConnection, UiEvent } from "./types.ts";

export interface Ctx {
	app: ByoaOptions["app"];
	base: string;
	store: ByoaStore;
	clock: Clock;
	pollHoldSeconds: number;
	autoApprove: ByoaOptions["autoApprove"];
	authenticate(req: Request): Promise<ByoaUser | null>;
	checkCsrf(req: Request): boolean;
	hub(userId: string): Hub;
	/** The live connection a bearer token names, or null. */
	connectionOf(req: Request): Promise<ConnectionRecord | null>;
	revoke(connectionId: string): Promise<void>;
	sessions(userId: string): Promise<UiConnection[]>;
	subscribe(userId: string, listener: (event: UiEvent) => void): () => void;
}
