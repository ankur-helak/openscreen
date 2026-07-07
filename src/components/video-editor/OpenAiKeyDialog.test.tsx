import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { OpenAiKeyDialog } from "./OpenAiKeyDialog";

vi.mock("@/native/client", () => ({
	nativeBridgeClient: { scriptPolish: { setKey: vi.fn(), clearKey: vi.fn() } },
}));

function renderDialog(overrides: Partial<React.ComponentProps<typeof OpenAiKeyDialog>> = {}) {
	render(
		<I18nProvider>
			<OpenAiKeyDialog
				open
				hasKey={false}
				secureStorageAvailable
				onOpenChange={vi.fn()}
				onKeyStatusChange={vi.fn()}
				{...overrides}
			/>
		</I18nProvider>,
	);
}

describe("OpenAiKeyDialog", () => {
	it("shows the session-only hint when secure storage is unavailable", () => {
		renderDialog({ secureStorageAvailable: false });
		expect(screen.getByText(/this session only/i)).toBeInTheDocument();
	});

	it("does not show the hint when secure storage is available", () => {
		renderDialog({ secureStorageAvailable: true });
		expect(screen.queryByText(/this session only/i)).not.toBeInTheDocument();
	});
});
