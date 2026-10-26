// What the model sees of a tools/call result (mcp.ts resultText). Found with
// real Claude Code on Workspaces staging: its MCP answered a one-line summary
// in the text and the data in structuredContent, and the agent saw only the
// summary, so it could not read the thread it was tagged in.

import assert from "node:assert/strict";
import { test } from "node:test";
import { resultText } from "../src/mcp.ts";

const data = { annotations: [{ id: "anno_1", body: "Please review" }] };

test("a summary text and structured data: the model gets both", () => {
	const { text } = resultText({ content: [{ type: "text", text: "Listed 1 annotations." }], structuredContent: data });
	assert.equal(text, `Listed 1 annotations.\n${JSON.stringify(data)}`);
});

test("a text block that already is the structured JSON is not repeated", () => {
	const pretty = JSON.stringify(data, null, 2);
	assert.equal(resultText({ content: [{ type: "text", text: pretty }], structuredContent: data }).text, pretty);
});

test("structured data alone, text alone, and other parts", () => {
	assert.equal(resultText({ structuredContent: data }).text, JSON.stringify(data));
	assert.equal(resultText({ content: [{ type: "text", text: "done" }] }).text, "done");
	assert.equal(resultText({ content: [{ type: "image", data: "x" }, { type: "text", text: "a" }] }).text, "[image omitted]\na");
	assert.deepEqual(resultText({ content: [{ type: "text", text: "no" }], isError: true }), { text: "no", isError: true });
	assert.equal(resultText(null).text, "");
});
