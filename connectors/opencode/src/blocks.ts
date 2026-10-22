// What of our turn's answer went to the app, per OpenCode text block, so a
// block goes out once however OpenCode delivers it (forked from Workspaces):
//   - piece by piece (`session.text.delta`), the usual way;
//   - whole (`session.text.ended` only, as some providers do): sent there
//     when nothing of that block streamed;
//   - missing pieces: when `ended` carries more than streamed and starts with
//     it, the rest goes out.

export class TextBlocks {
	/** `${assistantMessageID}:${ordinal}` → the text sent for that block. */
	readonly #sent = new Map<string, string>();

	delta(messageId: string, ordinal: number, piece: string): string {
		const key = `${messageId}:${ordinal}`;
		this.#sent.set(key, (this.#sent.get(key) ?? "") + piece);
		return piece;
	}

	/** A block ended with its whole text: what is still to send, or "". */
	ended(messageId: string, ordinal: number, text: string): string {
		const key = `${messageId}:${ordinal}`;
		const sent = this.#sent.get(key) ?? "";
		const rest = sent.length === 0 ? text : text.startsWith(sent) ? text.slice(sent.length) : "";
		this.#sent.set(key, sent + rest);
		return rest;
	}

	clear(): void {
		this.#sent.clear();
	}
}
