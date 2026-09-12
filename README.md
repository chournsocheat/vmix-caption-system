# vMix Live Caption, Translation & QC System

Real-time speech-to-text → translation → human-reviewed → vMix Title overlay pipeline.

## Setup

```bash
npm install
cp .env.example .env
# edit .env: set VMIX_IP, VMIX_DEFAULT_INPUT, VMIX_DEFAULT_SELECTED_NAME,
# and pick a TRANSLATION_PROVIDER (google/deepl/libre) + its API key
npm start
```

Open `http://localhost:3000` in **Chrome or Edge** (required for the Web Speech API).

## Capturing vMix's program audio (not just a mic)

The browser's Web Speech API can only listen to a local audio **input** device — it
cannot reach into vMix over HTTP/IP to grab its program audio directly. To caption
what vMix is actually outputting, route that audio through a virtual audio cable:

1. Install **VB-Audio Virtual Cable** (free) on the machine running vMix.
2. In vMix, set the program/master audio output (or the relevant Input's Bus A/B)
   to **CABLE Input (VB-Audio Virtual Cable)** instead of your physical speakers.
3. In this dashboard's audio device dropdown, select
   **"CABLE Output (VB-Audio Virtual Cable)"** — the app labels virtual-cable-style
   devices with a 🎚️ icon and lists them first, and will nudge you with a toast if
   none is detected.
4. If you still want to monitor audio locally, add a second output in your OS sound
   settings, or use vMix's own audio monitoring bus alongside the CABLE routing.

## vMix side

1. Add a Title input (e.g. GT Title) named **Captions** with a text field named **Caption.Text**
   (or set `VMIX_DEFAULT_INPUT` / `VMIX_DEFAULT_SELECTED_NAME` in `.env` to match your own names).
2. Enable the Web Controller: Settings → Web Controller → set port `8088` (default).
3. If vMix runs on a different machine than this Node server, point `VMIX_IP` at that machine's LAN IP.

## Using the dashboard

1. Pick your audio input (Virtual Audio Cable / Line-In / Mic), the **Source Speech Language**
   (used by the browser's Web Speech API), and click **Start Listening**.
2. Speak — the app buffers your speech and only treats it as a complete sentence after ~1s of
   silence (not on every micro-pause), so short fragments never get sent on their own. The
   recognized text appears in the Active Edit Zone; low-confidence speech is masked with `.....`
   (or dropped, per `LOW_CONFIDENCE_ACTION`); banned words are censored; long captions are
   wrapped to at most `CAPTION_MAX_LINES` lines of `CAPTION_MAX_CHARS_PER_LINE` characters (with
   an ellipsis if still too long) **only in what's sent to vMix** — the Edit Zone/Log Stream
   always show the full text.
3. The Target Translation Language buttons sit directly above the translated box. Leave the
   boxes alone and **Send Both** fires automatically after the countdown — both overlays are
   sent in a single synchronized request so there's no visible lag between them. Edit either
   box, hit **Cancel Auto**, or use **Send Overlay 1 / Send Overlay 2 / Clear** to intervene.
4. Quick Phrase buttons drop a pre-written notice straight into the edit zone.
5. The right-hand ON AIR panel mirrors whatever is currently live on each vMix title.
   **Clear both on vMix** sends the *actual* Input/SelectedName currently configured in the
   Overlay 1/2 Target fields (not just the `.env` defaults), so it correctly clears whatever
   you're really using even if you've customized those fields in the UI.

### Google Cloud Auto Multi-Language mode

Toggle the **🌐 Google Cloud Auto Multi-Language** button to switch from the browser's Web
Speech API to server-side Google Cloud Speech-to-Text streaming, which can auto-detect
code-switching (e.g. Khmer mixed with English) within a single stream — something the Web
Speech API cannot do (it only accepts one fixed language at a time).

Setup:
1. In Google Cloud Console, enable the **Cloud Speech-to-Text API**, create a service account
   with the "Cloud Speech Client" role, and download its JSON key.
2. `npm install` (this pulls in `@google-cloud/speech`).
3. Set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json` in `.env`.
4. Set `GOOGLE_CLOUD_STT_ALTERNATIVE_LANGS` to the mix of languages you expect (default
   `km-KH,en-US`) — the Source Speech Language dropdown's value becomes the primary
   `languageCode`; up to 3 others from this list are sent as `alternativeLanguageCodes`.

The browser captures 16-bit PCM audio via an AudioWorklet (`public/pcm-worklet-processor.js`)
and streams it to the server as binary WebSocket frames; the server pipes it into Cloud
Speech's `streamingRecognize` and broadcasts results the same way as Web Speech mode
(`stt_result` once Google marks a result final, `stt_interim` for live preview text).
Requires a recent Chrome/Edge (AudioWorklet support) and an active WebSocket connection.

## Notes & limitations

- The browser's Web Speech API reports confidence per **utterance**, not per word — masking
  is applied to the whole recognized segment. Google Cloud STT mode and AssemblyAI/Whisper
  both support word-level timestamps server-side (`words` field on the STT payload) if you
  want granular per-word masking instead.
- LibreTranslate's free public instance is rate-limited; self-host it or use Google/DeepL keys
  for production reliability.
- **LibreTranslate has no Khmer model at all** (not a rate-limit or config issue — Argos
  Translate simply doesn't ship one), so any `km` target request against it fails with a
  400. If your workflow targets Khmer, set `TRANSLATION_PROVIDER=google` and provide
  `GOOGLE_TRANSLATE_API_KEY`. Libre is fine for en/zh/fr/ar/ru/es.
- DeepL does not currently support Khmer or Thai as a target language; requests for those
  targets fall back to English when DeepL is the selected provider — use Google or LibreTranslate
  for Khmer/Thai.
- `@google-cloud/speech` is loaded defensively — if it isn't installed or credentials aren't
  configured, the rest of the app keeps working fine; only the Google Cloud STT mode toggle
  will report a clear error when you try to use it.
