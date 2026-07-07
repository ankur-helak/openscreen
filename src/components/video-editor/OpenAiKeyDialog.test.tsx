import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { nativeBridgeClient } from "@/native/client";
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

	it("clears the session-only note when remove key is clicked", async () => {
		// Mock session-only save
		vi.mocked(nativeBridgeClient.scriptPolish.setKey).mockResolvedValue({
			success: true,
			sessionOnly: true,
		});
		vi.mocked(nativeBridgeClient.scriptPolish.clearKey).mockResolvedValue({
			success: true,
		});

		const onKeyStatusChange = vi.fn();
		renderDialog({
			hasKey: true,
			secureStorageAvailable: false,
			onKeyStatusChange,
		});

		// Type a key and save
		const input = screen.getByPlaceholderText("sk-…");
		fireEvent.change(input, { target: { value: "sk-test123" } });

		const saveButton = screen.getByRole("button", { name: "Save key" });
		fireEvent.click(saveButton);

		// Wait for the note to appear
		await waitFor(() => {
			expect(screen.getByText(/Saved for this session/i)).toBeInTheDocument();
		});

		// Click remove key
		const removeButton = screen.getByRole("button", { name: "Remove key" });
		fireEvent.click(removeButton);

		// Note should be gone
		await waitFor(() => {
			expect(screen.queryByText(/Saved for this session/i)).not.toBeInTheDocument();
		});
	});
});
