import type { GeneratedDoc } from "./types";

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Escape, then render a safe **bold** subset for UI-element emphasis. */
function inlineMarkup(s: string): string {
	return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

const STYLE = `
:root { color-scheme: light; }
body { max-width: 820px; margin: 0 auto; padding: 48px 24px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #0f172a; line-height: 1.6; }
h1 { font-size: 2.2rem; font-weight: 800; margin: 0 0 1.5rem; }
h2 { font-size: 1.4rem; font-weight: 700; margin: 2rem 0 0.75rem; }
.overview { background: #f5f8ff; border-left: 4px solid #4f7cff; border-radius: 6px; padding: 1rem 1.25rem; margin: 1rem 0 1.5rem; }
.overview p { margin: 0; }
ul { padding-left: 1.25rem; }
.step { margin: 1.5rem 0; }
figure { margin: 0.75rem 0 0; }
img { display: block; max-width: 100%; height: auto; border-radius: 8px; border: 1px solid #e2e8f0; }
`.trim();

/**
 * Assemble a self-contained HTML walkthrough. Screenshots are inlined as data URIs so images
 * can never break regardless of where the file is opened.
 */
export function renderDocHtml(doc: GeneratedDoc, screenshotsById: Map<string, string>): string {
	const listItems = (items: string[]) => items.map((x) => `<li>${inlineMarkup(x)}</li>`).join("");
	const steps = doc.steps
		.map((s) => {
			const img = screenshotsById.get(s.id);
			const figure = img
				? `<figure><img alt="${escapeHtml(s.heading)}" src="${img}" /></figure>`
				: "";
			return `<section class="step"><h2>${inlineMarkup(s.heading)}</h2><p>${inlineMarkup(s.body)}</p>${figure}</section>`;
		})
		.join("\n");

	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(doc.title)}</title><style>${STYLE}</style></head>
<body>
<h1>${escapeHtml(doc.title)}</h1>
<div class="overview"><p>${inlineMarkup(doc.overview)}</p></div>
<h2>Who This Guide Is For</h2>
<ul>${listItems(doc.audience)}</ul>
<h2>What You&#39;ll Learn</h2>
<ul>${listItems(doc.learn)}</ul>
<h2>Step-by-Step Instructions</h2>
${steps}
</body>
</html>`;
}
