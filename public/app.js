/**
 * app.js — vMix Live Caption & QC Console (frontend)
 *
 * Pipeline:
 *  1. Web Speech API recognizes speech locally (continuous, interim + final).
 *  2. On a final result, the client sends { type: 'stt_final', text, confidence,
 *     targetLang } to the server — it does NOT mask/censor/translate itself.
 *  3. The server applies confidence masking, profanity filtering, and
 *     translation, then broadcasts one authoritative { type: 'stt_result', entry }
 *     to every connected dashboard. This client (and any others open) populate
 *     the Active Edit Zone from that broadcast — single source of truth.
 *  4. The operator can edit either box and send Overlay 1 (original), Overlay 2
 *     (translated), or Both to vMix; an auto-send timer sends Both if left alone.
 *
 * NOTE on confidence scores: the browser's SpeechRecognition API only exposes an
 * utterance-level confidence value, not per-word scores. Chrome sometimes
 * reports 0 for interim results and a fixed value for finals. The server masks
 * at the whole-segment level because of this; feed a `words` array on the
 * stt_final payload for true per-word masking if you swap in a cloud STT engine.
 */

(() => {
  'use strict';

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const state = {
    ws: null,
    wsReconnectAttempts: 0,
    wsReconnectTimer: null,
    pendingTranslations: new Map(), // requestId -> {resolve, reject} — used only by requestTranslation() (ad-hoc/manual use)
    pendingSendBoth: new Map(),     // requestId -> {resolve} — used by sendBothToOverlays() to await the WS round trip
    sttMode: 'webspeech',           // 'webspeech' | 'google' — which STT engine is currently selected
    sourceLang: 'en-US',            // manually selected source speech language (Web Speech mode)
    googleAudioCtx: null,
    googleWorkletNode: null,
    audioCtx: null,
    analyser: null,
    micStream: null,
    levelRAF: null,
    recognition: null,
    listening: false,
    shouldBeListening: false,
    recognitionRestartTimer: null,

    autoSendInterval: null,
    autoSendDeadline: null,
    autoSendCancelled: false,
    autoSendArmed: false, // true = current Edit Zone content has NOT been sent yet

    lastSttConfidence: null,
    warnedNoCable: false,
    // Client-side cache of genuine STT-originated log entries (i.e. ones with
    // an `original` field — vMix-send confirmations don't have one), used to
    // build the .txt/.srt export. This is a convenience cache, not the
    // source of truth — the server's /api/logs holds the same history.
    sttEntries: [],
    maxCachedSttEntries: 1000,

    // ---- Sentence-level buffering ----
    // Chrome's own SpeechRecognition segmentation fires `isFinal` on very
    // short internal pauses, which is what was producing 1-2 word fragments
    // ("in", "a stately") getting pushed to Overlay 1. Instead of trusting
    // that boundary, we accumulate every finalized fragment into a running
    // buffer and only treat the sentence as "done" after a real silence gap.
    sentenceBuffer: '',      // committed (finalized) fragments joined so far
    interimText: '',         // the currently-forming (not yet finalized) tail
    sentenceConfidences: [], // confidence of each committed fragment, for an aggregate
    bufferStartTime: 0,
    silenceFlushTimer: null,
    silenceFlushDelayMs: 1000,  // ~1s pause = sentence boundary, per spec
    maxBufferMs: 12000,         // safety valve for one very long uninterrupted run-on

    // Fragment-level dedupe: guards against Chrome re-firing the exact same
    // finalized fragment right after one of its internal restarts, which
    // would otherwise double that word/phrase inside the sentence buffer.
    lastFragmentSignature: null,
    lastFragmentTime: 0,
    fragmentDedupeWindowMs: 2000,
    // Sentence-level dedupe: guards against sending the identical completed
    // sentence twice in a row (e.g. a duplicate flush call).
    lastSentenceSignature: null,
    lastSentenceTime: 0,
    sentenceDedupeWindowMs: 2500,

    // Per-overlay send dedupe — Overlay 1 and Overlay 2 can be sent
    // independently, so each needs its own guard.
    lastSentSignatureOverlay1: null,
    lastSentTimeOverlay1: 0,
    lastSentSignatureOverlay2: null,
    lastSentTimeOverlay2: 0,
    sendDedupeWindowMs: 2000,

    // Live Overlay 1 push (real-time original captioning, see maybeLivePushOverlay1)
    lastLiveOverlay1Send: 0,
    lastLiveOverlay1Text: '',
    liveOverlay1ThrottleMs: 400,

    config: {
      minConfidence: 60,
      lowConfidenceAction: 'mask',
      bannedWords: [],
      overlay1DefaultInput: 'OriginalCaption',
      overlay1DefaultSelectedName: 'Caption.Text',
      overlay2DefaultInput: 'TranslatedCaption',
      overlay2DefaultSelectedName: 'Caption.Text',
      defaultOverlayChannel: 1,
    },
    settings: {
      autoSendDelaySec: 3,
      wsUrl: null,
      quickPhrases: [
        { label: 'Please wait', text: 'Please wait…' },
        { label: '10 min break', text: 'We will be right back — 10 minute break.' },
        { label: 'Technical difficulties', text: 'We are experiencing technical difficulties. Please stand by.' },
        { label: 'Thank you', text: 'Thank you for watching!' },
      ],
    },
  };

  const LS_KEY = 'vmix_caption_settings_v1';

  // ------------------------------------------------------------------
  // DOM refs
  // ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const el = {
    wsDot: $('wsDot'), wsLabel: $('wsLabel'),
    vmixDot: $('vmixDot'), vmixLabel: $('vmixLabel'),
    settingsBtn: $('settingsBtn'), settingsModal: $('settingsModal'), closeSettingsBtn: $('closeSettingsBtn'), saveSettingsBtn: $('saveSettingsBtn'),
    wsUrlInput: $('wsUrlInput'), autoSendDelayInput: $('autoSendDelayInput'), newPhraseInput: $('newPhraseInput'), addPhraseBtn: $('addPhraseBtn'),
    logStream: $('logStream'), clearLogBtn: $('clearLogBtn'),
    exportTxtBtn: $('exportTxtBtn'), exportSrtBtn: $('exportSrtBtn'),
    audioDeviceSelect: $('audioDeviceSelect'), micToggleBtn: $('micToggleBtn'), levelMeter: $('levelMeter'),
    sourceLangSelect: $('sourceLangSelect'), sttModeBtn: $('sttModeBtn'), liveOverlay1Toggle: $('liveOverlay1Toggle'), lockLanguageToggle: $('lockLanguageToggle'),
    targetLangSelect: $('targetLangSelect'), targetLangGroup: $('targetLangGroup'),
    confidenceBadge: $('confidenceBadge'), countdownRing: $('countdownRing'), countdownNum: $('countdownNum'),
    activeOriginalInput: $('activeOriginalInput'), activeTranslatedInput: $('activeTranslatedInput'),
    sendOverlay1Btn: $('sendOverlay1Btn'), sendOverlay2Btn: $('sendOverlay2Btn'), sendBothBtn: $('sendBothBtn'),
    clearZoneBtn: $('clearZoneBtn'), cancelAutoBtn: $('cancelAutoBtn'), autoSendToggle: $('autoSendToggle'), autoSendDelayLabel: $('autoSendDelayLabel'),
    quickPhrases: $('quickPhrases'),
    onAirDot1: $('onAirDot1'), onAirText1: $('onAirText1'), onAirTimestamp1: $('onAirTimestamp1'),
    onAirDot2: $('onAirDot2'), onAirText2: $('onAirText2'), onAirTimestamp2: $('onAirTimestamp2'),
    forceClearBtn: $('forceClearBtn'),
    overlay1Input: $('overlay1Input'), overlay1SelectedName: $('overlay1SelectedName'),
    overlay2Input: $('overlay2Input'), overlay2SelectedName: $('overlay2SelectedName'),
    testOverlay1Btn: $('testOverlay1Btn'), testOverlay2Btn: $('testOverlay2Btn'),
    minConfidenceInput: $('minConfidenceInput'), minConfidenceValue: $('minConfidenceValue'), profanityFilterToggle: $('profanityFilterToggle'),
    toastContainer: $('toastContainer'),
  };

  // ------------------------------------------------------------------
  // Toasts
  // ------------------------------------------------------------------
  function toast(message, type = 'info') {
    const colors = { info: 'bg-slate-800 border-slate-600', error: 'bg-red-900/80 border-red-600', success: 'bg-emerald-900/80 border-emerald-600', warn: 'bg-amber-900/80 border-amber-600' };
    const div = document.createElement('div');
    div.className = `px-3 py-2 rounded border text-xs shadow-lg max-w-xs ${colors[type] || colors.info}`;
    div.textContent = message;
    el.toastContainer.appendChild(div);
    setTimeout(() => { div.style.opacity = '0'; div.style.transition = 'opacity .4s'; setTimeout(() => div.remove(), 400); }, 4000);
  }

  // ------------------------------------------------------------------
  // Persisted settings
  // ------------------------------------------------------------------
  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) Object.assign(state.settings, JSON.parse(raw));
    } catch (err) {
      console.warn('Failed to load settings from localStorage', err);
    }
    const o1i = localStorage.getItem('vmix_overlay1_input');
    const o1s = localStorage.getItem('vmix_overlay1_selected_name');
    const o2i = localStorage.getItem('vmix_overlay2_input');
    const o2s = localStorage.getItem('vmix_overlay2_selected_name');
    if (o1i) el.overlay1Input.value = o1i;
    if (o1s) el.overlay1SelectedName.value = o1s;
    if (o2i) el.overlay2Input.value = o2i;
    if (o2s) el.overlay2SelectedName.value = o2s;

    const savedSourceLang = localStorage.getItem('stt_source_lang');
    if (savedSourceLang) el.sourceLangSelect.value = savedSourceLang;
  }

  function persistSettings() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state.settings)); } catch (err) { /* ignore quota errors */ }
  }

  function persistOverlayTargets() {
    localStorage.setItem('vmix_overlay1_input', el.overlay1Input.value || '');
    localStorage.setItem('vmix_overlay1_selected_name', el.overlay1SelectedName.value || '');
    localStorage.setItem('vmix_overlay2_input', el.overlay2Input.value || '');
    localStorage.setItem('vmix_overlay2_selected_name', el.overlay2SelectedName.value || '');
  }

  // ------------------------------------------------------------------
  // Backend config
  // ------------------------------------------------------------------
  async function loadConfig() {
    try {
      const resp = await fetch('/api/config');
      const data = await resp.json();
      state.config.minConfidence = data.qc.minConfidence;
      state.config.lowConfidenceAction = data.qc.lowConfidenceAction;
      state.config.bannedWords = data.qc.bannedWords || [];
      state.config.overlay1DefaultInput = data.vmix.overlay1.input;
      state.config.overlay1DefaultSelectedName = data.vmix.overlay1.selectedName;
      state.config.overlay2DefaultInput = data.vmix.overlay2.input;
      state.config.overlay2DefaultSelectedName = data.vmix.overlay2.selectedName;
      state.config.defaultOverlayChannel = data.vmix.defaultOverlayChannel;

      if (!el.overlay1Input.value) el.overlay1Input.value = state.config.overlay1DefaultInput;
      if (!el.overlay1SelectedName.value) el.overlay1SelectedName.value = state.config.overlay1DefaultSelectedName;
      if (!el.overlay2Input.value) el.overlay2Input.value = state.config.overlay2DefaultInput;
      if (!el.overlay2SelectedName.value) el.overlay2SelectedName.value = state.config.overlay2DefaultSelectedName;
      el.minConfidenceInput.value = state.config.minConfidence;
      el.minConfidenceValue.textContent = state.config.minConfidence;
    } catch (err) {
      toast('Could not load server config — using client defaults.', 'warn');
    }
  }

  // ------------------------------------------------------------------
  // Target language button group (mirrors the hidden #targetLangSelect)
  // ------------------------------------------------------------------
  function setTargetLang(lang) {
    el.targetLangSelect.value = lang;
    document.querySelectorAll('.lang-btn').forEach((btn) => {
      const active = btn.dataset.lang === lang;
      btn.className = `lang-btn px-2.5 py-1 rounded text-xs border border-slate-700 ${active ? 'bg-accent text-slate-900 font-medium' : 'bg-slate-800 hover:bg-slate-700'}`;
    });
  }

  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => setTargetLang(btn.dataset.lang));
  });

  // ------------------------------------------------------------------
  // WebSocket with auto-reconnect (exponential backoff, capped, single-socket guard)
  // ------------------------------------------------------------------
  function wsUrl() {
    if (state.settings.wsUrl) return state.settings.wsUrl;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function setWsStatus(status) {
    const map = {
      connecting: { dot: 'bg-amber-400', label: 'Connecting…' },
      open: { dot: 'bg-emerald-400', label: 'Connected' },
      closed: { dot: 'bg-red-500', label: 'Disconnected — retrying…' },
    };
    const s = map[status] || map.closed;
    el.wsDot.className = `w-1.5 h-1.5 rounded-full ${s.dot}`;
    el.wsLabel.textContent = s.label;
  }

  function connectWs() {
    // Never allow two live sockets at once — each open/CONNECTING socket
    // keeps its own message handler, so overlapping sockets would deliver
    // (and render/act on) every broadcast more than once.
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    setWsStatus('connecting');
    let socket;
    try {
      socket = new WebSocket(wsUrl());
    } catch (err) {
      scheduleWsReconnect();
      return;
    }
    state.ws = socket;

    // on* assignment (not addEventListener) so re-running this on the same
    // socket object can never stack a second listener.
    socket.onopen = () => {
      state.wsReconnectAttempts = 0;
      setWsStatus('open');
    };

    socket.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (err) { return; }
      handleWsMessage(msg);
    };

    socket.onclose = () => {
      if (state.ws !== socket) return; // a stale/superseded socket — ignore
      setWsStatus('closed');
      scheduleWsReconnect();
    };

    socket.onerror = () => {
      try { socket.close(); } catch (err) { /* already closing */ }
    };
  }

  function disconnectWs() {
    const socket = state.ws;
    state.ws = null; // detach first so the old socket's onclose becomes a no-op
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(); } catch (err) { /* ignore */ }
    }
  }

  function scheduleWsReconnect() {
    if (state.wsReconnectTimer) return;
    const attempt = state.wsReconnectAttempts++;
    const delay = Math.min(1000 * 2 ** attempt, 15000);
    state.wsReconnectTimer = setTimeout(() => {
      state.wsReconnectTimer = null;
      connectWs();
    }, delay);
  }

  function wsSend(payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  function isSttEntry(entry) {
    // Genuine STT-originated entries carry an `original` field; vMix-send
    // confirmation entries (from send_overlay) only have `translated`/`target`.
    return !!entry && typeof entry.original === 'string';
  }

  function cacheSttEntry(entry) {
    if (!isSttEntry(entry)) return;
    state.sttEntries.push(entry);
    if (state.sttEntries.length > state.maxCachedSttEntries) {
      state.sttEntries.splice(0, state.sttEntries.length - state.maxCachedSttEntries);
    }
  }

  function handleWsMessage(msg) {
    switch (msg.type) {
      case 'init':
        (msg.history || []).forEach((entry) => { renderLogEntry(entry); cacheSttEntry(entry); });
        if (msg.onAir) updateOnAirPanel(msg.onAir);
        break;
      case 'log_entry':
        renderLogEntry(msg.entry);
        break;
      case 'stt_result':
        renderLogEntry(msg.entry);
        cacheSttEntry(msg.entry);
        applyIncomingSttResult(msg.entry);
        break;
      case 'stt_interim':
        // Live-preview text from the Google Cloud STT pipeline — mirrors
        // what Web Speech mode gets for free from the browser's own interim
        // recognition events.
        if (state.sttMode === 'google') {
          el.activeOriginalInput.value = msg.text;
          maybeLivePushOverlay1(msg.text);
          if (typeof msg.confidence === 'number') updateConfidenceBadge(msg.confidence);
        }
        break;
      case 'google_stream_ended':
        // Cloud Speech's streamingRecognize has a hard ~305s limit and ends
        // on its own even with no error — restart transparently so a long
        // session doesn't silently stop captioning.
        if (state.sttMode === 'google' && state.shouldBeListening) {
          const primaryLang = el.sourceLangSelect.value || 'en-US';
          const actualRate = state.googleAudioCtx ? state.googleAudioCtx.sampleRate : 16000;
          wsSend({ type: 'start_google_stream', sourceLangs: [primaryLang], targetLang: el.targetLangSelect.value, sampleRateHertz: actualRate, lockLanguage: el.lockLanguageToggle.checked });
          toast('Google Cloud stream refreshed (periodic reconnect).', 'info');
        }
        break;
      case 'onair_update':
        updateOnAirPanel(msg.onAir);
        break;
      case 'translate_result': {
        const pending = state.pendingTranslations.get(msg.requestId);
        if (pending) {
          state.pendingTranslations.delete(msg.requestId);
          if (msg.ok) pending.resolve(msg.translated);
          else pending.reject(new Error(msg.error));
        }
        break;
      }
      case 'send_overlay_result':
        if (!msg.ok) toast(`Overlay ${msg.target === 'overlay2' ? '2' : '1'} send failed: ${msg.error}`, 'error');
        break;
      case 'send_both_result': {
        const pending = state.pendingSendBoth.get(msg.requestId);
        if (pending) { state.pendingSendBoth.delete(msg.requestId); pending.resolve(msg); }
        if (!msg.ok) {
          const which = !msg.overlay1?.ok ? 'Overlay 1' : 'Overlay 2';
          toast(`Synchronized send failed (${which}): ${msg.overlay1?.error || msg.overlay2?.error || 'unknown error'}`, 'error');
        }
        break;
      }
      case 'error':
        // This was previously console.warn-only — any Google Cloud STT auth,
        // config, or quota error was completely invisible in the UI, which
        // looks exactly like "I turned it on and nothing happens." Surface it.
        console.warn('WS server error:', msg.error);
        toast(msg.error, 'error');
        break;
      default:
        break;
    }
  }

  // Ad-hoc translation helper — not used by the main STT pipeline (the server
  // translates as part of stt_final -> stt_result), but kept available for
  // any future on-demand "retranslate this" style feature.
  function requestTranslation(text, target, source) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      state.pendingTranslations.set(requestId, { resolve, reject });
      const sent = wsSend({ type: 'translate_request', requestId, text, target, source });
      if (!sent) {
        state.pendingTranslations.delete(requestId);
        fetch('/api/translate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, target, source }),
        }).then((r) => r.json()).then((data) => {
          if (data.ok) resolve(data.translated); else reject(new Error(data.error));
        }).catch(reject);
      }
      setTimeout(() => {
        if (state.pendingTranslations.has(requestId)) {
          state.pendingTranslations.delete(requestId);
          reject(new Error('Translation request timed out'));
        }
      }, 8000);
    });
  }

  // ------------------------------------------------------------------
  // Log stream rendering
  // ------------------------------------------------------------------
  function renderLogEntry(entry) {
    if (!entry) return;
    const div = document.createElement('div');
    div.className = 'log-enter px-2 py-1.5 rounded bg-slate-800/60 border border-slate-800';
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const conf = typeof entry.confidence === 'number' ? `${Math.round(entry.confidence)}%` : '—';
    const confColor = typeof entry.confidence === 'number' && entry.confidence < state.config.minConfidence ? 'text-red-400' : 'text-emerald-400';
    const statusLabel = entry.target ? `${entry.status || ''} · ${entry.target}` : (entry.status || '');
    const bodyText = entry.translated ?? entry.filtered ?? entry.original ?? '';
    div.innerHTML = `
      <div class="flex items-center justify-between text-[10px] text-slate-500 mb-0.5">
        <span>${time}${entry.targetLang ? ' · ' + entry.targetLang.toUpperCase() : ''}</span>
        <span class="${confColor}">${conf}${statusLabel ? ' · ' + statusLabel : ''}</span>
      </div>
      <div class="text-slate-200 khmer break-words">${escapeHtml(bodyText)}</div>
    `;
    el.logStream.appendChild(div);
    // Scroll only the log container's own scrollTop — #logStream is a bounded
    // flex child (min-h-0 + overflow-y-auto), so this never expands the page.
    el.logStream.scrollTop = el.logStream.scrollHeight;
    while (el.logStream.children.length > 300) el.logStream.removeChild(el.logStream.firstChild);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------------------------
  // Export Log (.txt / .srt) — built from the client-side sttEntries cache
  // ------------------------------------------------------------------
  function pad(n, len = 2) { return String(n).padStart(len, '0'); }

  function formatSrtTimestamp(ms) {
    const totalMs = Math.max(0, Math.round(ms));
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const millis = totalMs % 1000;
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
  }

  function buildSrt(entries) {
    if (entries.length === 0) return '';
    const firstTs = entries[0].timestamp;
    return entries.map((entry, i) => {
      const startMs = entry.timestamp - firstTs;
      const nextStartMs = i + 1 < entries.length ? entries[i + 1].timestamp - firstTs : startMs + 4000;
      // Each subtitle block lasts until the next one starts, clamped to a
      // sensible 1.2s–4s range so a very long pause doesn't leave one caption
      // frozen on screen and a very fast exchange doesn't flash unreadably.
      const durationMs = Math.min(4000, Math.max(1200, nextStartMs - startMs));
      const endMs = startMs + durationMs;
      const original = entry.filtered || entry.original || '';
      const translated = entry.translated || '';
      const lines = [original, translated].filter(Boolean).join('\n');
      return `${i + 1}\n${formatSrtTimestamp(startMs)} --> ${formatSrtTimestamp(endMs)}\n${lines}\n`;
    }).join('\n');
  }

  function buildTxt(entries) {
    return entries.map((entry) => {
      const time = new Date(entry.timestamp).toLocaleString();
      const original = entry.filtered || entry.original || '';
      const translated = entry.translated || '';
      const langTag = entry.targetLang ? ` (${entry.targetLang.toUpperCase()})` : '';
      return `[${time}]${langTag}\nOriginal:   ${original}\nTranslated: ${translated}\n`;
    }).join('\n');
  }

  function triggerDownload(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function timestampForFilename() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  el.exportTxtBtn.addEventListener('click', () => {
    if (state.sttEntries.length === 0) { toast('No captions to export yet.', 'warn'); return; }
    triggerDownload(`captions_${timestampForFilename()}.txt`, buildTxt(state.sttEntries), 'text/plain;charset=utf-8');
  });

  el.exportSrtBtn.addEventListener('click', () => {
    if (state.sttEntries.length === 0) { toast('No captions to export yet.', 'warn'); return; }
    triggerDownload(`captions_${timestampForFilename()}.srt`, buildSrt(state.sttEntries), 'application/x-subrip;charset=utf-8');
  });

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  function normalizeForDedupe(text) {
    return (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function resetConfidenceBadge() {
    el.confidenceBadge.textContent = '— %';
    el.confidenceBadge.className = 'text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400';
  }

  function updateConfidenceBadge(confidencePct) {
    state.lastSttConfidence = confidencePct;
    el.confidenceBadge.textContent = `${confidencePct}%`;
    const threshold = parseInt(el.minConfidenceInput.value, 10);
    el.confidenceBadge.className = `text-[10px] px-2 py-0.5 rounded-full ${confidencePct < threshold ? 'bg-red-900/60 text-red-300' : 'bg-emerald-900/60 text-emerald-300'}`;
  }

  // Applied to the *authoritative* stt_result broadcast from the server —
  // this is what actually fills in the Active Edit Zone and arms auto-send.
  function applyIncomingSttResult(entry) {
    if (!entry) return;
    el.activeOriginalInput.value = entry.filtered ?? entry.original ?? '';
    el.activeTranslatedInput.value = entry.translated ?? '';
    if (entry.translationError) {
      toast(`Translation failed (${entry.translationError}) — showing original text for Overlay 2.`, 'warn');
    }
    if (typeof entry.confidence === 'number') updateConfidenceBadge(entry.confidence);
    if (!entry.filtered) return; // skipped due to low confidence + "skip" policy — nothing to auto-send

    // Overlay 1 gets the authoritative (server-masked/censored) original text
    // as soon as each sentence completes — a short delay (the ~1s silence
    // wait, nothing more), independent of the Send-Both auto-send countdown
    // below. That countdown exists to let the operator review/edit the
    // *translation* before it airs; the original shouldn't be gated behind
    // that same wait. This fires whether or not "Live Overlay 1" is on: in
    // live mode it's a final confirmation of what was already streaming in
    // word-by-word; with live mode off, this IS how Overlay 1 gets updated.
    pushOverlay1Immediate(entry.filtered);

    state.autoSendArmed = true;
    startAutoSendTimer();
  }

  // ------------------------------------------------------------------
  // Audio device enumeration + level meter
  // ------------------------------------------------------------------
  const VIRTUAL_CABLE_PATTERN = /cable|vb-audio|voicemeeter|loopback|stereo mix/i;

  async function populateAudioDevices() {
    try {
      const previousSelection = el.audioDeviceSelect.value;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === 'audioinput');

      inputs.sort((a, b) => {
        const aCable = VIRTUAL_CABLE_PATTERN.test(a.label) ? 0 : 1;
        const bCable = VIRTUAL_CABLE_PATTERN.test(b.label) ? 0 : 1;
        return aCable - bCable;
      });

      el.audioDeviceSelect.innerHTML = '';
      inputs.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        const isCable = VIRTUAL_CABLE_PATTERN.test(d.label);
        opt.textContent = d.label ? (isCable ? `🎚️ ${d.label} (vMix audio)` : d.label) : `Audio Input ${i + 1}`;
        el.audioDeviceSelect.appendChild(opt);
      });

      if (inputs.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = 'No audio input devices found';
        opt.value = '';
        el.audioDeviceSelect.appendChild(opt);
      } else if (previousSelection && inputs.some((d) => d.deviceId === previousSelection)) {
        el.audioDeviceSelect.value = previousSelection;
      }

      const hasCableDevice = inputs.some((d) => VIRTUAL_CABLE_PATTERN.test(d.label));
      if (inputs.length > 0 && !hasCableDevice && !state.warnedNoCable) {
        state.warnedNoCable = true;
        toast('No VB-Audio Virtual Cable device detected. To caption vMix\'s program audio (not just a mic), install VB-Cable, route vMix\'s audio output to "CABLE Input", then select "CABLE Output" here.', 'info');
      }
    } catch (err) {
      toast('Could not enumerate audio devices: ' + err.message, 'error');
    }
  }

  function startLevelMeter(stream) {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = state.audioCtx.createMediaStreamSource(stream);
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 512;
    source.connect(state.analyser);
    const data = new Uint8Array(state.analyser.frequencyBinCount);

    const loop = () => {
      state.analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length;
      const scale = Math.min(1, avg / 100);
      el.levelMeter.style.transform = `scaleX(${scale})`;
      state.levelRAF = requestAnimationFrame(loop);
    };
    loop();
  }

  function stopLevelMeter() {
    if (state.levelRAF) cancelAnimationFrame(state.levelRAF);
    state.levelRAF = null;
    if (state.audioCtx) { state.audioCtx.close().catch(() => {}); state.audioCtx = null; }
    el.levelMeter.style.transform = 'scaleX(0)';
  }

  // ------------------------------------------------------------------
  // Speech recognition
  // ------------------------------------------------------------------
  function getRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function buildRecognition() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return null;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = el.sourceLangSelect.value || 'en-US'; // manually selected via the Source Speech Language dropdown
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const alt = result[0];
        const text = alt.transcript.trim();
        if (!text) continue;
        const rawConf = alt.confidence;
        const confidencePct = rawConf > 0 ? Math.round(rawConf * 100) : 100;

        if (result.isFinal) {
          appendToSentenceBuffer(text, confidencePct);
        } else {
          state.interimText = text;
          updateOriginalPreview();
          updateConfidenceBadge(confidencePct);
        }
      }

      // Any recognition activity means the speaker is still going — push the
      // silence-flush deadline out. The sentence is only considered "done"
      // once this timer is allowed to actually fire (see scheduleSilenceFlush).
      scheduleSilenceFlush();

      // Safety valve: an uninterrupted run-on longer than maxBufferMs flushes
      // anyway, so one very long sentence without a natural pause doesn't
      // leave Overlay 1/2 stale indefinitely.
      if (state.sentenceBuffer && Date.now() - state.bufferStartTime > state.maxBufferMs) {
        flushSentenceBuffer();
      }
    };

    rec.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        toast('Microphone permission denied — cannot run speech recognition.', 'error');
        state.shouldBeListening = false;
        setMicUiListening(false);
        return;
      }
      toast(`Speech recognition error: ${event.error}`, 'warn');
    };

    rec.onend = () => {
      state.listening = false;
      if (state.shouldBeListening) {
        // Note: the sentence buffer is intentionally NOT cleared here — it's
        // keyed on accumulated text, not on Chrome's internal resultIndex, so
        // it survives this restart cleanly and just keeps growing until the
        // silence timer (also untouched by the restart) decides it's done.
        clearTimeout(state.recognitionRestartTimer);
        state.recognitionRestartTimer = setTimeout(() => {
          try { rec.start(); state.listening = true; } catch (err) { /* already starting */ }
        }, 250);
      }
    };

    return rec;
  }

  // ------------------------------------------------------------------
  // Sentence-level buffering
  //
  // Chrome's own SpeechRecognition segmentation fires `isFinal` on very
  // short internal pauses — that's what was producing 1-2 word fragments
  // ("in", "a stately") getting pushed straight to Overlay 1. Instead of
  // treating each Chrome-finalized fragment as a complete sentence, we
  // accumulate them here and only flush (i.e. actually translate + fill the
  // Edit Zone) once ~1s of real silence follows.
  // ------------------------------------------------------------------
  function updateOriginalPreview() {
    const combined = [state.sentenceBuffer, state.interimText].filter(Boolean).join(' ');
    el.activeOriginalInput.value = combined;
    maybeLivePushOverlay1(combined);
  }

  // ------------------------------------------------------------------
  // Live Overlay 1 push — pushes the ORIGINAL text to vMix continuously as
  // it's recognized (true real-time captioning), independent of the
  // silence-based sentence buffering used for translation/Overlay 2. This
  // is opt-in via the "⚡ Live Overlay 1" checkbox: Overlay 1 updates on
  // every recognized word, while Overlay 2 (translation) still only updates
  // once a full sentence is ready — translating a half-formed sentence
  // isn't meaningful, but showing the original as it's spoken is exactly
  // what live captioning should look like.
  // ------------------------------------------------------------------
  function maybeLivePushOverlay1(text) {
    if (!el.liveOverlay1Toggle.checked) return;
    const trimmed = (text || '').trim();
    if (!trimmed || trimmed === state.lastLiveOverlay1Text) return;
    const now = Date.now();
    if (now - state.lastLiveOverlay1Send < state.liveOverlay1ThrottleMs) return;
    state.lastLiveOverlay1Send = now;
    state.lastLiveOverlay1Text = trimmed;

    const targets = currentOverlayTargets();
    wsSend({
      type: 'send_overlay', requestId: crypto.randomUUID(), target: 'overlay1',
      value: trimmed, input: targets.overlay1Input, selectedName: targets.overlay1SelectedName,
      language: el.targetLangSelect.value,
    });
  }

  // Pushes the finalized/authoritative original text to Overlay 1 once per
  // completed sentence — shares the same dedupe state as sendToOverlay so a
  // manual "Send Overlay 1"/"Send Both" click right after this won't
  // needlessly re-send byte-for-byte identical content.
  function pushOverlay1Immediate(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    const signature = normalizeForDedupe(trimmed);
    const now = Date.now();
    if (signature === state.lastSentSignatureOverlay1 && now - state.lastSentTimeOverlay1 < state.sendDedupeWindowMs) {
      return;
    }
    state.lastSentSignatureOverlay1 = signature;
    state.lastSentTimeOverlay1 = now;

    const targets = currentOverlayTargets();
    const requestId = crypto.randomUUID();
    const payload = { target: 'overlay1', value: trimmed, input: targets.overlay1Input, selectedName: targets.overlay1SelectedName, language: el.targetLangSelect.value };
    const sent = wsSend({ type: 'send_overlay', requestId, ...payload });
    if (!sent) {
      fetch('/api/vmix/overlay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then((r) => r.json())
        .then((data) => { if (!data.ok) toast(`Overlay 1 send failed: ${data.error}`, 'error'); })
        .catch((err) => toast('Overlay 1 send failed: ' + err.message, 'error'));
    }
  }

  function appendToSentenceBuffer(text, confidencePct) {
    // Guards against Chrome re-firing the exact same finalized fragment
    // immediately after one of its internal restarts, which would otherwise
    // duplicate that word/phrase inside the sentence buffer.
    const fragSignature = normalizeForDedupe(text);
    const now = Date.now();
    if (fragSignature && fragSignature === state.lastFragmentSignature && now - state.lastFragmentTime < state.fragmentDedupeWindowMs) {
      return;
    }
    state.lastFragmentSignature = fragSignature;
    state.lastFragmentTime = now;

    if (!state.sentenceBuffer) state.bufferStartTime = now;
    state.sentenceBuffer = state.sentenceBuffer ? `${state.sentenceBuffer} ${text}` : text;
    state.sentenceConfidences.push(confidencePct);
    state.interimText = ''; // this fragment is now committed; nothing "in progress" left over
    updateOriginalPreview();
    updateConfidenceBadge(confidencePct);
  }

  function scheduleSilenceFlush() {
    clearTimeout(state.silenceFlushTimer);
    state.silenceFlushTimer = setTimeout(() => {
      flushSentenceBuffer();
    }, state.silenceFlushDelayMs);
  }

  function flushSentenceBuffer() {
    clearTimeout(state.silenceFlushTimer);
    state.silenceFlushTimer = null;

    // Fold in any still-interim tail too — a real pause means that partial
    // word/phrase is effectively done even if Chrome never finalized it.
    const fullText = [state.sentenceBuffer, state.interimText].filter(Boolean).join(' ').trim();
    const confidences = state.sentenceConfidences;
    state.sentenceBuffer = '';
    state.interimText = '';
    state.sentenceConfidences = [];
    if (!fullText) return; // silence with nothing accumulated — nothing to send

    const confidencePct = confidences.length > 0
      ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length)
      : 100;

    handleCompletedSentence(fullText, confidencePct);
  }

  function handleCompletedSentence(text, confidencePct) {
    // Sentence-level dedupe: refuse to re-send an identical completed
    // sentence within a short cooldown (defense in depth on top of the
    // fragment-level guard above).
    const signature = normalizeForDedupe(text);
    const now = Date.now();
    if (signature && signature === state.lastSentenceSignature && now - state.lastSentenceTime < state.sentenceDedupeWindowMs) {
      return;
    }
    state.lastSentenceSignature = signature;
    state.lastSentenceTime = now;

    updateConfidenceBadge(confidencePct);

    const targetLang = el.targetLangSelect.value;
    // The server owns confidence-masking, profanity filtering, and
    // translation for the authoritative entry — see applyIncomingSttResult(),
    // which fills BOTH boxes together once the 'stt_result' broadcast comes
    // back, keeping Overlay 1 (original) and Overlay 2 (translated) in sync.
    wsSend({ type: 'stt_final', text, confidence: confidencePct, targetLang, isFinal: true });
  }

  function setMicUiListening(isListening) {
    el.micToggleBtn.textContent = isListening ? '⏹ Stop Listening' : '▶ Start Listening';
    el.micToggleBtn.className = `px-3 py-1.5 rounded text-xs font-medium transition ${isListening ? 'bg-red-600 hover:bg-red-500' : 'bg-emerald-600 hover:bg-emerald-500'}`;
  }

  async function startListening() {
    if (!getRecognitionCtor()) {
      toast('This browser does not support the Web Speech API. Use Chrome/Edge, or wire in a cloud STT provider.', 'error');
      return;
    }
    try {
      const deviceId = el.audioDeviceSelect.value || undefined;
      const constraints = { audio: deviceId ? { deviceId: { exact: deviceId } } : true };
      state.micStream = await navigator.mediaDevices.getUserMedia(constraints);
      startLevelMeter(state.micStream);
      populateAudioDevices();
    } catch (err) {
      toast('Could not access microphone/audio input: ' + err.message, 'error');
      return;
    }

    state.recognition = buildRecognition();
    if (!state.recognition) return;
    state.shouldBeListening = true;
    try {
      state.recognition.start();
      state.listening = true;
      setMicUiListening(true);
      toast('Listening started.', 'success');
    } catch (err) {
      toast('Failed to start speech recognition: ' + err.message, 'error');
    }
  }

  function stopListening() {
    state.shouldBeListening = false;
    clearTimeout(state.recognitionRestartTimer);
    clearTimeout(state.silenceFlushTimer);
    state.silenceFlushTimer = null;
    if (state.recognition) {
      try { state.recognition.stop(); } catch (err) { /* ignore */ }
    }
    if (state.micStream) {
      state.micStream.getTracks().forEach((t) => t.stop());
      state.micStream = null;
    }
    // Don't lose whatever was already recognized when the operator stops mid-sentence.
    if (state.sentenceBuffer || state.interimText) {
      flushSentenceBuffer();
    }
    stopLevelMeter();
    setMicUiListening(false);
    toast('Listening stopped.', 'info');
  }

  // ------------------------------------------------------------------
  // Google Cloud Speech-to-Text streaming mode ("Google Cloud Auto Multi-Language")
  //
  // Unlike Web Speech API mode (browser does everything locally, one fixed
  // `lang`), this mode captures raw 16-bit PCM audio via an AudioWorklet and
  // streams it to the server over the WebSocket as binary frames. The server
  // pipes it into Cloud Speech's streamingRecognize with a primary language
  // plus several alternativeLanguageCodes, so it can auto-detect code-
  // switching (e.g. Khmer mixed with English) within the same stream — the
  // Web Speech API has no equivalent capability.
  // ------------------------------------------------------------------
  async function startListeningGoogle() {
    if (!(state.ws && state.ws.readyState === WebSocket.OPEN)) {
      toast('WebSocket not connected — cannot start Google Cloud streaming yet. Try again in a moment.', 'error');
      return;
    }
    if (!(window.AudioWorklet)) {
      toast('This browser does not support AudioWorklet, required for Google Cloud streaming. Use a recent Chrome/Edge.', 'error');
      return;
    }
    try {
      const deviceId = el.audioDeviceSelect.value || undefined;
      const constraints = { audio: deviceId ? { deviceId: { exact: deviceId } } : true };
      state.micStream = await navigator.mediaDevices.getUserMedia(constraints);

      // A separate AudioContext specifically for PCM capture — the existing
      // level-meter AudioContext (started below) stays at the device's
      // native rate for visualization, so the two don't conflict.
      // IMPORTANT: we *request* 16000Hz, but browsers/OS audio drivers don't
      // always honor that — some silently keep the hardware's native rate
      // (commonly 48000Hz) instead. If we then told Google "this is 16kHz"
      // while it's actually 48kHz, the audio is undecodable and Google STT
      // returns nothing at all — no error, just silence, which looks exactly
      // like "I turned it on and nothing happens." So we read back the
      // context's ACTUAL sampleRate after creation and tell the server that.
      state.googleAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const actualSampleRate = state.googleAudioCtx.sampleRate;
      if (actualSampleRate !== 16000) {
        toast(`Mic is running at ${actualSampleRate}Hz instead of the requested 16000Hz — using the actual rate so Google STT decodes correctly.`, 'info');
      }
      await state.googleAudioCtx.audioWorklet.addModule('/pcm-worklet-processor.js');
      const source = state.googleAudioCtx.createMediaStreamSource(state.micStream);
      state.googleWorkletNode = new AudioWorkletNode(state.googleAudioCtx, 'pcm-capture-processor');
      state.googleWorkletNode.port.onmessage = (event) => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(event.data); // raw ArrayBuffer of 16-bit PCM samples
        }
      };
      source.connect(state.googleWorkletNode);
      startLevelMeter(state.micStream);
      populateAudioDevices();
    } catch (err) {
      toast('Could not start Google Cloud audio capture: ' + err.message, 'error');
      stopListeningGoogle();
      return;
    }

    const primaryLang = el.sourceLangSelect.value || 'en-US';
    wsSend({ type: 'start_google_stream', sourceLangs: [primaryLang], targetLang: el.targetLangSelect.value, sampleRateHertz: state.googleAudioCtx.sampleRate, lockLanguage: el.lockLanguageToggle.checked });

    state.shouldBeListening = true;
    state.listening = true;
    setMicUiListening(true);
    toast('Google Cloud streaming started.', 'success');
  }

  function stopListeningGoogle() {
    state.shouldBeListening = false;
    state.listening = false;
    wsSend({ type: 'stop_google_stream' });
    if (state.googleWorkletNode) {
      state.googleWorkletNode.port.onmessage = null;
      try { state.googleWorkletNode.disconnect(); } catch (err) { /* ignore */ }
      state.googleWorkletNode = null;
    }
    if (state.googleAudioCtx) {
      state.googleAudioCtx.close().catch(() => {});
      state.googleAudioCtx = null;
    }
    if (state.micStream) {
      state.micStream.getTracks().forEach((t) => t.stop());
      state.micStream = null;
    }
    stopLevelMeter();
    setMicUiListening(false);
    toast('Google Cloud streaming stopped.', 'info');
  }

  function setSttMode(mode) {
    if (state.listening || state.shouldBeListening) {
      toast('Stop listening before switching STT mode.', 'warn');
      return;
    }
    state.sttMode = mode;
    const isGoogle = mode === 'google';
    el.sttModeBtn.className = `px-2.5 py-1 rounded text-xs border transition ${isGoogle ? 'border-accent bg-accent text-slate-900 font-medium' : 'border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300'}`;
    el.sttModeBtn.textContent = isGoogle ? '🌐 Google Cloud Auto Multi-Language (ON)' : '🌐 Google Cloud Auto Multi-Language';
    // Web Speech mode reads rec.lang from this dropdown directly; Google mode
    // sends it as the primary languageCode (server adds configured alternates).
    el.sourceLangSelect.title = isGoogle
      ? 'Primary language for Google Cloud STT (alternates are configured server-side)'
      : 'Source language for the browser\'s Web Speech API';
  }

  el.sttModeBtn.addEventListener('click', () => {
    setSttMode(state.sttMode === 'google' ? 'webspeech' : 'google');
  });

  // ------------------------------------------------------------------
  // Auto-send countdown — fires "Send Both" when it expires
  // ------------------------------------------------------------------
  const RING_CIRCUMFERENCE = 2 * Math.PI * 15.9;

  function startAutoSendTimer() {
    clearAutoSendTimer();
    if (!el.autoSendToggle.checked) return;

    state.autoSendCancelled = false;
    const delayMs = (state.settings.autoSendDelaySec || 3) * 1000;
    state.autoSendDeadline = Date.now() + delayMs;
    el.cancelAutoBtn.disabled = false;

    state.autoSendInterval = setInterval(() => {
      const remaining = state.autoSendDeadline - Date.now();
      const pct = Math.max(0, remaining / delayMs);
      el.countdownRing.setAttribute('stroke-dasharray', `${RING_CIRCUMFERENCE}`);
      el.countdownRing.setAttribute('stroke-dashoffset', `${RING_CIRCUMFERENCE * (1 - pct)}`);
      el.countdownNum.textContent = Math.ceil(remaining / 1000);
      if (remaining <= 0) {
        clearAutoSendTimer();
        // autoSendArmed is what actually prevents a re-fire: only the first
        // firing for a given piece of content goes out, even if this
        // interval somehow ticked past zero more than once.
        if (!state.autoSendCancelled && state.autoSendArmed) sendToOverlay('both', 'auto');
      }
    }, 100);
  }

  function clearAutoSendTimer() {
    if (state.autoSendInterval) clearInterval(state.autoSendInterval);
    state.autoSendInterval = null;
    el.countdownNum.textContent = '';
    el.countdownRing.setAttribute('stroke-dashoffset', '0');
    el.cancelAutoBtn.disabled = true;
  }

  // Any manual edit to either box cancels the pending auto-send — the
  // operator taking the wheel should never get overridden by a timer — and
  // re-arms sending, since the content has now genuinely changed.
  [el.activeOriginalInput, el.activeTranslatedInput].forEach((box) => {
    box.addEventListener('input', () => {
      state.autoSendArmed = true;
      if (state.autoSendInterval) {
        state.autoSendCancelled = true;
        clearAutoSendTimer();
      }
    });
  });

  el.cancelAutoBtn.addEventListener('click', () => {
    state.autoSendCancelled = true;
    clearAutoSendTimer();
    toast('Auto-send cancelled.', 'info');
  });

  // ------------------------------------------------------------------
  // Sending to vMix (per overlay, or both — synchronized)
  // ------------------------------------------------------------------
  function currentOverlayTargets() {
    return {
      overlay1Input: el.overlay1Input.value || state.config.overlay1DefaultInput,
      overlay1SelectedName: el.overlay1SelectedName.value || state.config.overlay1DefaultSelectedName,
      overlay2Input: el.overlay2Input.value || state.config.overlay2DefaultInput,
      overlay2SelectedName: el.overlay2SelectedName.value || state.config.overlay2DefaultSelectedName,
    };
  }

  // Sends Overlay 1 (original) and Overlay 2 (translated) as ONE request, so
  // the server can fire both vMix SetText calls in the same Promise.all tick
  // — this is what actually keeps them synchronized. The previous approach
  // (awaiting sendToOverlay('overlay1') then sendToOverlay('overlay2')
  // sequentially) serialized two full network round trips and could
  // visibly desync the two captions on screen.
  async function sendBothToOverlays(trigger) {
    const originalValue = el.activeOriginalInput.value.trim();
    const translatedValue = el.activeTranslatedInput.value.trim();
    if (!originalValue && !translatedValue) { toast('Nothing to send.', 'warn'); return; }

    const now = Date.now();
    const sig1 = normalizeForDedupe(originalValue);
    const sig2 = normalizeForDedupe(translatedValue);
    const dup1 = !originalValue || (sig1 === state.lastSentSignatureOverlay1 && now - state.lastSentTimeOverlay1 < state.sendDedupeWindowMs);
    const dup2 = !translatedValue || (sig2 === state.lastSentSignatureOverlay2 && now - state.lastSentTimeOverlay2 < state.sendDedupeWindowMs);
    if (dup1 && dup2) return; // identical content already sent to both — ignore the repeat
    if (originalValue) { state.lastSentSignatureOverlay1 = sig1; state.lastSentTimeOverlay1 = now; }
    if (translatedValue) { state.lastSentSignatureOverlay2 = sig2; state.lastSentTimeOverlay2 = now; }

    const payload = {
      original: originalValue,
      translated: translatedValue,
      ...currentOverlayTargets(),
      language: el.targetLangSelect.value,
    };

    const requestId = crypto.randomUUID();
    const sentOverWs = wsSend({ type: 'send_both', requestId, ...payload });
    if (sentOverWs) {
      // Wait for the server's confirmation so callers (e.g. the auto-send
      // timer) know the synchronized send actually completed before moving on.
      await new Promise((resolve) => {
        state.pendingSendBoth.set(requestId, { resolve });
        setTimeout(() => { if (state.pendingSendBoth.has(requestId)) { state.pendingSendBoth.delete(requestId); resolve(null); } }, 5000);
      });
    } else {
      try {
        const resp = await fetch('/api/vmix/both', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await resp.json();
        if (!data.ok) toast(`Synchronized send failed: ${data.overlay1?.error || data.overlay2?.error || 'unknown error'}`, 'error');
      } catch (err) {
        toast('Synchronized send failed: ' + err.message, 'error');
      }
    }
    toast(trigger === 'auto' ? 'Auto-sent (synchronized) to both overlays.' : 'Sent (synchronized) to both overlays.', 'success');
  }

  async function sendToOverlay(target, trigger = 'manual') {
    if (target === 'both') {
      state.autoSendArmed = false;
      await sendBothToOverlays(trigger);
      // Clear once both parts of "Both" have gone out — this is what stops a
      // stray repeat from resending identical content (nothing left to send).
      el.activeOriginalInput.value = '';
      el.activeTranslatedInput.value = '';
      resetConfidenceBadge();
      return;
    }

    const isOverlay1 = target === 'overlay1';
    const value = (isOverlay1 ? el.activeOriginalInput.value : el.activeTranslatedInput.value).trim();
    const overlayLabel = isOverlay1 ? 'Overlay 1' : 'Overlay 2';
    if (!value) { toast(`Nothing to send to ${overlayLabel}.`, 'warn'); return; }

    // Per-overlay dedupe: refuse to re-send byte-for-byte identical content
    // to the SAME overlay within a short cooldown, independent of trigger.
    const signature = normalizeForDedupe(value);
    const now = Date.now();
    const lastSig = isOverlay1 ? state.lastSentSignatureOverlay1 : state.lastSentSignatureOverlay2;
    const lastTime = isOverlay1 ? state.lastSentTimeOverlay1 : state.lastSentTimeOverlay2;
    if (signature === lastSig && now - lastTime < state.sendDedupeWindowMs) {
      return;
    }
    if (isOverlay1) { state.lastSentSignatureOverlay1 = signature; state.lastSentTimeOverlay1 = now; }
    else { state.lastSentSignatureOverlay2 = signature; state.lastSentTimeOverlay2 = now; }

    const targets = currentOverlayTargets();
    const input = isOverlay1 ? targets.overlay1Input : targets.overlay2Input;
    const selectedName = isOverlay1 ? targets.overlay1SelectedName : targets.overlay2SelectedName;
    const language = el.targetLangSelect.value;

    const requestId = crypto.randomUUID();
    const sentOverWs = wsSend({ type: 'send_overlay', requestId, target, value, input, selectedName, language });
    if (!sentOverWs) {
      try {
        const resp = await fetch('/api/vmix/overlay', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, value, input, selectedName, language }),
        });
        const data = await resp.json();
        if (!data.ok) toast(`${overlayLabel} send failed: ${data.error}`, 'error');
      } catch (err) {
        toast(`${overlayLabel} send failed: ${err.message}`, 'error');
      }
    }
    toast(`${trigger === 'auto' ? 'Auto-sent' : 'Sent'} to ${overlayLabel}.`, 'success');
  }

  el.sendOverlay1Btn.addEventListener('click', () => {
    state.autoSendCancelled = true;
    clearAutoSendTimer();
    sendToOverlay('overlay1', 'manual');
  });

  el.sendOverlay2Btn.addEventListener('click', () => {
    state.autoSendCancelled = true;
    clearAutoSendTimer();
    sendToOverlay('overlay2', 'manual');
  });

  el.sendBothBtn.addEventListener('click', () => {
    state.autoSendCancelled = true;
    clearAutoSendTimer();
    sendToOverlay('both', 'manual');
  });

  el.clearZoneBtn.addEventListener('click', () => {
    state.autoSendCancelled = true;
    state.autoSendArmed = false;
    clearAutoSendTimer();
    el.activeOriginalInput.value = '';
    el.activeTranslatedInput.value = '';
    resetConfidenceBadge();
  });

  el.forceClearBtn.addEventListener('click', async () => {
    try {
      const resp = await fetch('/api/vmix/clear', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'both', ...currentOverlayTargets() }),
      });
      const data = await resp.json();
      console.log('vMix clear result:', data); // useful when diagnosing "clear didn't seem to do anything"
      if (data.ok) toast('Cleared both overlays on vMix.', 'success');
      else toast('Clear failed on one or both overlays — see console.', 'error');
    } catch (err) {
      toast('Clear failed: ' + err.message, 'error');
    }
  });

  // Sends a fixed test string directly, bypassing STT/translation entirely —
  // if this doesn't visibly appear in vMix, the Input/SelectedName above
  // don't match anything real (vMix's SetText API returns success even when
  // the name doesn't match anything, so log/toast success alone can't tell
  // you that — you have to actually look at vMix to confirm).
  async function testOverlaySend(target) {
    const isOverlay1 = target === 'overlay1';
    const input = isOverlay1 ? el.overlay1Input.value : el.overlay2Input.value;
    const selectedName = isOverlay1 ? el.overlay1SelectedName.value : el.overlay2SelectedName.value;
    const value = `TEST — ${isOverlay1 ? 'Overlay 1' : 'Overlay 2'} OK (${new Date().toLocaleTimeString()})`;
    try {
      const resp = await fetch('/api/vmix/overlay', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, value, input, selectedName }),
      });
      const data = await resp.json();
      console.log(`Test send to ${target} (Input="${input}", SelectedName="${selectedName}"):`, data);
      if (data.ok) toast(`Test sent to ${input || '(default)'} / ${selectedName || '(default)'} — check vMix now.`, 'success');
      else toast(`Test send failed: ${data.error}`, 'error');
    } catch (err) {
      toast('Test send failed: ' + err.message, 'error');
    }
  }
  el.testOverlay1Btn.addEventListener('click', () => testOverlaySend('overlay1'));
  el.testOverlay2Btn.addEventListener('click', () => testOverlaySend('overlay2'));

  document.querySelectorAll('.overlay-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const fn = btn.dataset.fn;
      const target = btn.dataset.target; // 'overlay1' | 'overlay2'
      // This Input is what actually determines WHICH vMix input gets pushed
      // into that overlay channel — omitting it (the previous bug) made
      // vMix fall back to whatever was already active, so "Overlay 2 In"
      // never visibly did anything different from "Overlay 1 In".
      const input = target === 'overlay1'
        ? (el.overlay1Input.value || state.config.overlay1DefaultInput)
        : target === 'overlay2'
          ? (el.overlay2Input.value || state.config.overlay2DefaultInput)
          : undefined;
      try {
        const resp = await fetch('/api/vmix/function', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ function: fn, input }),
        });
        const data = await resp.json();
        if (data.ok) toast(`${fn}${input ? ' (' + input + ')' : ''} sent.`, 'success');
        else toast(`${fn} failed: ${data.error}`, 'error');
      } catch (err) {
        toast(`${fn} failed: ${err.message}`, 'error');
      }
    });
  });

  // ------------------------------------------------------------------
  // ON AIR panel (two independent rows — Overlay 1 / Overlay 2)
  // ------------------------------------------------------------------
  function updateOnAirRow(dotEl, textEl, tsEl, data, label) {
    if (!data) return;
    textEl.textContent = data.text || '—';
    if (data.timestamp) {
      tsEl.textContent = `Sent ${new Date(data.timestamp).toLocaleTimeString()}${data.source ? ' → ' + data.source : ''}`;
      dotEl.className = 'w-2 h-2 rounded-full bg-onair onair-live';
    } else {
      tsEl.textContent = 'Not sent yet';
      dotEl.className = 'w-2 h-2 rounded-full bg-slate-700';
    }
  }

  function updateOnAirPanel(onAir) {
    if (!onAir) return;
    updateOnAirRow(el.onAirDot1, el.onAirText1, el.onAirTimestamp1, onAir.overlay1, 'Overlay 1');
    updateOnAirRow(el.onAirDot2, el.onAirText2, el.onAirTimestamp2, onAir.overlay2, 'Overlay 2');
  }

  // ------------------------------------------------------------------
  // vMix connection status polling
  // ------------------------------------------------------------------
  async function pollVmixStatus() {
    try {
      const resp = await fetch('/api/vmix/status');
      const data = await resp.json();
      el.vmixDot.className = `w-1.5 h-1.5 rounded-full ${data.connected ? 'bg-emerald-400' : 'bg-red-500'}`;
      el.vmixLabel.textContent = data.connected ? 'vMix: connected' : 'vMix: unreachable';
      el.vmixLabel.title = data.detail || '';
    } catch (err) {
      el.vmixDot.className = 'w-1.5 h-1.5 rounded-full bg-red-500';
      el.vmixLabel.textContent = 'vMix: error';
    }
  }

  // ------------------------------------------------------------------
  // Quick phrases
  // ------------------------------------------------------------------
  function renderQuickPhrases() {
    el.quickPhrases.innerHTML = '';
    state.settings.quickPhrases.forEach((qp) => {
      const btn = document.createElement('button');
      btn.className = 'px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-xs transition';
      btn.textContent = qp.label;
      btn.addEventListener('click', () => {
        state.autoSendCancelled = true;
        state.autoSendArmed = true;
        clearAutoSendTimer();
        el.activeOriginalInput.value = qp.text;
        el.activeTranslatedInput.value = qp.text;
      });
      el.quickPhrases.appendChild(btn);
    });
  }

  // ------------------------------------------------------------------
  // Settings modal
  // ------------------------------------------------------------------
  el.settingsBtn.addEventListener('click', () => {
    el.wsUrlInput.value = state.settings.wsUrl || '';
    el.autoSendDelayInput.value = state.settings.autoSendDelaySec;
    el.settingsModal.classList.remove('hidden');
    el.settingsModal.classList.add('flex');
  });
  el.closeSettingsBtn.addEventListener('click', () => {
    el.settingsModal.classList.add('hidden');
    el.settingsModal.classList.remove('flex');
  });
  el.addPhraseBtn.addEventListener('click', () => {
    const raw = el.newPhraseInput.value.trim();
    if (!raw.includes('|')) { toast('Format: Label|Phrase text', 'warn'); return; }
    const [label, ...rest] = raw.split('|');
    state.settings.quickPhrases.push({ label: label.trim(), text: rest.join('|').trim() });
    el.newPhraseInput.value = '';
    renderQuickPhrases();
  });
  el.saveSettingsBtn.addEventListener('click', () => {
    state.settings.wsUrl = el.wsUrlInput.value.trim() || null;
    state.settings.autoSendDelaySec = Math.max(1, parseInt(el.autoSendDelayInput.value, 10) || 3);
    el.autoSendDelayLabel.textContent = state.settings.autoSendDelaySec;
    persistSettings();
    el.settingsModal.classList.add('hidden');
    el.settingsModal.classList.remove('flex');
    toast('Settings saved. Reconnecting WebSocket…', 'info');
    // Clean handoff: detach the old socket's listeners and reset any pending
    // reconnect timer *before* opening the new one, so we never end up with
    // two live sockets both delivering the same broadcast.
    disconnectWs();
    clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = null;
    state.wsReconnectAttempts = 0;
    connectWs();
  });

  // ------------------------------------------------------------------
  // Misc bindings
  // ------------------------------------------------------------------
  el.micToggleBtn.addEventListener('click', () => {
    const isActive = state.listening || state.shouldBeListening;
    if (state.sttMode === 'google') {
      isActive ? stopListeningGoogle() : startListeningGoogle();
    } else {
      isActive ? stopListening() : startListening();
    }
  });

  el.clearLogBtn.addEventListener('click', () => {
    el.logStream.innerHTML = '';
    state.sttEntries = [];
  });

  el.minConfidenceInput.addEventListener('input', () => {
    el.minConfidenceValue.textContent = el.minConfidenceInput.value;
  });

  el.overlay1Input.addEventListener('change', persistOverlayTargets);
  el.overlay1SelectedName.addEventListener('change', persistOverlayTargets);
  el.overlay2Input.addEventListener('change', persistOverlayTargets);
  el.overlay2SelectedName.addEventListener('change', persistOverlayTargets);

  el.sourceLangSelect.addEventListener('change', () => {
    localStorage.setItem('stt_source_lang', el.sourceLangSelect.value);
  });

  navigator.mediaDevices?.addEventListener?.('devicechange', populateAudioDevices);

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------
  async function init() {
    loadSettings();
    setTargetLang(el.targetLangSelect.value || 'km');
    setSttMode('webspeech');
    el.autoSendDelayLabel.textContent = state.settings.autoSendDelaySec;
    renderQuickPhrases();
    await loadConfig();
    await populateAudioDevices();
    connectWs();
    pollVmixStatus();
    setInterval(pollVmixStatus, 5000);

    if (!getRecognitionCtor()) {
      toast('Web Speech API not supported in this browser — mic capture/level meter still work, but live transcription requires Chrome/Edge or a cloud STT integration.', 'warn');
    }
  }

  window.addEventListener('DOMContentLoaded', init);
  window.addEventListener('beforeunload', () => {
    if (state.listening) {
      state.sttMode === 'google' ? stopListeningGoogle() : stopListening();
    }
  });
})();