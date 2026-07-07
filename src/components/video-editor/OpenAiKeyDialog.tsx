import { useEffect, useState } from "react";
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
	secureStorageAvailable: boolean;
	onOpenChange: (open: boolean) => void;
	onKeyStatusChange: () => void;
}

export function OpenAiKeyDialog({
	open,
	hasKey,
	secureStorageAvailable,
	onOpenChange,
	onKeyStatusChange,
}: OpenAiKeyDialogProps) {
	const t = useScopedT("voiceover");
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);

	const save = async () => {
		setBusy(true);
		setError(null);
		setNote(null);
		try {
			const res = await nativeBridgeClient.scriptPolish.setKey(value);
			if (!res.success) {
				setError(res.message ?? t("polish.keyDialog.saveError"));
				return;
			}
			setValue("");
			onKeyStatusChange();
			if (res.sessionOnly) {
				// Keep the dialog open so the user sees the session-only confirmation.
				setNote(t("polish.keyDialog.sessionOnlySaved"));
			} else {
				onOpenChange(false);
			}
		} finally {
			setBusy(false);
		}
	};

	const clear = async () => {
		setBusy(true);
		setNote(null);
		setError(null);
		try {
			await nativeBridgeClient.scriptPolish.clearKey();
			onKeyStatusChange();
		} finally {
			setBusy(false);
		}
	};

	useEffect(() => {
		if (!open) {
			setNote(null);
			setError(null);
		}
	}, [open]);

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
				{!secureStorageAvailable ? (
					<p className="text-xs text-amber-300/80">{t("polish.keyDialog.sessionOnlyHint")}</p>
				) : null}
				{note ? <p className="text-xs text-emerald-300">{note}</p> : null}
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
