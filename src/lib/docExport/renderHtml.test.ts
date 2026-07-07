import { describe, expect, it } from "vitest";
import { renderDocHtml } from "./renderHtml";
import type { GeneratedDoc } from "./types";

const doc: GeneratedDoc = {
	title: "Creating a <New> Ticket",
	overview: "This explains **ticket** creation.",
	audience: ["New users"],
	learn: ["How to create a ticket"],
	steps: [
		{ id: "step-1", heading: "Open the board", body: "Click **Board view**." },
		{ id: "step-2", heading: "Create", body: "Press Create." },
	],
};

describe("renderDocHtml", () => {
	it("inlines screenshots as base64 data URIs and never references external files", () => {
		const shots = new Map([
			["step-1", "data:image/png;base64,AAA1"],
			["step-2", "data:image/png;base64,AAA2"],
		]);
		const html = renderDocHtml(doc, shots);
		expect(html).toContain('src="data:image/png;base64,AAA1"');
		expect(html).toContain('src="data:image/png;base64,AAA2"');
		expect(html).not.toMatch(/src="https?:/);
		expect(html).not.toMatch(/src="\.\//);
	});

	it("escapes HTML in model text but renders **bold**", () => {
		const html = renderDocHtml(doc, new Map());
		expect(html).toContain("Creating a &lt;New&gt; Ticket");
		expect(html).toContain("<strong>ticket</strong>");
		expect(html).toContain("<strong>Board view</strong>");
	});

	it("emits the section structure in order", () => {
		const html = renderDocHtml(doc, new Map());
		expect(html.indexOf("Who This Guide Is For")).toBeGreaterThan(html.indexOf("<h1>"));
		expect(html.indexOf("What You&#39;ll Learn")).toBeGreaterThan(
			html.indexOf("Who This Guide Is For"),
		);
		expect(html.indexOf("Step-by-Step Instructions")).toBeGreaterThan(
			html.indexOf("What You&#39;ll Learn"),
		);
	});
});
