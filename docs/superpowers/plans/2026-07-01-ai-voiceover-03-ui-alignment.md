# AI Voiceover — Plan 3: UI + Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the already-built voiceover engine + data model reachable in the editor: a `VoiceoverPanel` (new project-wide panel mode), a read-only "Voiceover" timeline row, a pure `layoutVoiceover()` alignment function, and instantiation of the existing `useVoiceover` hook inside `VideoEditor.tsx` — plus fold in the two carried-over `useVoiceover` cleanups and a `voiceover` i18n namespace.

**Architecture:** The voiceover *engine* (`src/lib/tts/`), *data model* (`src/lib/voiceover/`), *undoable state* (`VoiceoverConfig` on `EditorState`), *native-bridge cache* (`nativeBridgeClient.voiceover`), and *orchestration hook* (`src/hooks/useVoiceover.ts`) all landed in Plans 1–2. This plan is **UI + wiring only**: build presentational components, a pure layout function, and prop-drill the hook's results — mirroring how `VideoEditor.tsx` owns state and prop-drills into `SettingsPanel`/`TimelineEditor`. The right panel is a nav-rail keyed on `activePanelMode: SettingsPanelMode` (local to `SettingsPanel`), so voiceover surfaces as a new project-wide mode `"voiceover"` rendering a standalone `<VoiceoverPanel>`. The timeline axis is **source time** (`range = {0, videoDurationMs}`), so the voiceover row draws clips at their source anchors and dims trimmed ones; `layoutVoiceover` (output-time playback layout) is built and unit-tested here but its runtime consumers arrive in Plan 4.

**Tech Stack:** TypeScript, React (function components + `XxxProps` interfaces, `useScopedT` i18n, Tailwind + `cn()`, shadcn/ui primitives in `@/components/ui/`), `dnd-timeline` (timeline), Web Audio (`AudioContext` for single-clip audition), Vitest (jsdom unit tier + Chromium browser tier), Biome.

## Context: this is Plan 3 of 4

Design spec: `docs/superpowers/specs/2026-07-01-ai-voiceover-replace-narration-design.md` (see especially **§15 "Plan 3 resolved decisions"**).

1. Plan 1 — TTS engine foundation (done): `src/lib/tts/` (`getKokoroProvider()`, `KOKORO_VOICES`, `DEFAULT_KOKORO_VOICE`), Kokoro worker, offline model bundling.
2. Plan 2 — Voiceover data + persistence (done): `src/lib/voiceover/` (`types.ts`, `audioKey.ts`, `segmentation.ts`), `VoiceoverConfig` in `EditorState` + project v3, native-bridge `voiceover` cache, `useVoiceover` hook.
3. **Plan 3 — UI + alignment** (this doc): `VoiceoverPanel`, timeline row, `layoutVoiceover`, instantiate `useVoiceover` in `VideoEditor.tsx`, `voiceover` i18n namespace.
4. Plan 4 — Preview + export: Web-Audio timeline-synced preview, `synthesizeVoiceoverTrack` export path, polish.

### Already built for you to consume — do NOT rebuild

- **`useVoiceover`** (`src/hooks/useVoiceover.ts`): `useVoiceover({ config, transcript, onChange, provider? }) → { statuses: Record<id, SegmentSynthStatus>, clips: Record<audioKey, ResolvedClip>, audioKeyFor(segment)→string, seedFromTranscript(), generateSegment(id), generateAll() }`. `ResolvedClip = { pcm: Float32Array; sampleRate: number; durationMs: number }`. `clips` is keyed by **audioKey**; `statuses` by **segment id**.
- **`VoiceoverConfig`** on undoable `EditorState` (`src/hooks/useEditorHistory.ts`): `{ enabled, engine, voice, speed, segments: VoiceoverSegment[] }`. `VoiceoverSegment = { id, sourceStartMs, sourceEndMs, text }`. Defaults: `DEFAULT_VOICEOVER_CONFIG`.
- **`SegmentSynthStatus`** (`src/lib/voiceover/types.ts`): `{state:"idle"} | {state:"queued"} | {state:"synthesizing"} | {state:"ready"; audioKey; durationMs} | {state:"error"; message}`.
- **`nativeBridgeClient.voiceover`** (`src/native/client.ts`): `getClip(key)`, `putClip(key, pcmArrayBuffer, sampleRate)`.
- **`computeAudioKey({text,voice,speed})`**, **`segmentTranscript(CaptionSegment[])→VoiceoverSegmentDraft[]`**, **`KOKORO_VOICES: TtsVoice[]`** (`{id,label,lang}`), **`DEFAULT_KOKORO_VOICE`**.

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from the spec / repo conventions.

- **Node 22.x / npm 10.x** (`package.json#engines`); do not change engine pins.
- **`kokoro-js` pinned to exactly `1.2.1`** — do not widen to a caret.
- **Renderer imports (`src/`) use the `@/*` → `src/*` alias** — never deep relative paths across features. Within a feature folder, relative sibling imports are fine. **`electron/` uses relative imports only.**
- **Any user-facing string** goes through `useScopedT(namespace)` and must exist in **all 13 locales** under `src/i18n/locales/<locale>/<namespace>.json` (baseline `en`). A locale missing a required namespace file is **dropped from the app entirely** by `src/i18n/loader.ts`. Verify with `npm run i18n:check`.
- **Production strips `console.log`/`console.debug`** (terser `drop_console`). Logging that must survive prod uses `console.warn`/`console.error`/`console.info`, tagged (`[useVoiceover]`, `[VoiceoverPanel]`, `[useClipAudition]`).
- **Security:** every `BrowserWindow` runs `contextIsolation: true`, `nodeIntegration: false` — do not weaken. Renderer/worker never require Node builtins at runtime; call native features via `nativeBridgeClient.*`, never raw IPC.
- **Kokoro output:** mono Float32 PCM @ **24000 Hz**. Voice ids match `KOKORO_VOICES`; default `DEFAULT_KOKORO_VOICE = "af_heart"`. Voiceover speed clamps **0.7–1.2**.
- **Style:** `interface` for object shapes, `type` for unions; **no `enum`**; avoid `any`. Components are `function` declarations with an `XxxProps` interface; Tailwind via `cn()`/`cva`. Match surrounding code.
- **CI gates (all must stay green):** `npm run lint` (Biome), `npx tsc --noEmit`, `npm run test`, `npx vite build`. Additionally for this plan: `npm run i18n:check` (adds strings) and `npm run test:browser` (touches render code).

---

### Task 1: Add the `voiceover` i18n namespace (all 13 locales)

Register a new `voiceover` namespace and create its JSON in every locale. This unblocks every UI task: `useScopedT` is typed as `useScopedT(namespace: I18nNamespace)`, so `useScopedT("voiceover")` only type-checks once `"voiceover"` is in `I18N_NAMESPACES`.

**Files:**
- Modify: `src/i18n/config.ts` (add `"voiceover"` to `I18N_NAMESPACES`)
- Create: `src/i18n/locales/en/voiceover.json`
- Create: `src/i18n/locales/{ar,es,fr,it,ja-JP,ko-KR,ru,tr,vi,pt-BR,zh-CN,zh-TW}/voiceover.json`

**Interfaces:**
- Consumes: nothing.
- Produces: the `"voiceover"` `I18nNamespace` member and its keys, consumed by Tasks 5–9 via `useScopedT("voiceover")`. Key set (leaf paths): `navLabel`, `title`, `description`, `enableLabel`, `enableHint`, `voiceLabel`, `speedLabel`, `generateAll`, `generating` (`{{done}}`,`{{total}}`), `regenerate`, `play`, `stop`, `resetScript`, `textPlaceholder`, `status.{idle,queued,synthesizing,ready,error}`, `noTranscript`, `transcribing`, `noSegments`, `rowHint`, `trimmedTitle`.

- [ ] **Step 1: Register the namespace**

In `src/i18n/config.ts`, add `"voiceover"` to the `I18N_NAMESPACES` tuple (keep it sorted-ish with the others):

```ts
export const I18N_NAMESPACES = [
	"common",
	"dialogs",
	"editor",
	"launch",
	"settings",
	"shortcuts",
	"timeline",
	"voiceover",
] as const;
```

- [ ] **Step 2: Create the English baseline**

Create `src/i18n/locales/en/voiceover.json`:

```json
{
	"navLabel": "Voiceover",
	"title": "AI Voiceover",
	"description": "Replace your original narration with a clean on-device voice, generated from your transcript.",
	"enableLabel": "Enable voiceover",
	"enableHint": "Mutes the original audio and plays the generated voice instead.",
	"voiceLabel": "Voice",
	"speedLabel": "Speed",
	"generateAll": "Generate all",
	"generating": "Generating… {{done}}/{{total}}",
	"regenerate": "Regenerate",
	"play": "Play",
	"stop": "Stop",
	"resetScript": "Reset script to transcript",
	"textPlaceholder": "Segment script…",
	"status": {
		"idle": "Not generated",
		"queued": "Queued",
		"synthesizing": "Generating…",
		"ready": "Ready",
		"error": "Failed"
	},
	"noTranscript": "Record or open a video with speech — the script is generated from its transcript.",
	"transcribing": "Transcribing… the script will be ready when the transcript finishes.",
	"noSegments": "No script yet. Reset from transcript to get started.",
	"rowHint": "Enable voiceover to see generated narration here",
	"trimmedTitle": "This clip's words fall in a trimmed region and won't play"
}
```

- [ ] **Step 3: Create the 12 translated locale files**

Create each file with the identical key structure, values translated for that locale, and the `{{done}}`/`{{total}}` placeholders + `…` ellipsis preserved verbatim. Match the tone/terminology of the sibling files already in each locale folder.

`src/i18n/locales/es/voiceover.json`:
```json
{
	"navLabel": "Voz en off",
	"title": "Voz en off con IA",
	"description": "Reemplaza tu narración original por una voz limpia generada en el dispositivo a partir de tu transcripción.",
	"enableLabel": "Activar voz en off",
	"enableHint": "Silencia el audio original y reproduce la voz generada en su lugar.",
	"voiceLabel": "Voz",
	"speedLabel": "Velocidad",
	"generateAll": "Generar todo",
	"generating": "Generando… {{done}}/{{total}}",
	"regenerate": "Regenerar",
	"play": "Reproducir",
	"stop": "Detener",
	"resetScript": "Restablecer el guion a la transcripción",
	"textPlaceholder": "Guion del segmento…",
	"status": {
		"idle": "Sin generar",
		"queued": "En cola",
		"synthesizing": "Generando…",
		"ready": "Listo",
		"error": "Error"
	},
	"noTranscript": "Graba o abre un vídeo con voz: el guion se genera a partir de su transcripción.",
	"transcribing": "Transcribiendo… el guion estará listo cuando termine la transcripción.",
	"noSegments": "Aún no hay guion. Restablece desde la transcripción para empezar.",
	"rowHint": "Activa la voz en off para ver aquí la narración generada",
	"trimmedTitle": "Las palabras de este clip caen en una región recortada y no se reproducirán"
}
```

`src/i18n/locales/fr/voiceover.json`:
```json
{
	"navLabel": "Voix off",
	"title": "Voix off IA",
	"description": "Remplacez votre narration d'origine par une voix nette générée sur l'appareil à partir de votre transcription.",
	"enableLabel": "Activer la voix off",
	"enableHint": "Coupe l'audio d'origine et lit la voix générée à la place.",
	"voiceLabel": "Voix",
	"speedLabel": "Vitesse",
	"generateAll": "Tout générer",
	"generating": "Génération… {{done}}/{{total}}",
	"regenerate": "Régénérer",
	"play": "Lire",
	"stop": "Arrêter",
	"resetScript": "Réinitialiser le script sur la transcription",
	"textPlaceholder": "Script du segment…",
	"status": {
		"idle": "Non généré",
		"queued": "En file d'attente",
		"synthesizing": "Génération…",
		"ready": "Prêt",
		"error": "Échec"
	},
	"noTranscript": "Enregistrez ou ouvrez une vidéo avec de la parole : le script est généré à partir de sa transcription.",
	"transcribing": "Transcription… le script sera prêt une fois la transcription terminée.",
	"noSegments": "Pas encore de script. Réinitialisez depuis la transcription pour commencer.",
	"rowHint": "Activez la voix off pour voir ici la narration générée",
	"trimmedTitle": "Les mots de ce clip se trouvent dans une région coupée et ne seront pas lus"
}
```

`src/i18n/locales/it/voiceover.json`:
```json
{
	"navLabel": "Voce fuori campo",
	"title": "Voce fuori campo IA",
	"description": "Sostituisci la narrazione originale con una voce pulita generata sul dispositivo a partire dalla trascrizione.",
	"enableLabel": "Attiva la voce fuori campo",
	"enableHint": "Disattiva l'audio originale e riproduce al suo posto la voce generata.",
	"voiceLabel": "Voce",
	"speedLabel": "Velocità",
	"generateAll": "Genera tutto",
	"generating": "Generazione… {{done}}/{{total}}",
	"regenerate": "Rigenera",
	"play": "Riproduci",
	"stop": "Ferma",
	"resetScript": "Ripristina il copione alla trascrizione",
	"textPlaceholder": "Copione del segmento…",
	"status": {
		"idle": "Non generato",
		"queued": "In coda",
		"synthesizing": "Generazione…",
		"ready": "Pronto",
		"error": "Errore"
	},
	"noTranscript": "Registra o apri un video con parlato: il copione viene generato dalla sua trascrizione.",
	"transcribing": "Trascrizione… il copione sarà pronto al termine della trascrizione.",
	"noSegments": "Ancora nessun copione. Ripristina dalla trascrizione per iniziare.",
	"rowHint": "Attiva la voce fuori campo per vedere qui la narrazione generata",
	"trimmedTitle": "Le parole di questa clip ricadono in una regione tagliata e non verranno riprodotte"
}
```

`src/i18n/locales/pt-BR/voiceover.json`:
```json
{
	"navLabel": "Narração",
	"title": "Narração com IA",
	"description": "Substitua sua narração original por uma voz limpa gerada no dispositivo a partir da sua transcrição.",
	"enableLabel": "Ativar narração",
	"enableHint": "Silencia o áudio original e reproduz a voz gerada no lugar.",
	"voiceLabel": "Voz",
	"speedLabel": "Velocidade",
	"generateAll": "Gerar tudo",
	"generating": "Gerando… {{done}}/{{total}}",
	"regenerate": "Regerar",
	"play": "Reproduzir",
	"stop": "Parar",
	"resetScript": "Redefinir o roteiro para a transcrição",
	"textPlaceholder": "Roteiro do segmento…",
	"status": {
		"idle": "Não gerado",
		"queued": "Na fila",
		"synthesizing": "Gerando…",
		"ready": "Pronto",
		"error": "Falhou"
	},
	"noTranscript": "Grave ou abra um vídeo com fala — o roteiro é gerado a partir da transcrição.",
	"transcribing": "Transcrevendo… o roteiro ficará pronto quando a transcrição terminar.",
	"noSegments": "Ainda sem roteiro. Redefina a partir da transcrição para começar.",
	"rowHint": "Ative a narração para ver aqui a narração gerada",
	"trimmedTitle": "As palavras deste clipe estão em uma região cortada e não serão reproduzidas"
}
```

`src/i18n/locales/de` does not exist — skip. `src/i18n/locales/ru/voiceover.json`:
```json
{
	"navLabel": "Озвучка",
	"title": "ИИ-озвучка",
	"description": "Замените исходную озвучку чистым голосом, сгенерированным на устройстве по вашей расшифровке.",
	"enableLabel": "Включить озвучку",
	"enableHint": "Отключает исходный звук и воспроизводит сгенерированный голос вместо него.",
	"voiceLabel": "Голос",
	"speedLabel": "Скорость",
	"generateAll": "Сгенерировать всё",
	"generating": "Генерация… {{done}}/{{total}}",
	"regenerate": "Сгенерировать заново",
	"play": "Воспроизвести",
	"stop": "Стоп",
	"resetScript": "Сбросить сценарий к расшифровке",
	"textPlaceholder": "Сценарий сегмента…",
	"status": {
		"idle": "Не сгенерировано",
		"queued": "В очереди",
		"synthesizing": "Генерация…",
		"ready": "Готово",
		"error": "Ошибка"
	},
	"noTranscript": "Запишите или откройте видео с речью — сценарий создаётся из его расшифровки.",
	"transcribing": "Расшифровка… сценарий будет готов после завершения расшифровки.",
	"noSegments": "Сценария пока нет. Сбросьте из расшифровки, чтобы начать.",
	"rowHint": "Включите озвучку, чтобы увидеть здесь сгенерированную озвучку",
	"trimmedTitle": "Слова этого клипа попадают в обрезанную область и не будут воспроизведены"
}
```

`src/i18n/locales/tr/voiceover.json`:
```json
{
	"navLabel": "Seslendirme",
	"title": "Yapay Zekâ Seslendirme",
	"description": "Orijinal anlatımınızı, transkriptinizden cihazda üretilen temiz bir sesle değiştirin.",
	"enableLabel": "Seslendirmeyi etkinleştir",
	"enableHint": "Orijinal sesi kapatır ve onun yerine üretilen sesi çalar.",
	"voiceLabel": "Ses",
	"speedLabel": "Hız",
	"generateAll": "Tümünü üret",
	"generating": "Üretiliyor… {{done}}/{{total}}",
	"regenerate": "Yeniden üret",
	"play": "Oynat",
	"stop": "Durdur",
	"resetScript": "Metni transkripte sıfırla",
	"textPlaceholder": "Segment metni…",
	"status": {
		"idle": "Üretilmedi",
		"queued": "Sırada",
		"synthesizing": "Üretiliyor…",
		"ready": "Hazır",
		"error": "Başarısız"
	},
	"noTranscript": "Konuşma içeren bir video kaydedin veya açın — metin, transkriptinden üretilir.",
	"transcribing": "Transkript oluşturuluyor… transkript bitince metin hazır olacak.",
	"noSegments": "Henüz metin yok. Başlamak için transkriptten sıfırlayın.",
	"rowHint": "Üretilen anlatımı burada görmek için seslendirmeyi etkinleştirin",
	"trimmedTitle": "Bu klibin sözcükleri kırpılmış bir bölgeye denk geliyor ve çalınmayacak"
}
```

`src/i18n/locales/vi/voiceover.json`:
```json
{
	"navLabel": "Lồng tiếng",
	"title": "Lồng tiếng AI",
	"description": "Thay lời tường thuật gốc bằng một giọng nói rõ ràng được tạo ngay trên thiết bị từ bản chép lời của bạn.",
	"enableLabel": "Bật lồng tiếng",
	"enableHint": "Tắt âm thanh gốc và phát giọng nói được tạo ra thay thế.",
	"voiceLabel": "Giọng",
	"speedLabel": "Tốc độ",
	"generateAll": "Tạo tất cả",
	"generating": "Đang tạo… {{done}}/{{total}}",
	"regenerate": "Tạo lại",
	"play": "Phát",
	"stop": "Dừng",
	"resetScript": "Đặt lại kịch bản theo bản chép lời",
	"textPlaceholder": "Kịch bản đoạn…",
	"status": {
		"idle": "Chưa tạo",
		"queued": "Trong hàng đợi",
		"synthesizing": "Đang tạo…",
		"ready": "Sẵn sàng",
		"error": "Thất bại"
	},
	"noTranscript": "Ghi hoặc mở một video có lời nói — kịch bản được tạo từ bản chép lời của nó.",
	"transcribing": "Đang chép lời… kịch bản sẽ sẵn sàng khi chép lời hoàn tất.",
	"noSegments": "Chưa có kịch bản. Đặt lại từ bản chép lời để bắt đầu.",
	"rowHint": "Bật lồng tiếng để xem phần lồng tiếng đã tạo ở đây",
	"trimmedTitle": "Lời của đoạn này nằm trong vùng đã cắt và sẽ không được phát"
}
```

`src/i18n/locales/ja-JP/voiceover.json`:
```json
{
	"navLabel": "ナレーション",
	"title": "AIナレーション",
	"description": "元のナレーションを、文字起こしから端末上で生成したクリアな音声に置き換えます。",
	"enableLabel": "ナレーションを有効にする",
	"enableHint": "元の音声をミュートし、代わりに生成した音声を再生します。",
	"voiceLabel": "声",
	"speedLabel": "速度",
	"generateAll": "すべて生成",
	"generating": "生成中… {{done}}/{{total}}",
	"regenerate": "再生成",
	"play": "再生",
	"stop": "停止",
	"resetScript": "台本を文字起こしにリセット",
	"textPlaceholder": "セグメントの台本…",
	"status": {
		"idle": "未生成",
		"queued": "待機中",
		"synthesizing": "生成中…",
		"ready": "準備完了",
		"error": "失敗"
	},
	"noTranscript": "音声のある動画を録画または開いてください。台本はその文字起こしから生成されます。",
	"transcribing": "文字起こし中… 文字起こしが完了すると台本が準備できます。",
	"noSegments": "まだ台本がありません。文字起こしからリセットして開始してください。",
	"rowHint": "ナレーションを有効にすると、生成されたナレーションがここに表示されます",
	"trimmedTitle": "このクリップの言葉はトリミング領域に含まれており、再生されません"
}
```

`src/i18n/locales/ko-KR/voiceover.json`:
```json
{
	"navLabel": "내레이션",
	"title": "AI 내레이션",
	"description": "원본 내레이션을 기기에서 자막으로 생성한 깨끗한 음성으로 교체합니다.",
	"enableLabel": "내레이션 사용",
	"enableHint": "원본 오디오를 음소거하고 대신 생성된 음성을 재생합니다.",
	"voiceLabel": "음성",
	"speedLabel": "속도",
	"generateAll": "모두 생성",
	"generating": "생성 중… {{done}}/{{total}}",
	"regenerate": "다시 생성",
	"play": "재생",
	"stop": "중지",
	"resetScript": "대본을 자막으로 초기화",
	"textPlaceholder": "세그먼트 대본…",
	"status": {
		"idle": "생성 안 됨",
		"queued": "대기 중",
		"synthesizing": "생성 중…",
		"ready": "준비됨",
		"error": "실패"
	},
	"noTranscript": "음성이 있는 영상을 녹화하거나 여세요. 대본은 해당 자막에서 생성됩니다.",
	"transcribing": "자막 생성 중… 자막이 완료되면 대본이 준비됩니다.",
	"noSegments": "아직 대본이 없습니다. 자막에서 초기화하여 시작하세요.",
	"rowHint": "내레이션을 사용하면 생성된 내레이션이 여기에 표시됩니다",
	"trimmedTitle": "이 클립의 말은 잘린 구간에 있어 재생되지 않습니다"
}
```

`src/i18n/locales/zh-CN/voiceover.json`:
```json
{
	"navLabel": "配音",
	"title": "AI 配音",
	"description": "用根据字幕在本地生成的清晰语音替换原始旁白。",
	"enableLabel": "启用配音",
	"enableHint": "静音原始音频，改为播放生成的语音。",
	"voiceLabel": "声音",
	"speedLabel": "速度",
	"generateAll": "全部生成",
	"generating": "生成中… {{done}}/{{total}}",
	"regenerate": "重新生成",
	"play": "播放",
	"stop": "停止",
	"resetScript": "将脚本重置为字幕",
	"textPlaceholder": "分段脚本…",
	"status": {
		"idle": "未生成",
		"queued": "排队中",
		"synthesizing": "生成中…",
		"ready": "就绪",
		"error": "失败"
	},
	"noTranscript": "录制或打开带语音的视频——脚本会根据其字幕生成。",
	"transcribing": "正在生成字幕……字幕完成后脚本即可就绪。",
	"noSegments": "尚无脚本。从字幕重置以开始。",
	"rowHint": "启用配音后，生成的配音会显示在这里",
	"trimmedTitle": "该片段的文字位于已裁剪区域，将不会播放"
}
```

`src/i18n/locales/zh-TW/voiceover.json`:
```json
{
	"navLabel": "配音",
	"title": "AI 配音",
	"description": "以根據字幕在本機產生的清晰語音，取代原始旁白。",
	"enableLabel": "啟用配音",
	"enableHint": "靜音原始音訊，改為播放產生的語音。",
	"voiceLabel": "聲音",
	"speedLabel": "速度",
	"generateAll": "全部產生",
	"generating": "產生中… {{done}}/{{total}}",
	"regenerate": "重新產生",
	"play": "播放",
	"stop": "停止",
	"resetScript": "將腳本重設為字幕",
	"textPlaceholder": "分段腳本…",
	"status": {
		"idle": "尚未產生",
		"queued": "排隊中",
		"synthesizing": "產生中…",
		"ready": "就緒",
		"error": "失敗"
	},
	"noTranscript": "錄製或開啟含語音的影片——腳本會根據其字幕產生。",
	"transcribing": "正在產生字幕……字幕完成後腳本即可就緒。",
	"noSegments": "尚無腳本。從字幕重設以開始。",
	"rowHint": "啟用配音後，產生的配音會顯示在這裡",
	"trimmedTitle": "此片段的文字位於已裁剪區域，將不會播放"
}
```

`src/i18n/locales/ar/voiceover.json` (Arabic; keep `{{done}}/{{total}}` as-is):
```json
{
	"navLabel": "تعليق صوتي",
	"title": "تعليق صوتي بالذكاء الاصطناعي",
	"description": "استبدل التعليق الصوتي الأصلي بصوت نقي يُولَّد على الجهاز من النص المفرَّغ.",
	"enableLabel": "تفعيل التعليق الصوتي",
	"enableHint": "يكتم الصوت الأصلي ويشغّل الصوت المُولَّد بدلاً منه.",
	"voiceLabel": "الصوت",
	"speedLabel": "السرعة",
	"generateAll": "توليد الكل",
	"generating": "جارٍ التوليد… {{done}}/{{total}}",
	"regenerate": "إعادة التوليد",
	"play": "تشغيل",
	"stop": "إيقاف",
	"resetScript": "إعادة ضبط النص إلى التفريغ",
	"textPlaceholder": "نص المقطع…",
	"status": {
		"idle": "غير مُولَّد",
		"queued": "في الانتظار",
		"synthesizing": "جارٍ التوليد…",
		"ready": "جاهز",
		"error": "فشل"
	},
	"noTranscript": "سجّل أو افتح مقطعًا يحتوي على كلام — يُولَّد النص من التفريغ الخاص به.",
	"transcribing": "جارٍ التفريغ… سيصبح النص جاهزًا عند اكتمال التفريغ.",
	"noSegments": "لا يوجد نص بعد. أعد الضبط من التفريغ للبدء.",
	"rowHint": "فعّل التعليق الصوتي لرؤية التعليق المُولَّد هنا",
	"trimmedTitle": "كلمات هذا المقطع تقع في منطقة مقصوصة ولن تُشغَّل"
}
```

- [ ] **Step 4: Verify locale parity and typecheck**

Run:
```bash
npm run i18n:check && npx tsc --noEmit
```
Expected: `i18n:check` reports no missing keys against `en`; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/i18n/config.ts src/i18n/locales/*/voiceover.json
git commit -m "i18n(voiceover): add voiceover namespace across all locales"
```

---

### Task 2: `layoutVoiceover` — pure output-time alignment (built + tested here, consumed in Plan 4)

**Files:**
- Create: `src/lib/voiceover/layout.ts`
- Create: `src/lib/voiceover/layout.test.ts`

**Interfaces:**
- Consumes: `VoiceoverSegment` from `./types`; `TrimRegion`, `SpeedRegion` from `@/components/video-editor/types` (same import path the exporter uses in `src/lib/exporter/audioEncoder.ts`).
- Produces:
  - `isAnchorTrimmed(sourceMs: number, trims: TrimRegion[]): boolean`
  - `mapSourceToOutputMs(sourceMs: number, trims: TrimRegion[], speedRegions: SpeedRegion[]): number`
  - `interface PlacedClip { segmentId: string; audioKey: string; startMs: number; durationMs: number }`
  - `interface LayoutClipInput { audioKey: string; durationMs: number }`
  - `layoutVoiceover(input: { segments: VoiceoverSegment[]; clipsById: Record<string, LayoutClipInput>; trims: TrimRegion[]; speedRegions: SpeedRegion[]; gapMs?: number }): PlacedClip[]`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/voiceover/layout.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";
import type { VoiceoverSegment } from "./types";
import {
	isAnchorTrimmed,
	type LayoutClipInput,
	layoutVoiceover,
	mapSourceToOutputMs,
} from "./layout";

function seg(id: string, sourceStartMs: number): VoiceoverSegment {
	return { id, sourceStartMs, sourceEndMs: sourceStartMs + 500, text: id };
}

describe("isAnchorTrimmed", () => {
	const trims: TrimRegion[] = [{ id: "t1", startMs: 1000, endMs: 2000 }];
	it("is true when the anchor is inside a trim (start-inclusive, end-exclusive)", () => {
		expect(isAnchorTrimmed(1000, trims)).toBe(true);
		expect(isAnchorTrimmed(1500, trims)).toBe(true);
	});
	it("is false at the exclusive end and outside", () => {
		expect(isAnchorTrimmed(2000, trims)).toBe(false);
		expect(isAnchorTrimmed(500, trims)).toBe(false);
	});
});

describe("mapSourceToOutputMs", () => {
	it("subtracts fully-removed trims that end before the anchor", () => {
		const trims: TrimRegion[] = [{ id: "t1", startMs: 1000, endMs: 2000 }];
		expect(mapSourceToOutputMs(3000, trims, [])).toBe(2000); // 3000 - 1000 removed
	});
	it("compresses time saved by a speed-up region before the anchor", () => {
		// 1000ms region at 2x saves 500ms; anchor after it.
		const speed: SpeedRegion[] = [{ id: "s1", startMs: 1000, endMs: 2000, speed: 2 }];
		expect(mapSourceToOutputMs(3000, [], speed)).toBe(2500); // 3000 - 1000*(1-1/2)
	});
	it("compresses only the portion of a speed region before the anchor", () => {
		const speed: SpeedRegion[] = [{ id: "s1", startMs: 1000, endMs: 5000, speed: 2 }];
		// anchor at 3000 → 2000ms of the region elapsed → saves 1000ms
		expect(mapSourceToOutputMs(3000, [], speed)).toBe(2000);
	});
	it("never returns negative", () => {
		const trims: TrimRegion[] = [{ id: "t1", startMs: 0, endMs: 5000 }];
		expect(mapSourceToOutputMs(0, trims, [])).toBe(0);
	});
});

describe("layoutVoiceover", () => {
	const clips: Record<string, LayoutClipInput> = {
		a: { audioKey: "ka", durationMs: 1000 },
		b: { audioKey: "kb", durationMs: 1000 },
		c: { audioKey: "kc", durationMs: 1000 },
	};

	it("skips segments with no ready clip", () => {
		const out = layoutVoiceover({
			segments: [seg("a", 0), seg("missing", 5000)],
			clipsById: { a: clips.a },
			trims: [],
			speedRegions: [],
		});
		expect(out.map((p) => p.segmentId)).toEqual(["a"]);
	});

	it("drops clips whose anchor is inside a trim", () => {
		const out = layoutVoiceover({
			segments: [seg("a", 500), seg("b", 1500)],
			clipsById: clips,
			trims: [{ id: "t1", startMs: 1000, endMs: 2000 }],
			speedRegions: [],
		});
		expect(out.map((p) => p.segmentId)).toEqual(["a"]);
	});

	it("carries audioKey + durationMs and maps start through trims", () => {
		const out = layoutVoiceover({
			segments: [seg("a", 3000)],
			clipsById: clips,
			trims: [{ id: "t1", startMs: 1000, endMs: 2000 }],
			speedRegions: [],
		});
		expect(out[0]).toEqual({ segmentId: "a", audioKey: "ka", startMs: 2000, durationMs: 1000 });
	});

	it("nudges overlapping clips right by the gap, in output-time order", () => {
		// a at 0 (dur 1000), b at 500 (dur 1000). gap 40 → b pushed to 1040.
		const out = layoutVoiceover({
			segments: [seg("b", 500), seg("a", 0)],
			clipsById: clips,
			trims: [],
			speedRegions: [],
			gapMs: 40,
		});
		expect(out).toEqual([
			{ segmentId: "a", audioKey: "ka", startMs: 0, durationMs: 1000 },
			{ segmentId: "b", audioKey: "kb", startMs: 1040, durationMs: 1000 },
		]);
	});

	it("accumulates drift across a dense run", () => {
		const out = layoutVoiceover({
			segments: [seg("a", 0), seg("b", 100), seg("c", 200)],
			clipsById: clips,
			trims: [],
			speedRegions: [],
			gapMs: 40,
		});
		expect(out.map((p) => p.startMs)).toEqual([0, 1040, 2080]);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx vitest run src/lib/voiceover/layout.test.ts
```
Expected: FAIL — cannot resolve `./layout`.

- [ ] **Step 3: Implement `layout.ts`**

Create `src/lib/voiceover/layout.ts`:

```ts
import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";
import type { VoiceoverSegment } from "./types";

/** A synthesized clip placed on the OUTPUT (edited) timeline, for preview/export (Plan 4). */
export interface PlacedClip {
	segmentId: string;
	audioKey: string;
	startMs: number;
	durationMs: number;
}

/** The subset of a resolved clip that layout needs, keyed by segment id by the caller. */
export interface LayoutClipInput {
	audioKey: string;
	durationMs: number;
}

const DEFAULT_GAP_MS = 40;

/** True when a source-time anchor falls inside a removed (trimmed) region. Start-inclusive, end-exclusive. */
export function isAnchorTrimmed(sourceMs: number, trims: TrimRegion[]): boolean {
	return trims.some((tr) => sourceMs >= tr.startMs && sourceMs < tr.endMs);
}

/**
 * Map a source-time position to output (edited) time: subtract removed trim spans that end
 * before it (mirrors `computeTrimOffset` in audioEncoder.ts) and the time saved by sped-up
 * regions that lie before it. Clips play at natural length, so only the START is mapped.
 */
export function mapSourceToOutputMs(
	sourceMs: number,
	trims: TrimRegion[],
	speedRegions: SpeedRegion[],
): number {
	let out = sourceMs;
	for (const tr of trims) {
		if (tr.endMs <= sourceMs) {
			out -= tr.endMs - tr.startMs;
		} else if (tr.startMs < sourceMs) {
			// Anchor inside a trim: callers drop these, but stay safe by clamping to the trim start.
			out -= sourceMs - tr.startMs;
		}
	}
	for (const sp of speedRegions) {
		if (sp.speed <= 0) continue;
		const elapsedInRegion = Math.min(sourceMs, sp.endMs) - sp.startMs;
		if (elapsedInRegion <= 0) continue;
		out -= elapsedInRegion * (1 - 1 / sp.speed);
	}
	return Math.max(0, Math.round(out));
}

/**
 * Pure alignment used by preview + export so they can never disagree. For each ready segment:
 * skip if no clip; drop if its anchor is trimmed; else map the anchor to output time. Then
 * resolve overlaps by nudging each clip right to `prevEnd + gap` in output-time order.
 */
export function layoutVoiceover(input: {
	segments: VoiceoverSegment[];
	clipsById: Record<string, LayoutClipInput>;
	trims: TrimRegion[];
	speedRegions: SpeedRegion[];
	gapMs?: number;
}): PlacedClip[] {
	const gap = input.gapMs ?? DEFAULT_GAP_MS;
	const placed: PlacedClip[] = [];
	for (const seg of input.segments) {
		const clip = input.clipsById[seg.id];
		if (!clip) continue;
		if (isAnchorTrimmed(seg.sourceStartMs, input.trims)) continue;
		placed.push({
			segmentId: seg.id,
			audioKey: clip.audioKey,
			startMs: mapSourceToOutputMs(seg.sourceStartMs, input.trims, input.speedRegions),
			durationMs: clip.durationMs,
		});
	}
	placed.sort((a, b) => a.startMs - b.startMs);
	let prevEnd = Number.NEGATIVE_INFINITY;
	for (const p of placed) {
		if (p.startMs < prevEnd + gap) p.startMs = prevEnd + gap;
		prevEnd = p.startMs + p.durationMs;
	}
	return placed;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx vitest run src/lib/voiceover/layout.test.ts
```
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/voiceover/layout.ts src/lib/voiceover/layout.test.ts
git commit -m "feat(voiceover): add pure layoutVoiceover alignment (trims + speed + nudge)"
```

---

### Task 3: `useVoiceover` cleanups — in-flight guard + produce the `queued` state

Fold in Plan 2's carried-over items now that the UI can trigger `generateSegment`/`generateAll` on click: (a) an in-flight guard so a double-click can't fire two syntheses for the same segment; (b) `generateAll` marks not-yet-started segments `queued` (the state is defined but never produced today), giving the panel a real queued indicator.

**Files:**
- Modify: `src/hooks/useVoiceover.ts:75-109` (`generateSegment`, `generateAll`)
- Modify: `src/hooks/useVoiceover.test.ts` (add two cases)

**Interfaces:**
- Consumes: `statusesRef` (already maintained at `useVoiceover.ts:51-52`).
- Produces: no signature change. Behavior: `generateSegment(id)` returns early if that id's status is `synthesizing` or `queued`; `generateAll()` sets all pending segments to `{state:"queued"}` before processing.

- [ ] **Step 1: Write the failing tests**

Add to `src/hooks/useVoiceover.test.ts` (inside the existing top-level `describe`; keep the existing imports/harness — this repo renders the hook via `@testing-library/react`'s `renderHook`, and mocks `nativeBridgeClient` + the provider. Match the existing file's setup):

```ts
it("generateSegment ignores a re-entrant call while a segment is synthesizing", async () => {
	let resolveSynth: (v: { pcm: Float32Array; sampleRate: number }) => void = () => {};
	const synthesize = vi.fn(
		() =>
			new Promise<{ pcm: Float32Array; sampleRate: number }>((res) => {
				resolveSynth = res;
			}),
	);
	const provider = { id: "test", listVoices: async () => [], synthesize } as unknown as TtsProvider;
	const config: VoiceoverConfig = {
		...DEFAULT_VOICEOVER_CONFIG,
		enabled: true,
		segments: [{ id: "vo-1", sourceStartMs: 0, sourceEndMs: 500, text: "hi" }],
	};
	const { result } = renderHook(() =>
		useVoiceover({ config, transcript: null, onChange: () => {}, provider }),
	);

	await act(async () => {
		void result.current.generateSegment("vo-1"); // first call → synthesizing (pending)
		await Promise.resolve();
		void result.current.generateSegment("vo-1"); // re-entrant → must be ignored
		await Promise.resolve();
	});
	expect(synthesize).toHaveBeenCalledTimes(1);

	await act(async () => {
		resolveSynth({ pcm: new Float32Array([0.1, 0.2]), sampleRate: 24000 });
		await Promise.resolve();
	});
});

it("generateAll marks a not-yet-started segment queued while the first synthesizes", async () => {
	const deferreds: Array<(v: { pcm: Float32Array; sampleRate: number }) => void> = [];
	const synthesize = vi.fn(
		() =>
			new Promise<{ pcm: Float32Array; sampleRate: number }>((res) => {
				deferreds.push(res);
			}),
	);
	const provider = { id: "test", listVoices: async () => [], synthesize } as unknown as TtsProvider;
	const config: VoiceoverConfig = {
		...DEFAULT_VOICEOVER_CONFIG,
		enabled: true,
		segments: [
			{ id: "vo-1", sourceStartMs: 0, sourceEndMs: 500, text: "a" },
			{ id: "vo-2", sourceStartMs: 500, sourceEndMs: 900, text: "b" },
		],
	};
	const { result } = renderHook(() =>
		useVoiceover({ config, transcript: null, onChange: () => {}, provider }),
	);

	await act(async () => {
		void result.current.generateAll();
		await Promise.resolve();
	});
	// First segment is synthesizing; the second must be QUEUED (not yet started) — this is the
	// behavior generateAll newly produces.
	expect(result.current.statuses["vo-1"].state).toBe("synthesizing");
	expect(result.current.statuses["vo-2"].state).toBe("queued");

	await act(async () => {
		deferreds[0]({ pcm: new Float32Array([0.1]), sampleRate: 24000 });
		await Promise.resolve();
		await Promise.resolve();
		deferreds[1]?.({ pcm: new Float32Array([0.2]), sampleRate: 24000 });
		await Promise.resolve();
	});
	expect(synthesize).toHaveBeenCalledTimes(2);
	expect(result.current.statuses["vo-1"].state).toBe("ready");
	expect(result.current.statuses["vo-2"].state).toBe("ready");
});
```

> The microtask flushing (`await Promise.resolve()`) may need light tuning so the assertions observe the intended intermediate states under React 18 `act` — adjust the number of flushes if needed, but keep the two intermediate assertions (`vo-1` synthesizing, `vo-2` queued): verifying the `queued` state is the point of this test.

> If the existing test file does not already import `act`, `renderHook`, `DEFAULT_VOICEOVER_CONFIG`, `TtsProvider`, or `VoiceoverConfig`, add those imports (`act`/`renderHook` from `@testing-library/react`, the rest from their Plan-2 modules) to match the file's current style.

- [ ] **Step 2: Run to verify the guard test fails**

Run:
```bash
npx vitest run src/hooks/useVoiceover.test.ts -t "re-entrant"
```
Expected: FAIL — `synthesize` called 2 times (no guard yet).

- [ ] **Step 3: Add the in-flight guard to `generateSegment`**

In `src/hooks/useVoiceover.ts`, at the start of `generateSegment` (after the `segment` lookup at line 76-77), add the guard:

```ts
	const generateSegment = useCallback(async (id: string) => {
		const segment = configRef.current.segments.find((s) => s.id === id);
		if (!segment) return;
		const inFlight = statusesRef.current[id]?.state;
		if (inFlight === "synthesizing") return;
		const key = computeAudioKey({
			text: segment.text,
			voice: configRef.current.voice,
			speed: configRef.current.speed,
		});
		setStatuses((prev) => ({ ...prev, [id]: { state: "synthesizing" } }));
		// ...unchanged body...
```

- [ ] **Step 4: Produce `queued` in `generateAll`**

Replace `generateAll` (lines 104-109) with a version that marks pending segments `queued` up front:

```ts
	const generateAll = useCallback(async () => {
		const pending = configRef.current.segments.filter(
			(s) => statusesRef.current[s.id]?.state !== "ready",
		);
		if (pending.length > 0) {
			setStatuses((prev) => {
				const next = { ...prev };
				for (const s of pending) next[s.id] = { state: "queued" };
				return next;
			});
		}
		for (const segment of pending) {
			if (statusesRef.current[segment.id]?.state === "ready") continue;
			await generateSegment(segment.id);
		}
	}, [generateSegment]);
```

> Note: the guard in Step 3 only early-returns on `"synthesizing"`, not `"queued"` — `generateAll` sets `queued` then immediately calls `generateSegment`, which must be allowed to transition `queued → synthesizing`.

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
npx vitest run src/hooks/useVoiceover.test.ts
```
Expected: PASS (existing + two new cases).

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useVoiceover.ts src/hooks/useVoiceover.test.ts
git commit -m "fix(voiceover): guard re-entrant generateSegment; produce queued in generateAll"
```

---

### Task 4: `useClipAudition` — standalone single-clip playback

The panel's ▶︎ plays one generated clip through a throwaway `AudioContext`. This is the ONLY audio in Plan 3 (timeline-synced preview is Plan 4). Isolated so it can be unit-tested with a mocked `AudioContext`.

**Files:**
- Create: `src/hooks/useClipAudition.ts`
- Create: `src/hooks/useClipAudition.test.ts`

**Interfaces:**
- Consumes: `ResolvedClip`-shaped `{ pcm: Float32Array; sampleRate: number }`.
- Produces:
  - `interface UseClipAuditionResult { auditioningKey: string | null; play(clip: { pcm: Float32Array; sampleRate: number }, key: string): void; stop(): void }`
  - `function useClipAudition(): UseClipAuditionResult`

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useClipAudition.test.ts`:

```ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClipAudition } from "./useClipAudition";

class FakeBufferSource {
	buffer: unknown = null;
	onended: (() => void) | null = null;
	connect = vi.fn();
	start = vi.fn();
	stop = vi.fn(() => {
		this.onended?.();
	});
}

class FakeAudioContext {
	static instances: FakeAudioContext[] = [];
	destination = {};
	closed = false;
	created: FakeBufferSource[] = [];
	constructor() {
		FakeAudioContext.instances.push(this);
	}
	createBuffer(_channels: number, length: number, sampleRate: number) {
		return { length, sampleRate, getChannelData: () => new Float32Array(length) };
	}
	createBufferSource() {
		const s = new FakeBufferSource();
		this.created.push(s);
		return s as unknown as AudioBufferSourceNode;
	}
	close = vi.fn(async () => {
		this.closed = true;
	});
}

beforeEach(() => {
	FakeAudioContext.instances = [];
	vi.stubGlobal("AudioContext", FakeAudioContext as unknown as typeof AudioContext);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useClipAudition", () => {
	it("plays a clip and exposes its key while playing", () => {
		const { result } = renderHook(() => useClipAudition());
		expect(result.current.auditioningKey).toBeNull();
		act(() => {
			result.current.play({ pcm: new Float32Array([0.1, 0.2, 0.3]), sampleRate: 24000 }, "k1");
		});
		expect(result.current.auditioningKey).toBe("k1");
		const ctx = FakeAudioContext.instances[0];
		expect(ctx.created[0].start).toHaveBeenCalled();
	});

	it("stop() halts playback and clears the key", () => {
		const { result } = renderHook(() => useClipAudition());
		act(() => {
			result.current.play({ pcm: new Float32Array([0.1]), sampleRate: 24000 }, "k1");
		});
		act(() => {
			result.current.stop();
		});
		expect(result.current.auditioningKey).toBeNull();
	});

	it("playing a second clip replaces the first", () => {
		const { result } = renderHook(() => useClipAudition());
		act(() => {
			result.current.play({ pcm: new Float32Array([0.1]), sampleRate: 24000 }, "k1");
		});
		act(() => {
			result.current.play({ pcm: new Float32Array([0.2]), sampleRate: 24000 }, "k2");
		});
		expect(result.current.auditioningKey).toBe("k2");
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
npx vitest run src/hooks/useClipAudition.test.ts
```
Expected: FAIL — cannot resolve `./useClipAudition`.

- [ ] **Step 3: Implement the hook**

Create `src/hooks/useClipAudition.ts`:

```ts
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

	const play = useCallback(
		(clip: { pcm: Float32Array; sampleRate: number }, key: string) => {
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
		},
		[],
	);

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx vitest run src/hooks/useClipAudition.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useClipAudition.ts src/hooks/useClipAudition.test.ts
git commit -m "feat(voiceover): add useClipAudition for standalone clip playback"
```

---

### Task 5: `VoiceoverSegmentRow` — one editable script row

**Files:**
- Create: `src/components/video-editor/VoiceoverSegmentRow.tsx`
- Create: `src/components/video-editor/VoiceoverSegmentRow.test.tsx`

**Interfaces:**
- Consumes: `VoiceoverSegment`, `SegmentSynthStatus` from `@/lib/voiceover/types`; `useScopedT("voiceover")` (Task 1).
- Produces:
  - `interface VoiceoverSegmentRowProps { segment; status; isSelected; isAuditioning; canGenerate; onTextChange(text); onTextCommit(); onGenerate(); onAudition(); onStopAudition(); onSelect() }`
  - `function VoiceoverSegmentRow(props): JSX.Element`

- [ ] **Step 1: Write the failing test**

Create `src/components/video-editor/VoiceoverSegmentRow.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { SegmentSynthStatus, VoiceoverSegment } from "@/lib/voiceover/types";
import { VoiceoverSegmentRow } from "./VoiceoverSegmentRow";

const segment: VoiceoverSegment = { id: "vo-1", sourceStartMs: 2000, sourceEndMs: 3000, text: "hello" };

function renderRow(overrides: Partial<React.ComponentProps<typeof VoiceoverSegmentRow>> = {}) {
	const props = {
		segment,
		status: { state: "idle" } as SegmentSynthStatus,
		isSelected: false,
		isAuditioning: false,
		canGenerate: true,
		onTextChange: vi.fn(),
		onTextCommit: vi.fn(),
		onGenerate: vi.fn(),
		onAudition: vi.fn(),
		onStopAudition: vi.fn(),
		onSelect: vi.fn(),
		...overrides,
	};
	render(
		<I18nProvider>
			<VoiceoverSegmentRow {...props} />
		</I18nProvider>,
	);
	return props;
}

describe("VoiceoverSegmentRow", () => {
	it("renders the editable text and fires change + commit", () => {
		const props = renderRow();
		const field = screen.getByDisplayValue("hello");
		fireEvent.change(field, { target: { value: "hi there" } });
		expect(props.onTextChange).toHaveBeenCalledWith("hi there");
		fireEvent.blur(field);
		expect(props.onTextCommit).toHaveBeenCalled();
	});

	it("shows a Generate action when idle and calls onGenerate", () => {
		const props = renderRow({ status: { state: "idle" } });
		fireEvent.click(screen.getByRole("button", { name: /generate|regenerate/i }));
		expect(props.onGenerate).toHaveBeenCalled();
	});

	it("shows an audition button only when the clip is ready", () => {
		const { rerender } = render(
			<I18nProvider>
				<VoiceoverSegmentRow
					segment={segment}
					status={{ state: "idle" }}
					isSelected={false}
					isAuditioning={false}
					canGenerate
					onTextChange={vi.fn()}
					onTextCommit={vi.fn()}
					onGenerate={vi.fn()}
					onAudition={vi.fn()}
					onStopAudition={vi.fn()}
					onSelect={vi.fn()}
				/>
			</I18nProvider>,
		);
		expect(screen.queryByRole("button", { name: /play/i })).toBeNull();
		rerender(
			<I18nProvider>
				<VoiceoverSegmentRow
					segment={segment}
					status={{ state: "ready", audioKey: "k1", durationMs: 900 }}
					isSelected={false}
					isAuditioning={false}
					canGenerate
					onTextChange={vi.fn()}
					onTextCommit={vi.fn()}
					onGenerate={vi.fn()}
					onAudition={vi.fn()}
					onStopAudition={vi.fn()}
					onSelect={vi.fn()}
				/>
			</I18nProvider>,
		);
		expect(screen.getByRole("button", { name: /play/i })).toBeInTheDocument();
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
npx vitest run src/components/video-editor/VoiceoverSegmentRow.test.tsx
```
Expected: FAIL — cannot resolve `./VoiceoverSegmentRow`.

- [ ] **Step 3: Implement the row**

Create `src/components/video-editor/VoiceoverSegmentRow.tsx`:

```tsx
import { Loader2, Play, RefreshCw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useScopedT } from "@/contexts/I18nContext";
import { cn } from "@/lib/utils";
import type { SegmentSynthStatus, VoiceoverSegment } from "@/lib/voiceover/types";

export interface VoiceoverSegmentRowProps {
	segment: VoiceoverSegment;
	status: SegmentSynthStatus;
	isSelected: boolean;
	isAuditioning: boolean;
	canGenerate: boolean;
	onTextChange: (text: string) => void;
	onTextCommit: () => void;
	onGenerate: () => void;
	onAudition: () => void;
	onStopAudition: () => void;
	onSelect: () => void;
}

function formatAnchor(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function VoiceoverSegmentRow({
	segment,
	status,
	isSelected,
	isAuditioning,
	canGenerate,
	onTextChange,
	onTextCommit,
	onGenerate,
	onAudition,
	onStopAudition,
	onSelect,
}: VoiceoverSegmentRowProps) {
	const t = useScopedT("voiceover");
	const isReady = status.state === "ready";
	const isBusy = status.state === "synthesizing" || status.state === "queued";
	const statusLabel = t(`status.${status.state}`);

	return (
		<div
			onPointerDownCapture={onSelect}
			className={cn(
				"rounded-lg border p-2 transition-colors",
				isSelected
					? "border-[#34B27B]/50 bg-[#34B27B]/[0.06]"
					: "border-white/[0.06] bg-white/[0.02] hover:border-white/10",
			)}
		>
			<div className="mb-1.5 flex items-center justify-between gap-2">
				<span className="text-[10px] font-semibold tabular-nums text-slate-500">
					{t("segment.anchorAt", { time: formatAnchor(segment.sourceStartMs) })}
				</span>
				<span
					className={cn(
						"rounded-full px-2 py-0.5 text-[10px] font-semibold",
						status.state === "error"
							? "bg-red-500/15 text-red-300"
							: isReady
								? "bg-[#34B27B]/15 text-[#34B27B]"
								: "bg-white/5 text-slate-400",
					)}
				>
					{statusLabel}
				</span>
			</div>

			<textarea
				value={segment.text}
				placeholder={t("textPlaceholder")}
				onChange={(e) => onTextChange(e.target.value)}
				onBlur={onTextCommit}
				rows={2}
				className="w-full resize-none rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-[#34B27B]/50"
			/>

			<div className="mt-1.5 flex items-center gap-1.5">
				<Button
					type="button"
					size="sm"
					variant="secondary"
					disabled={!canGenerate || isBusy}
					onClick={onGenerate}
					className="h-7 gap-1 px-2 text-[11px]"
				>
					{isBusy ? (
						<Loader2 className="h-3 w-3 animate-spin" />
					) : (
						<RefreshCw className="h-3 w-3" />
					)}
					{t("regenerate")}
				</Button>
				{isReady &&
					(isAuditioning ? (
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={onStopAudition}
							className="h-7 gap-1 px-2 text-[11px]"
						>
							<Square className="h-3 w-3" />
							{t("stop")}
						</Button>
					) : (
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={onAudition}
							className="h-7 gap-1 px-2 text-[11px]"
						>
							<Play className="h-3 w-3" />
							{t("play")}
						</Button>
					))}
			</div>
		</div>
	);
}
```

> If `Button` doesn't support `size="sm"`/`variant="secondary"|"ghost"` exactly, check `src/components/ui/button.tsx` for the available `cva` variants and use the nearest existing ones — do not invent new variants.

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx vitest run src/components/video-editor/VoiceoverSegmentRow.test.tsx
```
Expected: PASS. If `I18nProvider` is not the correct provider export, check `src/contexts/I18nContext.tsx` for the actual provider name and use it (the test must wrap the component so `useScopedT` resolves).

- [ ] **Step 5: Commit**

```bash
git add src/components/video-editor/VoiceoverSegmentRow.tsx src/components/video-editor/VoiceoverSegmentRow.test.tsx
git commit -m "feat(voiceover): add VoiceoverSegmentRow (editable script row + status + audition)"
```

---

### Task 6: `VoiceoverPanel` — the panel body

Composes the enable toggle, voice picker, speed slider, "Generate all" + progress, "Reset script to transcript", transcript-readiness states, and the list of `VoiceoverSegmentRow`s. Wires audition via `useClipAudition`. Defines the `VoiceoverPanelProps` contract consumed by `SettingsPanel` (Task 8) and `VideoEditor` (Task 9).

**Files:**
- Create: `src/components/video-editor/VoiceoverPanel.tsx`
- Create: `src/components/video-editor/VoiceoverPanel.test.tsx`

**Interfaces:**
- Consumes: `VoiceoverSegmentRow` (Task 5); `useClipAudition` (Task 4); `KOKORO_VOICES` from `@/lib/tts/voices`; `ResolvedClip` from `@/hooks/useVoiceover`; types from `@/lib/voiceover/types`; shadcn `Switch`, `Slider`, `Select*`, `Button`; `useScopedT("voiceover")`.
- Produces:
  - `interface VoiceoverPanelProps { config: VoiceoverConfig; statuses: Record<string, SegmentSynthStatus>; clips: Record<string, ResolvedClip>; audioKeyFor(segment: VoiceoverSegment): string; transcriptReady: boolean; hasTranscript: boolean; selectedSegmentId: string | null; onToggleEnabled(enabled: boolean): void; onVoiceChange(voice: string): void; onSpeedChange(speed: number): void; onSpeedCommit(): void; onSegmentTextChange(id: string, text: string): void; onSegmentTextCommit(): void; onGenerateSegment(id: string): void; onGenerateAll(): void; onResetScript(): void; onSelectSegment(id: string): void }`
  - `function VoiceoverPanel(props: VoiceoverPanelProps): JSX.Element`

- [ ] **Step 1: Write the failing test**

Create `src/components/video-editor/VoiceoverPanel.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { DEFAULT_VOICEOVER_CONFIG, type VoiceoverConfig } from "@/lib/voiceover/types";
import { VoiceoverPanel, type VoiceoverPanelProps } from "./VoiceoverPanel";

function baseProps(overrides: Partial<VoiceoverPanelProps> = {}): VoiceoverPanelProps {
	const config: VoiceoverConfig = {
		...DEFAULT_VOICEOVER_CONFIG,
		enabled: true,
		segments: [{ id: "vo-1", sourceStartMs: 0, sourceEndMs: 500, text: "hello" }],
	};
	return {
		config,
		statuses: { "vo-1": { state: "idle" } },
		clips: {},
		audioKeyFor: () => "k1",
		transcriptReady: true,
		hasTranscript: true,
		selectedSegmentId: null,
		onToggleEnabled: vi.fn(),
		onVoiceChange: vi.fn(),
		onSpeedChange: vi.fn(),
		onSpeedCommit: vi.fn(),
		onSegmentTextChange: vi.fn(),
		onSegmentTextCommit: vi.fn(),
		onGenerateSegment: vi.fn(),
		onGenerateAll: vi.fn(),
		onResetScript: vi.fn(),
		onSelectSegment: vi.fn(),
		...overrides,
	};
}

function renderPanel(props: VoiceoverPanelProps) {
	render(
		<I18nProvider>
			<VoiceoverPanel {...props} />
		</I18nProvider>,
	);
}

describe("VoiceoverPanel", () => {
	it("renders one row per segment and fires Generate all", () => {
		const props = baseProps();
		renderPanel(props);
		expect(screen.getByDisplayValue("hello")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /generate all/i }));
		expect(props.onGenerateAll).toHaveBeenCalled();
	});

	it("shows a transcribing hint and hides the script when transcript is not ready", () => {
		const props = baseProps({
			transcriptReady: false,
			hasTranscript: false,
			config: { ...DEFAULT_VOICEOVER_CONFIG, enabled: true, segments: [] },
			statuses: {},
		});
		renderPanel(props);
		expect(screen.getByText(/record or open a video|transcrib/i)).toBeInTheDocument();
	});

	it("routes per-segment text edits through onSegmentTextChange", () => {
		const props = baseProps();
		renderPanel(props);
		fireEvent.change(screen.getByDisplayValue("hello"), { target: { value: "hi" } });
		expect(props.onSegmentTextChange).toHaveBeenCalledWith("vo-1", "hi");
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
npx vitest run src/components/video-editor/VoiceoverPanel.test.tsx
```
Expected: FAIL — cannot resolve `./VoiceoverPanel`.

- [ ] **Step 3: Implement the panel**

Create `src/components/video-editor/VoiceoverPanel.tsx`:

```tsx
import { Loader2, RotateCcw, Sparkles } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useScopedT } from "@/contexts/I18nContext";
import { useClipAudition } from "@/hooks/useClipAudition";
import type { ResolvedClip } from "@/hooks/useVoiceover";
import { KOKORO_VOICES } from "@/lib/tts/voices";
import type {
	SegmentSynthStatus,
	VoiceoverConfig,
	VoiceoverSegment,
} from "@/lib/voiceover/types";
import { cn } from "@/lib/utils";
import { VoiceoverSegmentRow } from "./VoiceoverSegmentRow";

const SPEED_MIN = 0.7;
const SPEED_MAX = 1.2;
const SPEED_STEP = 0.05;

export interface VoiceoverPanelProps {
	config: VoiceoverConfig;
	statuses: Record<string, SegmentSynthStatus>;
	clips: Record<string, ResolvedClip>;
	audioKeyFor: (segment: VoiceoverSegment) => string;
	transcriptReady: boolean;
	hasTranscript: boolean;
	selectedSegmentId: string | null;
	onToggleEnabled: (enabled: boolean) => void;
	onVoiceChange: (voice: string) => void;
	onSpeedChange: (speed: number) => void;
	onSpeedCommit: () => void;
	onSegmentTextChange: (id: string, text: string) => void;
	onSegmentTextCommit: () => void;
	onGenerateSegment: (id: string) => void;
	onGenerateAll: () => void;
	onResetScript: () => void;
	onSelectSegment: (id: string) => void;
}

export function VoiceoverPanel({
	config,
	statuses,
	clips,
	audioKeyFor,
	transcriptReady,
	hasTranscript,
	selectedSegmentId,
	onToggleEnabled,
	onVoiceChange,
	onSpeedChange,
	onSpeedCommit,
	onSegmentTextChange,
	onSegmentTextCommit,
	onGenerateSegment,
	onGenerateAll,
	onResetScript,
	onSelectSegment,
}: VoiceoverPanelProps) {
	const t = useScopedT("voiceover");
	const audition = useClipAudition();
	const { segments } = config;

	const readyCount = useMemo(
		() => segments.filter((s) => statuses[s.id]?.state === "ready").length,
		[segments, statuses],
	);
	const isGenerating = segments.some((s) => {
		const st = statuses[s.id]?.state;
		return st === "synthesizing" || st === "queued";
	});

	return (
		<div className="flex min-w-0 flex-col gap-3 px-1">
			<p className="text-[11px] leading-relaxed text-slate-500">{t("description")}</p>

			{/* Enable toggle */}
			<div className="flex items-start justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
				<div className="min-w-0">
					<div className="text-xs font-semibold text-slate-100">{t("enableLabel")}</div>
					<div className="mt-0.5 text-[10px] leading-snug text-slate-500">{t("enableHint")}</div>
				</div>
				<Switch checked={config.enabled} onCheckedChange={onToggleEnabled} />
			</div>

			{/* Voice + speed */}
			<div className="space-y-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
				<div>
					<div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
						{t("voiceLabel")}
					</div>
					<Select value={config.voice} onValueChange={onVoiceChange}>
						<SelectTrigger className="h-8 border-white/10 bg-black/20 text-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{KOKORO_VOICES.map((v) => (
								<SelectItem key={v.id} value={v.id} className="text-xs">
									{v.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div>
					<div className="mb-1 flex items-center justify-between">
						<span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
							{t("speedLabel")}
						</span>
						<span className="text-[11px] tabular-nums text-slate-300">
							{config.speed.toFixed(2)}×
						</span>
					</div>
					<Slider
						value={[config.speed]}
						min={SPEED_MIN}
						max={SPEED_MAX}
						step={SPEED_STEP}
						onValueChange={(values) => onSpeedChange(values[0])}
						onValueCommit={onSpeedCommit}
					/>
				</div>
			</div>

			{/* Generate all + reset */}
			<div className="flex items-center gap-1.5">
				<Button
					type="button"
					size="sm"
					disabled={!transcriptReady || segments.length === 0 || isGenerating}
					onClick={onGenerateAll}
					className="h-8 flex-1 gap-1.5 text-xs"
				>
					{isGenerating ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
					) : (
						<Sparkles className="h-3.5 w-3.5" />
					)}
					{isGenerating
						? t("generating", { done: readyCount, total: segments.length })
						: t("generateAll")}
				</Button>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					disabled={!transcriptReady || !hasTranscript}
					onClick={onResetScript}
					title={t("resetScript")}
					className="h-8 gap-1 px-2 text-xs"
				>
					<RotateCcw className="h-3.5 w-3.5" />
				</Button>
			</div>

			{/* Body */}
			{!hasTranscript ? (
				<EmptyHint text={t("noTranscript")} />
			) : !transcriptReady ? (
				<EmptyHint text={t("transcribing")} />
			) : segments.length === 0 ? (
				<EmptyHint text={t("noSegments")} />
			) : (
				<div className="flex flex-col gap-2">
					{segments.map((segment) => {
						const status = statuses[segment.id] ?? { state: "idle" };
						const key = status.state === "ready" ? status.audioKey : audioKeyFor(segment);
						const clip = clips[key];
						return (
							<VoiceoverSegmentRow
								key={segment.id}
								segment={segment}
								status={status}
								isSelected={selectedSegmentId === segment.id}
								isAuditioning={audition.auditioningKey === key}
								canGenerate={transcriptReady}
								onTextChange={(text) => onSegmentTextChange(segment.id, text)}
								onTextCommit={onSegmentTextCommit}
								onGenerate={() => onGenerateSegment(segment.id)}
								onAudition={() => clip && audition.play(clip, key)}
								onStopAudition={audition.stop}
								onSelect={() => onSelectSegment(segment.id)}
							/>
						);
					})}
				</div>
			)}
		</div>
	);
}

function EmptyHint({ text }: { text: string }) {
	return (
		<div className={cn("rounded-lg border border-dashed border-white/[0.08] p-4")}>
			<p className="text-center text-[11px] leading-relaxed text-slate-500">{text}</p>
		</div>
	);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx vitest run src/components/video-editor/VoiceoverPanel.test.tsx
```
Expected: PASS. (If `Switch`/`Slider`/`Select` render differently under jsdom, adjust selectors — do not change the component's public props.)

- [ ] **Step 5: Commit**

```bash
git add src/components/video-editor/VoiceoverPanel.tsx src/components/video-editor/VoiceoverPanel.test.tsx
git commit -m "feat(voiceover): add VoiceoverPanel (enable/voice/speed/generate/segment list)"
```

---

### Task 7: Voiceover timeline row (`VoiceoverRow` + wire into `TimelineEditor`)

A read-only lane rendering each **ready** clip at its **source** anchor (the timeline axis is source time), dimming clips whose anchor is trimmed. Clicking a pill selects that segment. Reuses the shared `Row` for visual consistency and `isAnchorTrimmed` from Task 2.

**Files:**
- Create: `src/components/video-editor/timeline/VoiceoverRow.tsx`
- Create: `src/components/video-editor/timeline/VoiceoverRow.test.tsx`
- Modify: `src/components/video-editor/timeline/TimelineEditor.tsx` (add row constant, props, render, pass-through)

**Interfaces:**
- Consumes: `Row` (`./Row`); `useTimelineContext` (`dnd-timeline`); `isAnchorTrimmed` (`@/lib/voiceover/layout`); `VoiceoverSegment`, `SegmentSynthStatus` (`@/lib/voiceover/types`); `TrimRegion` (`../types`).
- Produces:
  - `interface VoiceoverRowProps { segments; statuses; trimRegions; selectedSegmentId; onSelectSegment(id); hint; trimmedTitle }`
  - `function VoiceoverRow(props): JSX.Element`
  - New `TimelineEditorProps` fields: `voiceoverSegments?: VoiceoverSegment[]`, `voiceoverStatuses?: Record<string, SegmentSynthStatus>`, `voiceoverEnabled?: boolean`, `trimRegions` (already present), `selectedVoiceoverSegmentId?: string | null`, `onSelectVoiceoverSegment?: (id: string) => void`.

- [ ] **Step 1: Write the failing test**

Create `src/components/video-editor/timeline/VoiceoverRow.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("dnd-timeline", () => ({
	useRow: () => ({ setNodeRef: () => {}, rowWrapperStyle: {}, rowStyle: { position: "relative" } }),
	useTimelineContext: () => ({
		range: { start: 0, end: 10000 },
		valueToPixels: (ms: number) => ms / 10,
	}),
}));

import type { SegmentSynthStatus, VoiceoverSegment } from "@/lib/voiceover/types";
import { VoiceoverRow } from "./VoiceoverRow";

const segments: VoiceoverSegment[] = [
	{ id: "vo-1", sourceStartMs: 2000, sourceEndMs: 3000, text: "a" },
	{ id: "vo-2", sourceStartMs: 5000, sourceEndMs: 6000, text: "b" },
];
const statuses: Record<string, SegmentSynthStatus> = {
	"vo-1": { state: "ready", audioKey: "k1", durationMs: 1000 },
	"vo-2": { state: "ready", audioKey: "k2", durationMs: 1000 },
};

describe("VoiceoverRow", () => {
	it("renders one pill per ready segment, positioned by source anchor", () => {
		render(
			<VoiceoverRow
				segments={segments}
				statuses={statuses}
				trimRegions={[]}
				selectedSegmentId={null}
				onSelectSegment={vi.fn()}
				hint="hint"
				trimmedTitle="trimmed"
			/>,
		);
		const pills = screen.getAllByTestId("voiceover-clip");
		expect(pills).toHaveLength(2);
		// valueToPixels(2000) = 200
		expect(pills[0].style.left).toBe("200px");
		expect(pills[0].style.width).toBe("100px");
	});

	it("does not render pills for non-ready segments", () => {
		render(
			<VoiceoverRow
				segments={segments}
				statuses={{ "vo-1": { state: "idle" }, "vo-2": statuses["vo-2"] }}
				trimRegions={[]}
				selectedSegmentId={null}
				onSelectSegment={vi.fn()}
				hint="hint"
				trimmedTitle="trimmed"
			/>,
		);
		expect(screen.getAllByTestId("voiceover-clip")).toHaveLength(1);
	});

	it("marks a trimmed clip and still renders it, and selecting a pill fires the callback", () => {
		const onSelect = vi.fn();
		render(
			<VoiceoverRow
				segments={segments}
				statuses={statuses}
				trimRegions={[{ id: "t1", startMs: 4500, endMs: 6000 }]}
				selectedSegmentId={null}
				onSelectSegment={onSelect}
				hint="hint"
				trimmedTitle="trimmed"
			/>,
		);
		const pills = screen.getAllByTestId("voiceover-clip");
		expect(pills).toHaveLength(2);
		expect(pills[1].getAttribute("title")).toBe("trimmed");
		fireEvent.click(pills[0]);
		expect(onSelect).toHaveBeenCalledWith("vo-1");
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
npx vitest run src/components/video-editor/timeline/VoiceoverRow.test.tsx
```
Expected: FAIL — cannot resolve `./VoiceoverRow`.

- [ ] **Step 3: Implement `VoiceoverRow`**

Create `src/components/video-editor/timeline/VoiceoverRow.tsx`:

```tsx
import { useTimelineContext } from "dnd-timeline";
import { useScopedT } from "@/contexts/I18nContext";
import { isAnchorTrimmed } from "@/lib/voiceover/layout";
import type { SegmentSynthStatus, VoiceoverSegment } from "@/lib/voiceover/types";
import { cn } from "@/lib/utils";
import type { TrimRegion } from "../types";
import Row from "./Row";

export const VOICEOVER_ROW_ID = "row-voiceover";
const MIN_PILL_PX = 6;

export interface VoiceoverRowProps {
	segments: VoiceoverSegment[];
	statuses: Record<string, SegmentSynthStatus>;
	trimRegions: TrimRegion[];
	selectedSegmentId: string | null;
	onSelectSegment: (id: string) => void;
	hint: string;
	trimmedTitle: string;
}

/**
 * Read-only timeline lane for generated voiceover clips. The timeline axis is SOURCE time, so
 * clips are drawn at their source anchor with natural width; clips whose anchor falls in a trim
 * are dimmed (their words are cut). Output-time playback layout lives in layoutVoiceover (Plan 4).
 */
export function VoiceoverRow({
	segments,
	statuses,
	trimRegions,
	selectedSegmentId,
	onSelectSegment,
	hint,
	trimmedTitle,
}: VoiceoverRowProps) {
	const t = useScopedT("timeline");
	const { range, valueToPixels } = useTimelineContext();

	const pills = segments.flatMap((segment) => {
		const status = statuses[segment.id];
		if (!status || status.state !== "ready") return [];
		const left = valueToPixels(segment.sourceStartMs - range.start);
		const width = Math.max(MIN_PILL_PX, valueToPixels(status.durationMs));
		const trimmed = isAnchorTrimmed(segment.sourceStartMs, trimRegions);
		return [{ segment, left, width, trimmed }];
	});

	return (
		<Row id={VOICEOVER_ROW_ID} isEmpty={pills.length === 0} hint={hint}>
			{pills.map(({ segment, left, width, trimmed }) => (
				<button
					key={segment.id}
					type="button"
					data-testid="voiceover-clip"
					title={trimmed ? trimmedTitle : undefined}
					onClick={(event) => {
						event.stopPropagation();
						onSelectSegment(segment.id);
					}}
					style={{ position: "absolute", left, width, top: 3, height: 30 }}
					className={cn(
						"z-10 flex items-center overflow-hidden rounded-md border px-2 text-[10px] font-medium text-white/90 transition-opacity",
						"border-[#34B27B]/40 bg-[#34B27B]/20",
						trimmed && "opacity-40 grayscale",
						selectedSegmentId === segment.id && "ring-1 ring-[#34B27B]",
					)}
				>
					<span className="truncate">{segment.text || t("labels.trim")}</span>
				</button>
			))}
		</Row>
	);
}
```

> The `t("labels.trim")` fallback is only a non-empty placeholder for an empty-text clip; replace with any existing timeline label if preferred. The pill text is not critical.

- [ ] **Step 4: Run the VoiceoverRow test to verify it passes**

Run:
```bash
npx vitest run src/components/video-editor/timeline/VoiceoverRow.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Wire `VoiceoverRow` into `TimelineEditor`**

In `src/components/video-editor/timeline/TimelineEditor.tsx`:

(a) Add the import near the other timeline imports (after `import Row from "./Row";`):
```ts
import { VoiceoverRow } from "./VoiceoverRow";
```
(b) Add these fields to the `TimelineEditorProps` interface (near the trim/speed props, ~line 66-88):
```ts
	voiceoverEnabled?: boolean;
	voiceoverSegments?: VoiceoverSegment[];
	voiceoverStatuses?: Record<string, SegmentSynthStatus>;
	selectedVoiceoverSegmentId?: string | null;
	onSelectVoiceoverSegment?: (id: string) => void;
```
and import their types at the top:
```ts
import type { SegmentSynthStatus, VoiceoverSegment } from "@/lib/voiceover/types";
```
(c) Destructure them where the other props are destructured (the inner timeline component around line 560-585 and its prop-type block — match how `trimRegions`/`onSelectTrim` are threaded; there are two layers: the outer `TimelineEditor` and an inner content component. Pass the new props straight through the same way `speedRegions`/`onSelectSpeed` are passed at ~line 1651-1654).
(d) Render the row after the Speed row (`<Row id={SPEED_ROW_ID} …>…</Row>` ends ~line 878), gated on `voiceoverEnabled`:
```tsx
			{voiceoverEnabled && (
				<VoiceoverRow
					segments={voiceoverSegments ?? []}
					statuses={voiceoverStatuses ?? {}}
					trimRegions={trimRegions ?? []}
					selectedSegmentId={selectedVoiceoverSegmentId ?? null}
					onSelectSegment={(id) => onSelectVoiceoverSegment?.(id)}
					hint={vt("rowHint")}
					trimmedTitle={vt("trimmedTitle")}
				/>
			)}
```
(e) Add a scoped translator for the voiceover strings near the existing `const t = useScopedT("timeline");` in the component that renders the rows:
```ts
	const vt = useScopedT("voiceover");
```

- [ ] **Step 6: Typecheck the wiring**

Run:
```bash
npx tsc --noEmit
```
Expected: exit 0. (Fix any prop-threading type errors introduced in Step 5.)

- [ ] **Step 7: Commit**

```bash
git add src/components/video-editor/timeline/VoiceoverRow.tsx src/components/video-editor/timeline/VoiceoverRow.test.tsx src/components/video-editor/timeline/TimelineEditor.tsx
git commit -m "feat(voiceover): add read-only voiceover timeline row"
```

---

### Task 8: Surface `VoiceoverPanel` as a `SettingsPanel` nav-rail mode

Add a project-wide `"voiceover"` mode to the nav rail; render `<VoiceoverPanel>` when it's active or when a voiceover segment is selected from the timeline.

**Files:**
- Modify: `src/components/video-editor/SettingsPanel.tsx` (mode union ~line 364; `panelModes` ~line 644-663; nav-rail active-state + click ~line 836-861; content render ~line 888+; `SettingsPanelProps`; imports)

**Interfaces:**
- Consumes: `VoiceoverPanel`, `VoiceoverPanelProps` (Task 6); `AudioLines` icon from `lucide-react`.
- Produces: new **optional** `SettingsPanelProps` fields: `voiceoverPanelProps?: VoiceoverPanelProps`, `selectedVoiceoverSegmentId?: string | null`, `onClearVoiceoverSelection?: () => void`. They are optional so this task keeps `tsc` green on its own; Task 9 supplies them at the `VideoEditor` call site.

- [ ] **Step 1: Extend the mode union and props**

(a) Add `"voiceover"` to the mode type (line 364):
```ts
type SettingsPanelMode = "background" | "effects" | "layout" | "cursor" | "export" | "timeline" | "voiceover";
```
(b) Add imports:
```ts
import { AudioLines } from "lucide-react";
import { VoiceoverPanel, type VoiceoverPanelProps } from "./VoiceoverPanel";
```
(c) Add to `SettingsPanelProps` (wherever the interface is declared) — **optional**, so this task builds green before Task 9 wires the call site:
```ts
	voiceoverPanelProps?: VoiceoverPanelProps;
	selectedVoiceoverSegmentId?: string | null;
	onClearVoiceoverSelection?: () => void;
```
(d) Destructure the three new props in the component signature alongside the others.

- [ ] **Step 2: Add the nav-rail entry + a voiceover-scoped translator**

Near `const t = useScopedT("settings");` in `SettingsPanel`, add:
```ts
	const vt = useScopedT("voiceover");
```
Add a `panelModes` entry (after the `"timeline"` entry, ~line 653):
```ts
		{ id: "voiceover", label: vt("navLabel"), icon: AudioLines },
```

- [ ] **Step 3: Derive the "show voiceover" condition**

After `hasTimelineSelection` is computed (~line 642), add:
```ts
	const showVoiceoverPanel =
		(activePanelMode === "voiceover" && !hasTimelineSelection) ||
		props.selectedVoiceoverSegmentId != null;
```
> Use whatever the destructured names are; the intent: the panel shows when its mode is active, OR when a voiceover segment was selected on the timeline (which does not set `hasTimelineSelection`, since voiceover selection is independent of zoom/trim/speed).

- [ ] **Step 4: Clear voiceover selection when switching modes**

In the nav-rail button `onClick` (~line 845-848), clear any voiceover selection so a mode click returns to the browse-all view:
```ts
									onClick={() => {
										if (mode.id === "layout" && mode.disabled) return;
										onClearVoiceoverSelection?.();
										setActivePanelMode(mode.id);
									}}
```

- [ ] **Step 5: Render the panel in the content area**

Inside the main content `<div className="flex-1 overflow-y-auto …">` (after the header at ~line 892, alongside the other `activePanelMode === …` blocks), add — guarded on `voiceoverPanelProps` being present (it's optional until Task 9):
```tsx
						{showVoiceoverPanel && voiceoverPanelProps && (
							<VoiceoverPanel {...voiceoverPanelProps} />
						)}
```
> `voiceoverPanelProps` already carries `selectedSegmentId` (set by `VideoEditor` in Task 9), so no override is needed. The `&& voiceoverPanelProps` guard keeps the spread type-safe while the prop is optional.

- [ ] **Step 6: Include voiceover in the active-mode label**

Extend `activeModeLabel` (~line 669-678) so the header reads the voiceover label when appropriate — the `[...panelModes, exportPanelMode].find(...)` already resolves it because `"voiceover"` is now in `panelModes`; no change needed unless a selection forces it. If `selectedVoiceoverSegmentId != null`, ensure the label still resolves to `vt("navLabel")`:
```ts
	const activeModeLabel = props.selectedVoiceoverSegmentId
		? vt("navLabel")
		: hasTimelineSelection
			? /* ...existing zoom/speed/trim branch unchanged... */
			: /* ...existing else branch unchanged... */;
```
> Keep the existing zoom/speed/trim and else branches exactly as they are; only prepend the `selectedVoiceoverSegmentId` case.

- [ ] **Step 7: Typecheck**

Run:
```bash
npx tsc --noEmit
```
Expected: exit 0. The three new `SettingsPanelProps` fields are **optional**, so the existing `<SettingsPanel …>` call site in `VideoEditor.tsx` still type-checks without them; Task 9 supplies them. The voiceover nav-rail button will be visible but render nothing until Task 9 wires `voiceoverPanelProps` — that's the expected intermediate state.

- [ ] **Step 8: Commit**

```bash
git add src/components/video-editor/SettingsPanel.tsx
git commit -m "feat(voiceover): add voiceover nav-rail mode to SettingsPanel"
```

---

### Task 9: Instantiate `useVoiceover` and integrate in `VideoEditor`

The integration task: instantiate the hook, wire config mutations to undo history, add voiceover selection state, auto-seed on first enable, and prop-drill everything into `SettingsPanel` and `TimelineEditor`.

**Files:**
- Modify: `src/components/video-editor/VideoEditor.tsx`

**Interfaces:**
- Consumes: `useVoiceover` (`@/hooks/useVoiceover`); `segmentTranscript` is used internally by the hook (no direct use); `VoiceoverPanelProps` (Task 6); the new `SettingsPanel`/`TimelineEditor` props (Tasks 7-8).
- Produces: nothing new for other tasks (terminal integration).

- [ ] **Step 1: Instantiate the hook + selection state**

After the `useTranscript({...})` block (~line 318-326), add:
```ts
	const [selectedVoiceoverSegmentId, setSelectedVoiceoverSegmentId] = useState<string | null>(null);

	const {
		statuses: voiceoverStatuses,
		clips: voiceoverClips,
		audioKeyFor: voiceoverAudioKeyFor,
		seedFromTranscript: seedVoiceover,
		generateSegment: generateVoiceoverSegment,
		generateAll: generateAllVoiceover,
	} = useVoiceover({
		config: voiceover,
		transcript,
		onChange: (updater) => pushState((prev) => ({ voiceover: updater(prev.voiceover) })),
	});
```
Add the import near the other hook imports:
```ts
import { useVoiceover } from "@/hooks/useVoiceover";
```
> `voiceover` is already destructured from `editorState` (line 209); `transcript` and `pushState` are already in scope.

- [ ] **Step 2: Auto-seed on first enable**

Add an effect after the hook (seed the script the first time voiceover is enabled with an empty script and a ready transcript):
```ts
	useEffect(() => {
		if (voiceover.enabled && voiceover.segments.length === 0 && transcript) {
			seedVoiceover();
		}
	}, [voiceover.enabled, voiceover.segments.length, transcript, seedVoiceover]);
```

- [ ] **Step 3: Add the config-mutation + selection handlers**

Add near the other `handleXxx` callbacks:
```ts
	const handleVoiceoverToggle = useCallback(
		(enabled: boolean) => pushState((prev) => ({ voiceover: { ...prev.voiceover, enabled } })),
		[pushState],
	);
	const handleVoiceoverVoiceChange = useCallback(
		(voice: string) => pushState((prev) => ({ voiceover: { ...prev.voiceover, voice } })),
		[pushState],
	);
	const handleVoiceoverSpeedChange = useCallback(
		(speed: number) =>
			updateState((prev) => ({ voiceover: { ...prev.voiceover, speed } })),
		[updateState],
	);
	const handleVoiceoverSegmentTextChange = useCallback(
		(id: string, text: string) =>
			updateState((prev) => ({
				voiceover: {
					...prev.voiceover,
					segments: prev.voiceover.segments.map((s) => (s.id === id ? { ...s, text } : s)),
				},
			})),
		[updateState],
	);
	const handleResetVoiceoverScript = useCallback(() => {
		setSelectedVoiceoverSegmentId(null);
		pushState((prev) => ({ voiceover: { ...prev.voiceover, segments: [] } }));
	}, [pushState]);
	const handleSelectVoiceoverSegment = useCallback((id: string) => {
		// Mirror the existing handleSelectZoom/Trim/etc. pattern: set own selection, null the siblings.
		setSelectedVoiceoverSegmentId(id);
		setSelectedZoomId(null);
		setSelectedTrimId(null);
		setSelectedSpeedId(null);
		setSelectedAnnotationId(null);
		setSelectedBlurId(null);
	}, []);
```
> There is no single `clearTimelineSelection` in `VideoEditor`; the codebase uses per-type `handleSelectZoom`/`handleSelectTrim`/`handleSelectSpeed`/`handleSelectAnnotation`/`handleSelectBlur` (~line 1024-1062), each of which sets its own id and nulls the other selection ids when `id` is truthy. `handleSelectVoiceoverSegment` follows the same shape (above).

- [ ] **Step 4: Build the `voiceoverPanelProps` object**

Before the JSX return, assemble:
```ts
	const voiceoverPanelProps: VoiceoverPanelProps = {
		config: voiceover,
		statuses: voiceoverStatuses,
		clips: voiceoverClips,
		audioKeyFor: voiceoverAudioKeyFor,
		transcriptReady: transcriptStatus === "ready" || voiceover.segments.length > 0,
		hasTranscript: transcript != null,
		selectedSegmentId: selectedVoiceoverSegmentId,
		onToggleEnabled: handleVoiceoverToggle,
		onVoiceChange: handleVoiceoverVoiceChange,
		onSpeedChange: handleVoiceoverSpeedChange,
		onSpeedCommit: commitState,
		onSegmentTextChange: handleVoiceoverSegmentTextChange,
		onSegmentTextCommit: commitState,
		onGenerateSegment: (id) => void generateVoiceoverSegment(id),
		onGenerateAll: () => void generateAllVoiceover(),
		onResetScript: handleResetVoiceoverScript,
		onSelectSegment: handleSelectVoiceoverSegment,
	};
```
Add the import:
```ts
import type { VoiceoverPanelProps } from "./VoiceoverPanel";
```
> `transcriptStatus` is already destructured from `useTranscript` (line 320). Confirm its "ready" sentinel value by reading `useTranscript.ts` (`status` union); adjust the `transcriptReady` comparison to the actual ready value.

- [ ] **Step 5: Pass the props to `SettingsPanel`**

At the `<SettingsPanel …>` call (~line 2675), add:
```tsx
									voiceoverPanelProps={voiceoverPanelProps}
									selectedVoiceoverSegmentId={selectedVoiceoverSegmentId}
									onClearVoiceoverSelection={() => setSelectedVoiceoverSegmentId(null)}
```

- [ ] **Step 6: Pass the props to `TimelineEditor`**

At the `<TimelineEditor …>` call (~line 2859), add:
```tsx
									voiceoverEnabled={voiceover.enabled}
									voiceoverSegments={voiceover.segments}
									voiceoverStatuses={voiceoverStatuses}
									selectedVoiceoverSegmentId={selectedVoiceoverSegmentId}
									onSelectVoiceoverSegment={handleSelectVoiceoverSegment}
```

- [ ] **Step 7: Drop voiceover selection when a region is selected**

In each existing `handleSelectZoom`/`handleSelectTrim`/`handleSelectSpeed`/`handleSelectAnnotation`/`handleSelectBlur` (~line 1024-1062), add `setSelectedVoiceoverSegmentId(null);` inside their `if (id) { … }` block so selecting a zoom/trim/speed/annotation/blur region drops any voiceover-clip selection (keeping the single-selection invariant symmetric). Example for `handleSelectZoom`:
```ts
	const handleSelectZoom = useCallback((id: string | null) => {
		setSelectedZoomId(id);
		if (id) {
			setSelectedTrimId(null);
			setSelectedSpeedId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
			setSelectedVoiceoverSegmentId(null);
		}
	}, []);
```

- [ ] **Step 8: Typecheck + lint + full unit suite + build**

Run:
```bash
npx tsc --noEmit && npm run lint && npm run test && npx vite build
```
Expected: all exit 0; unit suite green (including the new Task 2-6 tests).

- [ ] **Step 9: Manual smoke (dev)**

Run `npm run dev`, load a recording with speech, wait for the transcript, open the **Voiceover** nav-rail mode, enable it, confirm the script seeds, edit a line, click **Generate all**, hear a segment via ▶︎, and confirm read-only clips appear on the timeline's Voiceover row. (Preview against the video clock + export are Plan 4.)

- [ ] **Step 10: Commit**

```bash
git add src/components/video-editor/VideoEditor.tsx
git commit -m "feat(voiceover): instantiate useVoiceover and wire panel + timeline in VideoEditor"
```

---

### Task 10: Carried-over cleanups — browser-tier PCM round-trip test + dead-stub annotation

**Files:**
- Create: `src/lib/voiceover/voiceoverClipCache.browser.test.ts` (browser tier)
- Modify: `vite-plugins/stubNodeBuiltins.ts` (annotate now-dead entries)

**Interfaces:**
- Consumes: `nativeBridgeClient.voiceover.{putClip,getClip}` — but the native bridge is main-process; in the browser tier there is no Electron main. Instead, test the **binary round-trip contract** directly against the encode/decode math (see below), OR, if a renderer-safe seam exists, use it. The goal (from Plan 2's review): prove a Float32Array that is a **view into a larger buffer** (non-zero `byteOffset`) round-trips without trailing samples.

- [ ] **Step 1: Write the browser-tier round-trip test**

The Plan-2 fix made `useVoiceover.generateSegment` send `pcm.buffer.slice(byteOffset, byteOffset+byteLength)`. This test asserts that slicing a **view** yields exactly the view's bytes (the invariant that keeps view-backed producers in Plans 3-4 from corrupting the cache). Create `src/lib/voiceover/voiceoverClipCache.browser.test.ts`:

```ts
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the view-offset invariant (Plan 2 final review): a Float32Array that is a
 * subarray view into a larger buffer must be persisted as ONLY its own bytes, never the whole
 * backing buffer. This mirrors what useVoiceover.generateSegment does before putClip.
 */
function sliceViewBytes(pcm: Float32Array): ArrayBuffer {
	return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
}

describe("voiceover clip PCM view round-trip", () => {
	it("persists only the view's samples, not the whole backing buffer", () => {
		const backing = new Float32Array(100);
		for (let i = 0; i < backing.length; i++) backing[i] = i / 100;
		const view = backing.subarray(10, 34); // 24 samples, byteOffset 40
		expect(view.byteOffset).toBe(40);

		const sliced = sliceViewBytes(view);
		expect(sliced.byteLength).toBe(24 * 4); // not 100*4

		const restored = new Float32Array(sliced);
		expect(Array.from(restored)).toEqual(Array.from(view));
	});
});
```
> This is placed in the browser tier per the carried-over note; the math is identical in jsdom, but keeping it in `*.browser.test.ts` documents intent and runs under real Chromium `ArrayBuffer` semantics. If a renderer-reachable cache seam is later added, extend this file to exercise `putClip`/`getClip` end-to-end.

- [ ] **Step 2: Run the browser-tier test**

Run:
```bash
npx vitest --config vitest.browser.config.ts run src/lib/voiceover/voiceoverClipCache.browser.test.ts
```
Expected: PASS.

- [ ] **Step 3: Annotate the now-dead stub entries**

In `vite-plugins/stubNodeBuiltins.ts`, add a short comment above the `fs/promises` and `path` entries noting the anchored aliases in `vite.config.ts`/`vitest.browser.config.ts` now take precedence for kokoro (see Plan 2 Task 1), so these entries are dead for the voiceover path and kept only as a defensive net for other importers. Do not remove them (removal risks other importers). Example:
```ts
// NOTE (voiceover Plan 2/3): kokoro's `fs/promises` + `path` now resolve via the anchored
// RegExp aliases in vite.config.ts / vitest.browser.config.ts (→ kokoroVoiceFs / kokoroPath),
// which run before this plugin. These entries are retained only as a defensive fallback for any
// other Node-builtin importer; they are dead for the kokoro voice-loading path.
```

- [ ] **Step 4: Verify nothing regressed**

Run:
```bash
npx tsc --noEmit && npm run lint
```
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/voiceover/voiceoverClipCache.browser.test.ts vite-plugins/stubNodeBuiltins.ts
git commit -m "test(voiceover): view-backed PCM round-trip guard; annotate dead node-builtin stubs"
```

---

### Task 11: Docs + final gates

**Files:**
- Modify: `src/CLAUDE.md` and/or `src/components/video-editor/` folder docs if present (record the new voiceover UI surface); `src/components/video-editor/timeline/` docs if present.

- [ ] **Step 1: Update folder CLAUDE.md files where structure changed**

If `src/components/video-editor/` or `src/components/video-editor/timeline/` has a `CLAUDE.md`, add one line each noting: `VoiceoverPanel` (project-wide `"voiceover"` SettingsPanel mode), `VoiceoverSegmentRow`, the read-only `VoiceoverRow` timeline lane, and that `layoutVoiceover` (`src/lib/voiceover/layout.ts`) is the output-time alignment consumed by preview/export (Plan 4). If no folder CLAUDE.md exists, add the voiceover note to `src/CLAUDE.md`'s `components/` bullet. (Per the repo maintenance convention: update the folder's CLAUDE.md in the same change that alters its structure.)

- [ ] **Step 2: Run all gates**

Run:
```bash
npm run lint && npx tsc --noEmit && npm run test && npm run i18n:check && npx vite build && npm run test:browser
```
Expected: all exit 0; unit + browser suites green; `i18n:check` reports full parity.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs(voiceover): note Plan 3 UI surface in folder docs"
```

---

## Self-Review

**1. Spec coverage** (against spec §8.4, §9, §15):
- VoiceoverPanel (enable/voice/speed/generate-all/per-segment edit/status/audition/reset) → Tasks 5, 6. ✅
- Panel as project-wide nav-rail mode + standalone component → Task 8 (+ Task 6). ✅
- Read-only source-time timeline row, dims trimmed clips, click-to-select → Task 7. ✅ (spec §15 refinement)
- Pure `layoutVoiceover` (anchor, drop-in-trim, trim+speed mapping, overlap nudge), unit-tested, consumers deferred to Plan 4 → Task 2. ✅
- Instantiate `useVoiceover` in `VideoEditor`, onChange→history, text transient+commit, auto-seed → Task 9. ✅
- Per-segment audition only; timeline-synced preview stays Plan 4 → Task 4 (+ Task 6). ✅
- Static `KOKORO_VOICES` picker, speed 0.7–1.2 → Task 6. ✅
- i18n as-you-go, new `voiceover` namespace across all locales → Task 1. ✅
- Carried cleanups: generateSegment guard + produce queued (Task 3); view-backed PCM round-trip test + dead-stub annotate (Task 10). ✅
- Docs + gates → Task 11. ✅
- Out of scope (Plan 4): `synthesizeVoiceoverTrack` export, Web-Audio timeline-synced preview, muting `<video>` during playback. Correctly excluded.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Where a file is too large to reproduce whole (`VideoEditor.tsx`, `SettingsPanel.tsx`, `TimelineEditor.tsx`), exact anchors + the added code are given, with instructions to match existing prop-threading — these are modification tasks, not placeholders.

**3. Type consistency:** `PlacedClip`/`LayoutClipInput` (Task 2) are self-contained. `VoiceoverPanelProps` (Task 6) is the single contract consumed identically by Tasks 8 & 9. `ResolvedClip`/`SegmentSynthStatus`/`VoiceoverConfig`/`VoiceoverSegment` names match the landed Plan-2 modules. `useClipAudition` returns `{auditioningKey, play, stop}` used consistently in Task 6. `VOICEOVER_ROW_ID` defined once (Task 7). Timeline prop names (`voiceoverEnabled`/`voiceoverSegments`/`voiceoverStatuses`/`selectedVoiceoverSegmentId`/`onSelectVoiceoverSegment`) match between Task 7 (definition) and Task 9 (call site).

**Verified during planning:** `I18nProvider` (used in the RTL tests) and `useScopedT(namespace)` are exported from `src/contexts/I18nContext.tsx`. `Button` supports `variant: "secondary" | "ghost"` and `size: "sm"` (`src/components/ui/button.tsx`). Selection uses per-type `handleSelect*` callbacks (no `clearTimelineSelection`); Task 9 mirrors that pattern. `Slider` forwards Radix `onValueChange`/`onValueCommit`; `pushState`/`updateState` accept the functional form; `voiceover` is already on `EditorState`; `TrimRegion`/`SpeedRegion` import from `@/components/video-editor/types` (matching the exporter).

**Remaining integration flex point** (call out during execution, don't guess): the exact `transcriptStatus` "ready" sentinel — read the `status` union in `src/hooks/useTranscript.ts` and adjust the `transcriptReady` comparison in Task 9 Step 4. Also confirm the inner-vs-outer prop-threading layers in `TimelineEditor.tsx` when adding the pass-through in Task 7 Step 5.
