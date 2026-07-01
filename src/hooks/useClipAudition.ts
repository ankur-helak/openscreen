import { useCallback, useEffect, useRef, useState } from "react";

export interface UseClipAuditionResult {
	/** The key of the clip currently playing, or null. */
	auditioningKey: string | null;
	play(clip: { pcm: Float32Array; sampleRate: number }, key: string): void;
	stop(): void;
}

/**
 * Plays a single synthesized clip standalone via a lazily-created AudioContext. This is NOT the
 * timeline-synced preview (Plan 4) — it just auditions one clip so the user can hear a segment
 * right after generating it. One clip plays at a time; playing another (or unmount) stops it.
 */
export function useClipAudition(): UseClipAuditionResult {
	const [auditioningKey, setAuditioningKey] = useState<string | null>(null);
	const ctxRef = useRef<AudioContext | null>(null);
	const sourceRef = useRef<AudioBufferSourceNode | null>(null);

	const stop = useCallback(() => {
		const source = sourceRef.current;
		sourceRef.current = null;
		if (source) {
			source.onended = null;
			try {
				source.stop();
			} catch {
				// already stopped
			}
		}
		setAuditioningKey(null);
	}, []);

	const play = useCallback((clip: { pcm: Float32Array; sampleRate: number }, key: string) => {
		// Stop whatever is playing first.
		const prev = sourceRef.current;
		sourceRef.current = null;
		if (prev) {
			prev.onended = null;
			try {
				prev.stop();
			} catch {
				// ignore
			}
		}
		if (!ctxRef.current) {
			ctxRef.current = new AudioContext();
		}
		const ctx = ctxRef.current;
		const buffer = ctx.createBuffer(1, clip.pcm.length, clip.sampleRate);
		buffer.getChannelData(0).set(clip.pcm);
		const source = ctx.createBufferSource();
		source.buffer = buffer;
		source.connect(ctx.destination);
		source.onended = () => {
			if (sourceRef.current === source) {
				sourceRef.current = null;
				setAuditioningKey(null);
			}
		};
		sourceRef.current = source;
		setAuditioningKey(key);
		source.start();
	}, []);

	// Stop and release the context on unmount.
	useEffect(() => {
		return () => {
			const source = sourceRef.current;
			sourceRef.current = null;
			if (source) {
				source.onended = null;
				try {
					source.stop();
				} catch {
					// ignore
				}
			}
			if (ctxRef.current) {
				void ctxRef.current.close();
				ctxRef.current = null;
			}
		};
	}, []);

	return { auditioningKey, play, stop };
}
