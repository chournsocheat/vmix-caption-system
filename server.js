/**
 * server.js
 * Real-Time Live Captioning, Translation, and Quality Control System for vMix
 *
 * Responsibilities:
 *  - Serve the operator dashboard (public/)
 *  - Broker real-time state between operator dashboard(s) over WebSocket
 *  - Own the STT -> QC -> Translation pipeline: a client sends the raw
 *    recognized text as 'stt_final' with a target language, and this server
 *    applies confidence masking + profanity filtering, translates it, and
 *    broadcasts the authoritative result back as 'stt_result' to every
 *    connected dashboard (single source of truth, no client/server drift).
 *  - Proxy vMix HTTP API calls for TWO independent overlay targets — Overlay 1
 *    (original speech) and Overlay 2 (translated text) — plus generic overlay
 *    channel triggers (OverlayInput1In/Out, etc).
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');

// Optional dependency — only required if the "Google Cloud Auto Multi-Language"
// STT mode is actually used. Loaded lazily/defensively so the rest of the app
// keeps working even if the package or credentials aren't set up yet.
//
// IMPORTANT: this uses the Speech-to-Text V2 API specifically (not V1). V1's
// classic models (default/latest_long/latest_short/command_and_search) do
// NOT support Khmer at all per Google's supported-languages table — Khmer
// streaming recognition is only available via the V2 API's Chirp 2 model,
// which requires a regional endpoint (asia-southeast1/us-central1/europe-west4)
// and a "recognizer" resource path built from your GCP project ID.
let SpeechClientCtorV2 = null;
try {
  SpeechClientCtorV2 = require('@google-cloud/speech').v2.SpeechClient;
} catch (err) {
  // Not installed — Google Cloud STT mode will report a clear error when used.
}

// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------
const CONFIG = {
  port: parseInt(process.env.PORT, 10) || 3000,
  corsOrigin: process.env.CORS_ORIGIN || '*',

  vmixIp: process.env.VMIX_IP || '127.0.0.1',
  vmixPort: parseInt(process.env.VMIX_PORT, 10) || 8088,
  vmixUser: process.env.VMIX_USER || '',
  vmixPass: process.env.VMIX_PASS || '',
  vmixTimeoutMs: parseInt(process.env.VMIX_TIMEOUT_MS, 10) || 2500,
  vmixDefaultOverlayChannel: parseInt(process.env.VMIX_DEFAULT_OVERLAY_CHANNEL, 10) || 1,

  // Overlay 1 = original recognized speech. Falls back to the legacy
  // VMIX_DEFAULT_INPUT/SELECTED_NAME vars so existing .env files keep working.
  overlay1Input: process.env.VMIX_OVERLAY1_INPUT || process.env.VMIX_DEFAULT_INPUT || 'OriginalCaption',
  overlay1SelectedName: process.env.VMIX_OVERLAY1_SELECTED_NAME || process.env.VMIX_DEFAULT_SELECTED_NAME || 'Caption.Text',
  // Overlay 2 = translated text.
  overlay2Input: process.env.VMIX_OVERLAY2_INPUT || 'TranslatedCaption',
  overlay2SelectedName: process.env.VMIX_OVERLAY2_SELECTED_NAME || 'Caption.Text',

  translationProvider: (process.env.TRANSLATION_PROVIDER || 'libre').toLowerCase(),
  googleApiKey: process.env.GOOGLE_TRANSLATE_API_KEY || '',
  deeplApiKey: process.env.DEEPL_API_KEY || '',
  deeplApiUrl: process.env.DEEPL_API_URL || 'https://api-free.deepl.com/v2/translate',
  libreUrl: process.env.LIBRETRANSLATE_URL || 'https://libretranslate.com/translate',
  libreApiKey: process.env.LIBRETRANSLATE_API_KEY || '',

  minConfidence: parseInt(process.env.MIN_CONFIDENCE, 10) || 60,
  lowConfidenceAction: (process.env.LOW_CONFIDENCE_ACTION || 'mask').toLowerCase(), // mask | skip
  bannedWords: (process.env.BANNED_WORDS || '')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean),

  logLevel: process.env.LOG_LEVEL || 'info',
  maxLogHistory: parseInt(process.env.MAX_LOG_HISTORY, 10) || 500,

  // ---- Caption line-wrapping (prevents subtitles overrunning the video) ----
  captionMaxCharsPerLine: parseInt(process.env.CAPTION_MAX_CHARS_PER_LINE, 10) || 78,
  captionMaxLines: parseInt(process.env.CAPTION_MAX_LINES, 10) || 2,

  // ---- Google Cloud Speech-to-Text ("Google Cloud Auto Multi-Language" mode) ----
  // Auth is via GOOGLE_APPLICATION_CREDENTIALS (service-account JSON path),
  // read automatically by @google-cloud/speech — not stored here.
  //
  // Using the V2 API's Chirp 2 model specifically: per Google's own supported-
  // languages table, Khmer (km-KH) streaming recognition is NOT available
  // under any V1 model (default/latest_long/latest_short/command_and_search)
  // — only under V2's chirp/chirp_2 models, and only in certain regions.
  googleCloudSttAlternativeLangs: (process.env.GOOGLE_CLOUD_STT_ALTERNATIVE_LANGS || 'km-KH,en-US')
    .split(',').map((s) => s.trim()).filter(Boolean),
  googleCloudSttSampleRate: parseInt(process.env.GOOGLE_CLOUD_STT_SAMPLE_RATE, 10) || 16000,
  // Chirp 2 supports StreamingRecognize (plain "chirp" does not — it's
  // Recognize/BatchRecognize only). Documented GA regions are us-central1
  // and europe-west4; asia-southeast1 has appeared in Google's language
  // tables for Khmer but may require project allowlisting — if you get a
  // "not found"/"permission denied"/"invalid argument" error mentioning the
  // model or region, try GOOGLE_CLOUD_STT_REGION=us-central1 instead.
  googleCloudSttModel: process.env.GOOGLE_CLOUD_STT_MODEL || 'chirp_2',
  googleCloudSttRegion: process.env.GOOGLE_CLOUD_STT_REGION || 'asia-southeast1',
  // Required for the V2 API's "recognizer" resource path. If unset, the
  // server tries to auto-detect it from GOOGLE_APPLICATION_CREDENTIALS via
  // the client library — set this explicitly if that detection fails.
  googleCloudProjectId: process.env.GOOGLE_CLOUD_PROJECT_ID || '',
};

// ------------------------------------------------------------------
// Simple structured logger
// ------------------------------------------------------------------
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
function log(level, msg, meta) {
  if (LEVELS[level] > LEVELS[CONFIG.logLevel]) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(line, meta !== undefined ? meta : '');
}

// ------------------------------------------------------------------
// In-memory session state
// ------------------------------------------------------------------
const state = {
  logHistory: [], // { id, timestamp, original, filtered, translated, confidence, targetLang, status }
  onAir: {
    overlay1: { text: '', language: null, timestamp: null, source: null },
    overlay2: { text: '', language: null, timestamp: null, source: null },
  },
  vmixLastKnownGood: false,
};

// ------------------------------------------------------------------
// Profanity filter
// ------------------------------------------------------------------
function censorProfanity(text) {
  if (!text || CONFIG.bannedWords.length === 0) return text;
  let result = text;
  for (const word of CONFIG.bannedWords) {
    if (!word) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'gi');
    result = result.replace(re, (match) => '*'.repeat(match.length));
  }
  return result;
}

// ------------------------------------------------------------------
// Confidence-based masking
// ------------------------------------------------------------------
function applyConfidenceFilter(text, confidence, words) {
  const threshold = CONFIG.minConfidence;

  if (Array.isArray(words) && words.length > 0) {
    const rendered = words.map((w) => {
      const wc = typeof w.confidence === 'number' ? w.confidence : confidence;
      if (wc < threshold) {
        return CONFIG.lowConfidenceAction === 'skip' ? '' : '.....';
      }
      return w.word;
    });
    return rendered.filter((w) => w !== '').join(' ').replace(/\s+/g, ' ').trim() || (CONFIG.lowConfidenceAction === 'mask' ? '.....' : '');
  }

  if (typeof confidence === 'number' && confidence < threshold) {
    return CONFIG.lowConfidenceAction === 'skip' ? '' : '.....';
  }
  return text;
}

function normalizeForDedupe(text) {
  return (text || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
}
const STT_DEDUPE_WINDOW_MS = 2500;

// ------------------------------------------------------------------
// Caption line-wrapping — keeps long subtitles from running to 3-4 lines
// and covering the video. Wraps at word boundaries where the script uses
// spaces (en/fr/ar/ru/es); for scripts with no inter-word spacing (Khmer,
// Chinese) the whole sentence is effectively "one word", so it falls
// through to the grapheme-cluster hard-break path below. Using
// Intl.Segmenter (grapheme granularity) instead of raw string slicing
// matters specifically for Khmer: naive slicing can separate a base
// consonant from its combining vowel/diacritic mark, which renders broken.
// ------------------------------------------------------------------
function segmentGraphemes(str) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      return Array.from(seg.segment(str), (s) => s.segment);
    } catch (err) {
      // fall through to code-point splitting below
    }
  }
  return Array.from(str); // code-point fallback — not perfect for combining marks, but better than raw .slice()
}

function hardBreakChunk(chunk, maxCharsPerLine) {
  const graphemes = segmentGraphemes(chunk);
  const pieces = [];
  let current = '';
  for (const g of graphemes) {
    if (current && (current.length + g.length) > maxCharsPerLine) {
      pieces.push(current);
      current = g;
    } else {
      current += g;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function wrapText(text, maxCharsPerLine) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
      continue;
    }
    if (current) { lines.push(current); current = ''; }
    if (word.length <= maxCharsPerLine) {
      current = word;
    } else {
      // A single "word" longer than one line — either a genuinely long token,
      // or (commonly) an un-spaced Khmer/Chinese clause. Hard-break by grapheme.
      const pieces = hardBreakChunk(word, maxCharsPerLine);
      lines.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] || '';
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Wraps text to at most `maxLines` lines of `maxCharsPerLine` characters,
// truncating with an ellipsis if it still doesn't fit. This is applied only
// to the value actually sent to vMix — the Log Stream / Edit Zone always
// keep the full, untruncated text so the operator can see/edit everything.
function formatCaptionForOverlay(text, maxCharsPerLine, maxLines) {
  if (!text) return text;
  const perLine = maxCharsPerLine || CONFIG.captionMaxCharsPerLine;
  const lines = maxLines || CONFIG.captionMaxLines;
  const wrapped = wrapText(text.trim().replace(/\s+/g, ' '), perLine);
  if (wrapped.length <= lines) return wrapped.join('\n');

  const kept = wrapped.slice(0, lines);
  const ELLIPSIS = '…';
  let last = kept[lines - 1];
  const budget = Math.max(0, perLine - ELLIPSIS.length);
  if (last.length > budget) {
    last = segmentGraphemes(last).slice(0, budget).join('');
  }
  kept[lines - 1] = last.trimEnd() + ELLIPSIS;
  return kept.join('\n');
}

// ------------------------------------------------------------------
// vMix HTTP API client
// ------------------------------------------------------------------
const vmixClient = axios.create({ timeout: CONFIG.vmixTimeoutMs });

function vmixBaseUrl() {
  return `http://${CONFIG.vmixIp}:${CONFIG.vmixPort}/api/`;
}

function vmixAuthConfig() {
  if (CONFIG.vmixUser) {
    return { auth: { username: CONFIG.vmixUser, password: CONFIG.vmixPass || '' } };
  }
  return {};
}

async function vmixCall(params) {
  const url = vmixBaseUrl();
  try {
    const resp = await vmixClient.get(url, { params, ...vmixAuthConfig() });
    state.vmixLastKnownGood = true;
    return { ok: true, status: resp.status, data: typeof resp.data === 'string' ? resp.data.slice(0, 500) : resp.data };
  } catch (err) {
    state.vmixLastKnownGood = false;
    const detail = err.code === 'ECONNABORTED'
      ? `vMix request timed out after ${CONFIG.vmixTimeoutMs}ms — is vMix running and is the Web Controller enabled on port ${CONFIG.vmixPort}?`
      : err.code === 'ECONNREFUSED'
        ? `Connection refused by ${CONFIG.vmixIp}:${CONFIG.vmixPort} — check VMIX_IP/VMIX_PORT and that vMix Web Controller is on.`
        : err.message;
    log('warn', 'vMix call failed', { params, detail });
    return { ok: false, error: detail };
  }
}

async function vmixSetText(input, selectedName, value) {
  return vmixCall({ Function: 'SetText', Input: input, SelectedName: selectedName, Value: value });
}

async function vmixFunction(fn, input, value) {
  const params = { Function: fn };
  if (input !== undefined && input !== null && input !== '') params.Input = input;
  if (value !== undefined && value !== null && value !== '') params.Value = value;
  return vmixCall(params);
}

function overlayDefaults(target) {
  return target === 'overlay2'
    ? { input: CONFIG.overlay2Input, selectedName: CONFIG.overlay2SelectedName }
    : { input: CONFIG.overlay1Input, selectedName: CONFIG.overlay1SelectedName };
}

// ------------------------------------------------------------------
// Translation providers
// ------------------------------------------------------------------
// All keys are lowercase ISO 639-1 codes — every incoming target/source string is
// normalized with normLang() before it ever reaches these maps or a provider call.
// (Google Translate returns a 400 Bad Request on uppercase codes like "KM".)
const LANG_MAP_GOOGLE = { km: 'km', en: 'en', zh: 'zh-CN', fr: 'fr', ar: 'ar', ru: 'ru', es: 'es' };
// DeepL has no Khmer target as of writing; falls back to English for km.
const LANG_MAP_DEEPL = { km: 'EN-US', en: 'EN-US', zh: 'ZH', fr: 'FR', ar: 'EN-US', ru: 'RU', es: 'ES' };
const LANG_MAP_LIBRE = { km: 'km', en: 'en', zh: 'zh', fr: 'fr', ar: 'ar', ru: 'ru', es: 'es' };

// LibreTranslate is powered by Argos Translate, which — as of this writing —
// ships NO Khmer model at all (not "unsupported for some pairs", simply
// absent from https://docs.libretranslate.com/guides/supported_languages/).
// Requesting target=km against it always returns HTTP 400. Every other
// language this app offers (en, zh, fr, ar, ru, es) IS supported.
const LIBRE_SUPPORTED_LANGS = new Set([
  'sq', 'ar', 'az', 'bn', 'bg', 'ca', 'zh', 'cs', 'da', 'nl', 'en', 'eo', 'et', 'fi', 'fr',
  'de', 'el', 'he', 'hi', 'hu', 'id', 'ga', 'it', 'ja', 'ko', 'lv', 'lt', 'ms', 'fa', 'pl',
  'pt', 'ro', 'ru', 'sk', 'sl', 'es', 'sv', 'tl', 'th', 'tr', 'uk', 'ur',
]);

function normLang(code) {
  return (code || '').toString().trim().toLowerCase();
}

// Pulls the real reason out of an axios error — LibreTranslate/Google/DeepL
// all return a JSON body like {"error": "..."} on 4xx, which was previously
// being discarded in favor of the generic axios "Request failed with status
// code 400" message. This is what actually explains a failure in the logs.
function describeAxiosError(err) {
  if (err.response) {
    const body = err.response.data;
    const detail = typeof body === 'string' ? body.slice(0, 300) : (body?.error || JSON.stringify(body));
    return `HTTP ${err.response.status}: ${detail}`;
  }
  if (err.code === 'ECONNABORTED') return 'Request timed out';
  return err.message;
}

async function translateGoogle(text, target, source) {
  if (!CONFIG.googleApiKey) throw new Error('GOOGLE_TRANSLATE_API_KEY not configured');
  const url = 'https://translation.googleapis.com/language/translate/v2';
  try {
    const resp = await axios.post(
      url,
      null,
      {
        params: {
          key: CONFIG.googleApiKey,
          q: text,
          target: LANG_MAP_GOOGLE[target] || target,
          source: source ? (LANG_MAP_GOOGLE[source] || source) : undefined,
          format: 'text',
        },
        timeout: 5000,
      }
    );
    const translated = resp.data?.data?.translations?.[0]?.translatedText;
    if (!translated) throw new Error('Google Translate returned no translation');
    return translated;
  } catch (err) {
    if (err.response) throw new Error(describeAxiosError(err));
    throw err;
  }
}

async function translateDeepL(text, target, source) {
  if (!CONFIG.deeplApiKey) throw new Error('DEEPL_API_KEY not configured');
  try {
    const resp = await axios.post(
      CONFIG.deeplApiUrl,
      new URLSearchParams({
        auth_key: CONFIG.deeplApiKey,
        text,
        target_lang: LANG_MAP_DEEPL[target] || target.toUpperCase(),
        ...(source ? { source_lang: (LANG_MAP_DEEPL[source] || source.toUpperCase()).replace('-US', '') } : {}),
      }),
      { timeout: 5000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const translated = resp.data?.translations?.[0]?.text;
    if (!translated) throw new Error('DeepL returned no translation');
    return translated;
  } catch (err) {
    if (err.response) throw new Error(describeAxiosError(err));
    throw err;
  }
}

async function translateLibre(text, target, source) {
  if (!LIBRE_SUPPORTED_LANGS.has(target)) {
    throw new Error(
      `LibreTranslate has no Argos Translate model for "${target}" (e.g. Khmer is not available at all). ` +
      `Set TRANSLATION_PROVIDER=google (with GOOGLE_TRANSLATE_API_KEY) for this language.`
    );
  }
  try {
    const resp = await axios.post(
      CONFIG.libreUrl,
      {
        q: text,
        source: source ? (LANG_MAP_LIBRE[source] || source) : 'auto',
        target: LANG_MAP_LIBRE[target] || target,
        format: 'text',
        api_key: CONFIG.libreApiKey || undefined,
      },
      { timeout: 6000, headers: { 'Content-Type': 'application/json' } }
    );
    const translated = resp.data?.translatedText;
    if (!translated) throw new Error('LibreTranslate returned no translation');
    return translated;
  } catch (err) {
    if (err.response) throw new Error(describeAxiosError(err));
    throw err;
  }
}

async function translateText(text, targetRaw, sourceRaw) {
  if (!text || !text.trim()) return '';

  const target = normLang(targetRaw);
  const source = sourceRaw ? normLang(sourceRaw) : null;
  if (target === source) return text;

  const provider = CONFIG.translationProvider;
  if (provider === 'none') return text;

  const attempts = [];
  if (provider === 'google') attempts.push(translateGoogle);
  else if (provider === 'deepl') attempts.push(translateDeepL);
  else attempts.push(translateLibre);

  if (provider !== 'libre') attempts.push(translateLibre);

  // Drop any attempt that can never handle this target language, instead of
  // burning a request (and a confusing 400 in the logs) on infra that never
  // supported it — this is specifically what was happening for Khmer + Libre.
  const filteredAttempts = attempts.filter((fn) => fn !== translateLibre || LIBRE_SUPPORTED_LANGS.has(target));

  if (filteredAttempts.length === 0) {
    throw new Error(
      `No configured translation provider supports target language "${target}". ` +
      `LibreTranslate has no model for it — set TRANSLATION_PROVIDER=google (with ` +
      `GOOGLE_TRANSLATE_API_KEY) or TRANSLATION_PROVIDER=deepl instead.`
    );
  }

  let lastErr;
  for (const attempt of filteredAttempts) {
    try {
      return await attempt(text, target, source);
    } catch (err) {
      lastErr = err;
      log('warn', `Translation attempt failed (${attempt.name})`, err.message);
    }
  }
  throw lastErr || new Error('All translation providers failed');
}

// ------------------------------------------------------------------
// Express app
// ------------------------------------------------------------------
const app = express();
app.use(cors({ origin: CONFIG.corsOrigin === '*' ? true : CONFIG.corsOrigin.split(',') }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Config exposed to the client (no secrets) ----
app.get('/api/config', (req, res) => {
  res.json({
    vmix: {
      overlay1: { input: CONFIG.overlay1Input, selectedName: CONFIG.overlay1SelectedName },
      overlay2: { input: CONFIG.overlay2Input, selectedName: CONFIG.overlay2SelectedName },
      defaultOverlayChannel: CONFIG.vmixDefaultOverlayChannel,
    },
    qc: {
      minConfidence: CONFIG.minConfidence,
      lowConfidenceAction: CONFIG.lowConfidenceAction,
      bannedWords: CONFIG.bannedWords,
    },
    translation: {
      provider: CONFIG.translationProvider,
      supportedLanguages: ['km', 'en', 'zh', 'fr', 'ar', 'ru', 'es'],
    },
  });
});

// ---- Health ----
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptimeSec: Math.round(process.uptime()), vmixLastKnownGood: state.vmixLastKnownGood });
});

// ---- vMix status probe ----
app.get('/api/vmix/status', async (req, res) => {
  const result = await vmixCall({});
  res.json({ connected: result.ok, detail: result.ok ? 'vMix reachable' : result.error });
});

// ---- Send text to ONE overlay target (REST fallback for when the WS is down) ----
app.post('/api/vmix/overlay', async (req, res) => {
  try {
    const { target, input, selectedName, value, language } = req.body || {};
    if (target !== 'overlay1' && target !== 'overlay2') {
      return res.status(400).json({ ok: false, error: '"target" must be "overlay1" or "overlay2"' });
    }
    if (typeof value !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing "value" (string) in request body' });
    }
    const defaults = overlayDefaults(target);
    const finalInput = input || defaults.input;
    const finalSelectedName = selectedName || defaults.selectedName;
    const finalValue = formatCaptionForOverlay(censorProfanity(value));

    const result = await vmixSetText(finalInput, finalSelectedName, finalValue);

    const entry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      target,
      translated: finalValue,
      language: language || null,
      status: result.ok ? 'sent' : 'send_failed',
      error: result.ok ? null : result.error,
    };
    pushLogEntry(entry);
    broadcast({ type: 'log_entry', entry });

    if (result.ok) {
      state.onAir[target] = { text: finalValue, language: language || null, timestamp: Date.now(), source: finalInput };
      broadcast({ type: 'onair_update', onAir: state.onAir });
    }

    res.json({ ok: result.ok, error: result.error, entry });
  } catch (err) {
    log('error', 'overlay handler crashed', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ---- Send BOTH overlays at once, synchronized (REST fallback) ----
// The two vMix SetText calls are fired concurrently via Promise.all so they
// leave the server in the same tick, instead of the old client-side
// sequential await which could visibly desync Overlay 1 vs Overlay 2.
app.post('/api/vmix/both', async (req, res) => {
  try {
    const { original, translated, overlay1Input, overlay1SelectedName, overlay2Input, overlay2SelectedName, language } = req.body || {};
    const result = await sendBothOverlays({ original, translated, overlay1Input, overlay1SelectedName, overlay2Input, overlay2SelectedName, language });
    res.json(result);
  } catch (err) {
    log('error', 'both-overlay handler crashed', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ---- vMix generic function trigger (overlay channel in/out, transitions, etc.) ----
app.post('/api/vmix/function', async (req, res) => {
  try {
    const { function: fn, input, value } = req.body || {};
    if (!fn || typeof fn !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing "function" (string) in request body' });
    }
    const result = await vmixFunction(fn, input, value);
    res.json({ ok: result.ok, error: result.error });
  } catch (err) {
    log('error', 'function handler crashed', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ---- Clear one or both overlay titles ----
// IMPORTANT: this honors the operator's *actual* configured Input/SelectedName
// (sent by the client, matching whatever is set in the Overlay 1/2 Target
// fields in the UI) rather than only ever falling back to the .env defaults —
// clearing the wrong Input (one that isn't actually on air) was the original
// bug behind "Clear both on vMix doesn't seem to do anything".
app.post('/api/vmix/clear', async (req, res) => {
  try {
    const { target, overlay1Input, overlay1SelectedName, overlay2Input, overlay2SelectedName } = req.body || {};
    const wantBoth = target !== 'overlay1' && target !== 'overlay2';
    const targets = wantBoth ? ['overlay1', 'overlay2'] : [target];

    const resolved = (t) => {
      const defaults = overlayDefaults(t);
      return t === 'overlay1'
        ? { input: overlay1Input || defaults.input, selectedName: overlay1SelectedName || defaults.selectedName }
        : { input: overlay2Input || defaults.input, selectedName: overlay2SelectedName || defaults.selectedName };
    };

    // Fire both clears concurrently so neither overlay lags behind the other.
    const settled = await Promise.all(targets.map(async (t) => {
      const cfg = resolved(t);
      const r = await vmixSetText(cfg.input, cfg.selectedName, '');
      return { t, cfg, r };
    }));

    const results = {};
    for (const { t, cfg, r } of settled) {
      results[t] = r;
      state.onAir[t] = { text: '', language: null, timestamp: Date.now(), source: cfg.input };
    }
    broadcast({ type: 'onair_update', onAir: state.onAir });
    const ok = targets.every((t) => results[t].ok);
    res.json({ ok, results });
  } catch (err) {
    log('error', 'clear handler crashed', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ---- Translation proxy (ad-hoc / on-demand use) ----
app.post('/api/translate', async (req, res) => {
  try {
    const { text, target, source } = req.body || {};
    if (!text || !target) {
      return res.status(400).json({ ok: false, error: 'Missing "text" or "target" in request body' });
    }
    const translated = await translateText(text, target, source);
    res.json({ ok: true, translated, provider: CONFIG.translationProvider });
  } catch (err) {
    log('warn', 'Translation failed', err.message);
    res.status(502).json({ ok: false, error: `Translation failed: ${err.message}` });
  }
});

// ---- Log history ----
app.get('/api/logs', (req, res) => {
  res.json({ ok: true, history: state.logHistory });
});

// ---- 404 for unknown API routes ----
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'Unknown API route' });
});

async function buildSttResultEntry(payload) {
  const { text, confidence, words, targetLang } = payload;
  const safeConfidence = typeof confidence === 'number' ? Math.max(0, Math.min(100, confidence)) : null;
  const filtered = censorProfanity(applyConfidenceFilter(text || '', safeConfidence ?? 100, words));

  let translated = filtered;
  let translationError = null;
  if (filtered) {
    try {
      translated = censorProfanity(await translateText(filtered, targetLang, null));
    } catch (err) {
      translationError = err.message;
      log('warn', 'STT-triggered translation failed', err.message);
    }
  }

  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    original: text || '',
    filtered,
    translated,
    confidence: safeConfidence,
    targetLang: normLang(targetLang),
    isFinal: true,
    status: 'received',
    translationError,
  };
}

function pushLogEntry(entry) {
  state.logHistory.push(entry);
  if (state.logHistory.length > CONFIG.maxLogHistory) {
    state.logHistory.splice(0, state.logHistory.length - CONFIG.maxLogHistory);
  }
}

// Sends Overlay 1 (original) and Overlay 2 (translated) in a single
// Promise.all — both HTTP calls to vMix leave the Node process in the same
// tick, which is what actually keeps them synchronized. The previous
// client-side "await overlay1 then await overlay2" approach serialized two
// full network round trips and could visibly desync the two captions.
async function sendBothOverlays({ original, translated, overlay1Input, overlay1SelectedName, overlay2Input, overlay2SelectedName, language }) {
  const d1 = overlayDefaults('overlay1');
  const d2 = overlayDefaults('overlay2');
  const finalInput1 = overlay1Input || d1.input;
  const finalSelectedName1 = overlay1SelectedName || d1.selectedName;
  const finalInput2 = overlay2Input || d2.input;
  const finalSelectedName2 = overlay2SelectedName || d2.selectedName;
  const finalValue1 = formatCaptionForOverlay(censorProfanity(original || ''));
  const finalValue2 = formatCaptionForOverlay(censorProfanity(translated || ''));

  const [result1, result2] = await Promise.all([
    finalValue1 ? vmixSetText(finalInput1, finalSelectedName1, finalValue1) : Promise.resolve({ ok: true, skipped: true }),
    finalValue2 ? vmixSetText(finalInput2, finalSelectedName2, finalValue2) : Promise.resolve({ ok: true, skipped: true }),
  ]);

  const now = Date.now();
  if (finalValue1) {
    const entry1 = { id: crypto.randomUUID(), timestamp: now, target: 'overlay1', translated: finalValue1, language: language || null, status: result1.ok ? 'sent' : 'send_failed', error: result1.ok ? null : result1.error };
    pushLogEntry(entry1);
    broadcast({ type: 'log_entry', entry: entry1 });
    if (result1.ok) state.onAir.overlay1 = { text: finalValue1, language: language || null, timestamp: now, source: finalInput1 };
  }
  if (finalValue2) {
    const entry2 = { id: crypto.randomUUID(), timestamp: now, target: 'overlay2', translated: finalValue2, language: language || null, status: result2.ok ? 'sent' : 'send_failed', error: result2.ok ? null : result2.error };
    pushLogEntry(entry2);
    broadcast({ type: 'log_entry', entry: entry2 });
    if (result2.ok) state.onAir.overlay2 = { text: finalValue2, language: language || null, timestamp: now, source: finalInput2 };
  }
  // One combined broadcast so both ON AIR rows update in the same render pass.
  broadcast({ type: 'onair_update', onAir: state.onAir });

  return { ok: result1.ok && result2.ok, overlay1: result1, overlay2: result2 };
}

// ------------------------------------------------------------------
// Google Cloud Speech-to-Text streaming ("Google Cloud Auto Multi-Language" mode)
//
// The client streams raw 16-bit LINEAR16 PCM audio over the WebSocket as
// binary frames (captured via an AudioWorklet — see public/pcm-worklet-
// processor.js). This server pipes those frames into a V2 streamingRecognize
// call using the Chirp 2 model with several languageCodes, so it can
// auto-detect code-switching between e.g. Khmer and English within the same
// stream — something the browser's own Web Speech API cannot do (it only
// accepts one fixed `lang`), and something V1's classic models can't do for
// Khmer at all (Khmer isn't in V1's supported-language list; it's only
// available via V2's Chirp/Chirp 2 models).
// ------------------------------------------------------------------
let speechClientV2Singleton = null;
function getSpeechClientV2() {
  if (!SpeechClientCtorV2) {
    throw new Error('The "@google-cloud/speech" package is not installed. Run: npm install @google-cloud/speech');
  }
  if (!speechClientV2Singleton) {
    // Chirp/Chirp 2 are region-specific — a regional apiEndpoint is required,
    // the default global endpoint will not have these models.
    speechClientV2Singleton = new SpeechClientCtorV2({
      apiEndpoint: `${CONFIG.googleCloudSttRegion}-speech.googleapis.com`,
    });
  }
  return speechClientV2Singleton;
}

async function resolveGoogleCloudProjectId(client) {
  if (CONFIG.googleCloudProjectId) return CONFIG.googleCloudProjectId;
  const result = await client.getProjectId();
  // Different client-library versions resolve this as either a bare string
  // or a [string] tuple — handle both.
  const projectId = Array.isArray(result) ? result[0] : result;
  if (!projectId) {
    throw new Error('Could not auto-detect a GCP project ID from GOOGLE_APPLICATION_CREDENTIALS — set GOOGLE_CLOUD_PROJECT_ID explicitly in .env');
  }
  return projectId;
}

function stopGoogleStream(ws) {
  ws.googleStreamStarting = false;
  ws.pendingAudioChunks = [];
  if (ws.googleStream) {
    try { ws.googleStream.end(); } catch (err) { /* already ending/ended */ }
    ws.googleStream = null;
  }
}

async function startGoogleStream(ws, { primaryLang, targetLang, sampleRateHertz }) {
  stopGoogleStream(ws); // never leave a previous stream running underneath a new one
  ws.googleStreamStarting = true;
  ws.pendingAudioChunks = [];

  let client, projectId;
  try {
    client = getSpeechClientV2();
    projectId = await resolveGoogleCloudProjectId(client);
  } catch (err) {
    ws.googleStreamStarting = false;
    ws.send(JSON.stringify({ type: 'error', error: `Google Cloud Speech unavailable: ${err.message}` }));
    return;
  }

  const primary = primaryLang || 'en-US';
  const alternates = CONFIG.googleCloudSttAlternativeLangs.filter((l) => l !== primary).slice(0, 3);
  // V2 combines the primary and alternate languages into a single array —
  // simpler than V1's separate languageCode + alternativeLanguageCodes fields.
  const languageCodes = [primary, ...alternates];

  // The "_" recognizer means "use this inline config, no pre-provisioned
  // Recognizer resource needed" — nothing to set up in the GCP console first.
  const recognizer = `projects/${projectId}/locations/${CONFIG.googleCloudSttRegion}/recognizers/_`;

  const configRequest = {
    recognizer,
    streamingConfig: {
      config: {
        explicitDecodingConfig: {
          encoding: 'LINEAR16',
          sampleRateHertz: sampleRateHertz || CONFIG.googleCloudSttSampleRate,
          audioChannelCount: 1,
        },
        languageCodes,
        model: CONFIG.googleCloudSttModel,
        features: { enableAutomaticPunctuation: true },
      },
      streamingFeatures: { interimResults: true },
    },
  };

  let recognizeStream;
  try {
    recognizeStream = await client.streamingRecognize();
  } catch (err) {
    ws.googleStreamStarting = false;
    ws.send(JSON.stringify({ type: 'error', error: `Could not start Google Cloud Speech (V2) stream: ${err.message}` }));
    return;
  }

  recognizeStream.on('error', (err) => {
    log('error', 'Google STT v2 stream error', err.message);
    // Common causes surfaced here: wrong region for the model (try
    // GOOGLE_CLOUD_STT_REGION=us-central1), the Speech-to-Text API not
    // enabled, or the service account missing the Cloud Speech Client role.
    ws.send(JSON.stringify({ type: 'error', error: `Google Cloud Speech error: ${err.message}` }));
    stopGoogleStream(ws);
  });

  // Cloud Speech's streamingRecognize has a hard limit of roughly 305 seconds
  // per stream — it ends on its own even with no error. Without this, a
  // session running longer than that would silently stop captioning with no
  // visible cause. Tell the client so it can transparently restart.
  recognizeStream.on('end', () => {
    if (ws.googleStream === recognizeStream) {
      ws.googleStream = null;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'google_stream_ended' }));
      }
    }
  });

  recognizeStream.on('data', async (data) => {
    const result = data.results && data.results[0];
    const alt = result && result.alternatives && result.alternatives[0];
    if (!alt) return;
    const text = (alt.transcript || '').trim();
    if (!text) return;
    const confidencePct = typeof alt.confidence === 'number' && alt.confidence > 0 ? Math.round(alt.confidence * 100) : 100;

    if (result.isFinal) {
      // Chirp 2 does its own proper endpointing (unlike the client-side
      // silence-buffering used for Web Speech mode), so its 'isFinal' really
      // does mean a complete utterance — safe to treat directly as stt_final.
      const signature = normalizeForDedupe(text) + '|' + normLang(targetLang);
      const now = Date.now();
      if (signature === ws.lastSttSignature && now - ws.lastSttTime < STT_DEDUPE_WINDOW_MS) return;
      ws.lastSttSignature = signature;
      ws.lastSttTime = now;

      try {
        const entry = await buildSttResultEntry({ text, confidence: confidencePct, targetLang });
        pushLogEntry(entry);
        broadcast({ type: 'stt_result', entry });
      } catch (err) {
        log('error', 'Google STT -> stt_result build failed', err);
      }
    } else {
      // Lightweight live-preview broadcast, mirroring what Web Speech mode
      // gets for free from the browser's own interim events.
      broadcast({ type: 'stt_interim', text, confidence: confidencePct });
    }
  });

  // The first message on a V2 streaming call must carry the recognizer +
  // config and no audio; every message after that must carry audio and no
  // config (mixing them is rejected by the API).
  recognizeStream.write(configRequest);

  ws.googleStream = recognizeStream;
  ws.googleStreamStarting = false;
  // Flush any audio that arrived (as binary WS frames) while the stream was
  // still being established above — nothing recorded during that brief
  // window gets silently dropped.
  if (ws.pendingAudioChunks.length) {
    for (const chunk of ws.pendingAudioChunks) {
      try { recognizeStream.write({ audio: chunk }); } catch (err) { /* stream may have just closed */ }
    }
    ws.pendingAudioChunks = [];
  }
}

// ------------------------------------------------------------------
// HTTP + WebSocket server
// ------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

wss.on('connection', (ws, req) => {
  const clientId = crypto.randomUUID();
  ws.isAlive = true;
  ws.lastSttSignature = null;
  ws.lastSttTime = 0;
  log('info', `WS client connected: ${clientId} (${req.socket.remoteAddress})`);

  ws.send(JSON.stringify({
    type: 'init',
    clientId,
    history: state.logHistory.slice(-100),
    onAir: state.onAir,
    config: {
      minConfidence: CONFIG.minConfidence,
      lowConfidenceAction: CONFIG.lowConfidenceAction,
    },
  }));

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw, isBinary) => {
    // Binary frames are raw PCM audio for the active Google Cloud STT stream
    // (see public/pcm-worklet-processor.js) — never JSON, so route them
    // straight to the stream instead of attempting to parse them.
    if (isBinary) {
      if (ws.googleStream) {
        // V2's streamingRecognize requires each audio message wrapped as
        // { audio: <bytes> } — unlike V1, it does not accept a bare Buffer.
        try { ws.googleStream.write({ audio: raw }); } catch (err) { log('warn', 'Google STT stream write failed', err.message); }
      } else if (ws.googleStreamStarting) {
        // The stream is still being established (awaiting project ID
        // resolution / stream creation) — queue briefly so audio captured
        // during that short window isn't silently dropped.
        ws.pendingAudioChunks = ws.pendingAudioChunks || [];
        ws.pendingAudioChunks.push(raw);
        if (ws.pendingAudioChunks.length > 200) ws.pendingAudioChunks.shift(); // cap — avoid unbounded growth if setup stalls
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON message' }));
      return;
    }

    try {
      switch (msg.type) {
        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          break;
        }

        // Client sends the raw recognized utterance + the operator's chosen
        // target language; the server owns masking, censorship, and
        // translation, then broadcasts one authoritative 'stt_result' to
        // every dashboard. This is the single source of truth for what
        // actually gets shown/sent — the client no longer decides it.
        case 'stt_final': {
          const signature = normalizeForDedupe(msg.text) + '|' + normLang(msg.targetLang);
          const now = Date.now();
          if (msg.text && signature === ws.lastSttSignature && now - ws.lastSttTime < STT_DEDUPE_WINDOW_MS) {
            break; // same utterance re-fired by the recognizer — ignore the repeat
          }
          ws.lastSttSignature = signature;
          ws.lastSttTime = now;

          const entry = await buildSttResultEntry(msg);
          pushLogEntry(entry);
          broadcast({ type: 'stt_result', entry });
          break;
        }

        // Send ONE overlay's text to vMix.
        case 'send_overlay': {
          const { requestId, target, value, input, selectedName, language } = msg;
          if (target !== 'overlay1' && target !== 'overlay2') {
            ws.send(JSON.stringify({ type: 'send_overlay_result', requestId, ok: false, target, error: 'Invalid target' }));
            break;
          }
          const defaults = overlayDefaults(target);
          const finalInput = input || defaults.input;
          const finalSelectedName = selectedName || defaults.selectedName;
          const finalValue = formatCaptionForOverlay(censorProfanity(value || ''));

          const result = await vmixSetText(finalInput, finalSelectedName, finalValue);

          const entry = {
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            target,
            translated: finalValue,
            language: language || null,
            status: result.ok ? 'sent' : 'send_failed',
            error: result.ok ? null : result.error,
          };
          pushLogEntry(entry);
          broadcast({ type: 'log_entry', entry });

          if (result.ok) {
            state.onAir[target] = { text: finalValue, language: language || null, timestamp: Date.now(), source: finalInput };
            broadcast({ type: 'onair_update', onAir: state.onAir });
          }

          ws.send(JSON.stringify({ type: 'send_overlay_result', requestId, ok: result.ok, target, error: result.error }));
          break;
        }

        // Send BOTH overlays at once, synchronized — see sendBothOverlays().
        case 'send_both': {
          const { requestId, original, translated, overlay1Input, overlay1SelectedName, overlay2Input, overlay2SelectedName, language } = msg;
          const result = await sendBothOverlays({ original, translated, overlay1Input, overlay1SelectedName, overlay2Input, overlay2SelectedName, language });
          ws.send(JSON.stringify({ type: 'send_both_result', requestId, ok: result.ok, overlay1: result.overlay1, overlay2: result.overlay2 }));
          break;
        }

        // Kept for ad-hoc/manual translation needs outside the main STT flow.
        case 'translate_request': {
          const { requestId, text, target, source } = msg;
          try {
            const translated = await translateText(text, target, source);
            ws.send(JSON.stringify({ type: 'translate_result', requestId, ok: true, translated }));
          } catch (err) {
            ws.send(JSON.stringify({ type: 'translate_result', requestId, ok: false, error: err.message }));
          }
          break;
        }

        // Switch this connection's audio pipeline to Google Cloud STT.
        case 'start_google_stream': {
          const { sourceLangs, targetLang, sampleRateHertz } = msg;
          const primaryLang = (Array.isArray(sourceLangs) && sourceLangs[0]) || 'en-US';
          await startGoogleStream(ws, { primaryLang, targetLang, sampleRateHertz });
          break;
        }

        case 'stop_google_stream': {
          stopGoogleStream(ws);
          break;
        }

        default:
          ws.send(JSON.stringify({ type: 'error', error: `Unknown message type: ${msg.type}` }));
      }
    } catch (err) {
      log('error', 'WS message handling crashed', err);
      ws.send(JSON.stringify({ type: 'error', error: 'Internal server error while handling message' }));
    }
  });

  ws.on('close', () => {
    stopGoogleStream(ws);
    log('info', `WS client disconnected: ${clientId}`);
  });

  ws.on('error', (err) => {
    log('warn', `WS client error: ${clientId}`, err.message);
  });
});

// Heartbeat: terminate dead connections
const HEARTBEAT_MS = 30000;
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      log('warn', 'Terminating unresponsive WS client');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeatInterval));

// ------------------------------------------------------------------
// Process-level safety nets
// ------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception (process kept alive)', err);
});
process.on('unhandledRejection', (reason) => {
  log('error', 'Unhandled promise rejection (process kept alive)', reason);
});

server.listen(CONFIG.port, () => {
  log('info', `vMix Caption System listening on http://localhost:${CONFIG.port}`);
  log('info', `Translation provider: ${CONFIG.translationProvider}`);
  log('info', `vMix target: ${CONFIG.vmixIp}:${CONFIG.vmixPort}`);
  log('info', `Overlay 1 -> ${CONFIG.overlay1Input} / ${CONFIG.overlay1SelectedName}`);
  log('info', `Overlay 2 -> ${CONFIG.overlay2Input} / ${CONFIG.overlay2SelectedName}`);
});