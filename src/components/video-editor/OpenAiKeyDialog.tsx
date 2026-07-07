import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useScopedT } from "@/contexts/I18nContext";
import { nativeBridgeClient } from "@/native/client";

export interface OpenAiKeyDialogProps {
	open: boolean;
	hasKey: boolean;
	onOpenChange: (open: boolean) => void;
	onKeyStatusChange: () => void;
}

export function OpenAiKeyDialog({
	open,
	hasKey,
	onOpenChange,
	onKeyStatusChange,
}: OpenAiKeyDialogProps) {
	const t = useScopedT("voiceover");
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const save = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await nativeBridgeClient.scriptPolish.setKey(value);
			if (!res.success) {
				setError(res.message ?? t("polish.keyDialog.saveError"));
				return;
			}
			setValue("");
			onKeyStatusChange();
			onOpenChange(false);
		} finally {
			setBusy(false);
		}
	};

	const clear = async () => {
		setBusy(true);
		try {
			await nativeBridgeClient.scriptPolish.clearKey();
			onKeyStatusChange();
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("polish.keyDialog.title")}</DialogTitle>
					<DialogDescription>{t("polish.keyDialog.privacyNote")}</DialogDescription>
				</DialogHeader>
				<input
					type="password"
					value={value}
					placeholder={t("polish.keyDialog.placeholder")}
					onChange={(e) => setValue(e.target.value)}
					className="w-full rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-[#34B27B]/50"
				/>
				{error ? <p className="text-xs text-red-300">{error}</p> : null}
				<DialogFooter className="gap-2">
					{hasKey ? (
						<Button type="button" variant="ghost" disabled={busy} onClick={clear}>
							{t("polish.keyDialog.clear")}
						</Button>
					) : null}
					<Button type="button" disabled={busy || value.trim().length === 0} onClick={save}>
						{t("polish.keyDialog.save")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
