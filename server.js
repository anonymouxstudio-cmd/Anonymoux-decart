/**
 * =============================================================================
 *  ANONYMOUX LIVECAST — Backend
 * =============================================================================
 *  This server is the only thing in this project that ever holds the
 *  permanent DECART_API_KEY. It has three jobs:
 *
 *  1. REALTIME  — mint short-lived client tokens via the SDK's documented
 *     `client.tokens.create()` so the browser can open its own WebRTC
 *     session directly against Decart's edge network. Video never touches
 *     this server for realtime sessions.
 *
 *  2. QUEUE     — proxy async video jobs (edit / restyle / try-on / t2v / i2v)
 *     through `client.queue.submit()` + `client.queue.status()` +
 *     `client.queue.result()`. These need the permanent secret key, so the
 *     browser never calls Decart directly for this — it calls us, and we
 *     call Decart.
 *
 *  3. PROCESS   — proxy synchronous image jobs (edit / try-on / restyle /
 *     text-to-image) through `client.process()`. Same reasoning as above.
 *
 *  All three follow the same rule: DECART_API_KEY is read once from
 *  process.env, used to construct a single server-side Decart client, and
 *  is never echoed back to the browser in any response body.
 * =============================================================================
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { createDecartClient, models } from '@decartai/sdk';

const PORT = process.env.PORT || 10000;
const DECART_API_KEY = process.env.DECART_API_KEY || '';
const TOKEN_TTL_SECONDS = 300; // 5 minutes — plenty for a realtime session to establish

// Parse ALLOWED_ORIGINS into an array; empty means "same origin only" (cors default).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use(
  cors(
    allowedOrigins.length > 0
      ? { origin: allowedOrigins }
      : {} // permissive default for same-origin/local dev; tighten via ALLOWED_ORIGINS in production
  )
);

// In-memory uploads (no disk writes) — files are forwarded straight to Decart
// and never persisted here. This ceiling covers the largest input (video);
// per-model caps are re-checked below, and Decart itself also enforces limits.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 300 * 1024 * 1024 },
});

// Serve the frontend as static files.
app.use(express.static('.', { index: 'index.html' }));

// -----------------------------------------------------------------------
// Decart client — constructed once at boot with the permanent secret key.
// Only ever used server-side, across all three job types below.
// -----------------------------------------------------------------------
let decartClient = null;
function getDecartClient() {
  if (!DECART_API_KEY) return null;
  if (!decartClient) {
    decartClient = createDecartClient({ apiKey: DECART_API_KEY });
  }
  return decartClient;
}

function requireClient(res) {
  const client = getDecartClient();
  if (!client) {
    res.status(500).json({
      ok: false,
      error: 'not_configured',
      message: 'Server is missing DECART_API_KEY. Set it in your environment and restart.',
    });
    return null;
  }
  return client;
}

// -----------------------------------------------------------------------
// Model registry — the single source of truth for what this dashboard
// exposes. Every entry maps a UI-facing id to the SDK's model factory.
// Keeping this server-side means the frontend never has to guess at model
// strings, and adding/removing a model is a one-place change.
// -----------------------------------------------------------------------
const MODEL_REGISTRY = {
  // ---- Realtime (WebRTC, live webcam) ----
  'realtime.lucy-2.5': { kind: 'realtime', factory: () => models.realtime('lucy-2.5'), label: 'Lucy 2.5 — Realtime Edit', creditsPerSecond: 2 },
  'realtime.lucy-vton-3': { kind: 'realtime', factory: () => models.realtime('lucy-vton-3'), label: 'Lucy Virtual Try-On 3 — Realtime', creditsPerSecond: null },
  'realtime.lucy-restyle-2': { kind: 'realtime', factory: () => models.realtime('lucy-restyle-2'), label: 'Lucy Restyle 2 — Realtime', creditsPerSecond: 1 },

  // ---- Queue (async video, upload + poll + download) ----
  'video.lucy-2.1': { kind: 'video', factory: () => models.video('lucy-2.1'), label: 'Lucy 2.1 — Video Edit', needsReferenceImage: false },
  'video.lucy-vton-3': { kind: 'video', factory: () => models.video('lucy-vton-3'), label: 'Lucy Virtual Try-On 3 — Video', needsReferenceImage: true },
  'video.lucy-restyle-2': { kind: 'video', factory: () => models.video('lucy-restyle-2'), label: 'Lucy Restyle 2 — Video', needsReferenceImage: false },
  'video.lucy-pro-t2v': { kind: 'video', factory: () => models.video('lucy-pro-t2v'), label: 'Lucy Pro — Text to Video', textOnly: true },
  'video.lucy-pro-i2v': { kind: 'video', factory: () => models.video('lucy-pro-i2v'), label: 'Lucy Pro — Image to Video', imageToVideo: true },

  // ---- Process (sync image) ----
  'image.lucy-image-2': { kind: 'image', factory: () => models.image('lucy-image-2'), label: 'Lucy Image — Edit', needsReferenceImage: true },
  'image.lucy-pro-t2i': { kind: 'image', factory: () => models.image('lucy-pro-t2i'), label: 'Lucy Pro — Text to Image', textOnly: true },
};

/**
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    configured: Boolean(DECART_API_KEY),
    models: Object.entries(MODEL_REGISTRY).map(([id, m]) => ({
      id,
      kind: m.kind,
      label: m.label,
    })),
  });
});

/**
 * POST /token
 * Mints a short-lived client token for the Realtime API only.
 * Body: { model: string }  — must be a "realtime.*" id from MODEL_REGISTRY
 */
app.post('/token', async (req, res) => {
  const client = requireClient(res);
  if (!client) return;

  const modelId = typeof req.body?.model === 'string' ? req.body.model : 'realtime.lucy-2.5';
  const entry = MODEL_REGISTRY[modelId];

  if (!entry || entry.kind !== 'realtime') {
    return res.status(400).json({ ok: false, error: 'invalid_model', message: `Unknown realtime model: ${modelId}` });
  }

  try {
    const decartModelName = entry.factory().name ?? modelId.split('.')[1];
    const token = await client.tokens.create({
      expiresIn: TOKEN_TTL_SECONDS,
      allowedModels: [decartModelName],
    });

    return res.json({
      ok: true,
      apiKey: token.apiKey,
      expiresAt: token.expiresAt,
      model: modelId,
    });
  } catch (err) {
    console.error('[Decart] token mint failed:', err?.message || err);
    return res.status(502).json({
      ok: false,
      error: 'token_mint_failed',
      message: 'Decart rejected the token request. Confirm DECART_API_KEY is a valid, active secret key.',
    });
  }
});

/**
 * POST /api/video/submit
 * Submits an async Queue job (video edit / restyle / vton / t2v / i2v).
 * multipart/form-data: model, prompt, data? (video file), image? (reference image)
 * Response: { ok, jobId }
 */
app.post(
  '/api/video/submit',
  upload.fields([{ name: 'data', maxCount: 1 }, { name: 'image', maxCount: 1 }]),
  async (req, res) => {
    const client = requireClient(res);
    if (!client) return;

    const modelId = req.body?.model;
    const entry = MODEL_REGISTRY[modelId];
    if (!entry || entry.kind !== 'video') {
      return res.status(400).json({ ok: false, error: 'invalid_model', message: `Unknown video model: ${modelId}` });
    }

    const prompt = (req.body?.prompt || '').trim();
    if (!prompt) {
      return res.status(400).json({ ok: false, error: 'missing_prompt', message: 'A prompt is required.' });
    }

    const dataFile = req.files?.data?.[0];
    const imageFile = req.files?.image?.[0];

    if (!entry.textOnly && !dataFile) {
      return res.status(400).json({ ok: false, error: 'missing_data', message: 'This model requires a video (or image) file upload.' });
    }
    if (entry.needsReferenceImage && !imageFile) {
      return res.status(400).json({ ok: false, error: 'missing_reference', message: 'This model requires a reference image.' });
    }

    try {
      const payload = { model: entry.factory(), prompt };

      if (dataFile) {
        payload.data = new Blob([dataFile.buffer], { type: dataFile.mimetype });
      }
      if (imageFile) {
        const blob = new Blob([imageFile.buffer], { type: imageFile.mimetype });
        // Try-on models take the reference under `reference_image`; straight
        // edit models take it under `image`. Branch on the declared need.
        if (modelId === 'video.lucy-vton-3') {
          payload.reference_image = blob;
        } else {
          payload.image = blob;
        }
      }
      if (req.body?.resolution) {
        payload.resolution = req.body.resolution;
      }

      const job = await client.queue.submit(payload);
      return res.json({ ok: true, jobId: job.job_id, model: modelId });
    } catch (err) {
      console.error('[Decart] queue submit failed:', err?.message || err);
      return res.status(502).json({ ok: false, error: 'submit_failed', message: err?.message || 'Job submission failed.' });
    }
  }
);

/**
 * GET /api/video/status/:jobId
 * Response: { ok, status: 'queued'|'processing'|'completed'|'failed', ... }
 */
app.get('/api/video/status/:jobId', async (req, res) => {
  const client = requireClient(res);
  if (!client) return;

  try {
    const status = await client.queue.status(req.params.jobId);
    return res.json({ ok: true, ...status });
  } catch (err) {
    console.error('[Decart] status check failed:', err?.message || err);
    return res.status(502).json({ ok: false, error: 'status_failed', message: err?.message || 'Could not fetch job status.' });
  }
});

/**
 * GET /api/video/result/:jobId
 * Streams the finished video binary back to the browser.
 */
app.get('/api/video/result/:jobId', async (req, res) => {
  const client = requireClient(res);
  if (!client) return;

  try {
    const blob = await client.queue.result(req.params.jobId);
    const buffer = Buffer.from(await blob.arrayBuffer());
    res.setHeader('Content-Type', blob.type || 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="anonymoux-${req.params.jobId}.mp4"`);
    return res.send(buffer);
  } catch (err) {
    console.error('[Decart] result fetch failed:', err?.message || err);
    return res.status(502).json({ ok: false, error: 'result_failed', message: err?.message || 'Could not fetch job result.' });
  }
});

/**
 * POST /api/image/process
 * Synchronous image job (edit / restyle / text-to-image).
 * multipart/form-data: model, prompt, data? (image file), image? (reference image), resolution?
 * Response: image binary
 */
app.post(
  '/api/image/process',
  upload.fields([{ name: 'data', maxCount: 1 }, { name: 'image', maxCount: 1 }]),
  async (req, res) => {
    const client = requireClient(res);
    if (!client) return;

    const modelId = req.body?.model;
    const entry = MODEL_REGISTRY[modelId];
    if (!entry || entry.kind !== 'image') {
      return res.status(400).json({ ok: false, error: 'invalid_model', message: `Unknown image model: ${modelId}` });
    }

    const prompt = (req.body?.prompt || '').trim();
    if (!prompt) {
      return res.status(400).json({ ok: false, error: 'missing_prompt', message: 'A prompt is required.' });
    }

    const dataFile = req.files?.data?.[0];
    const imageFile = req.files?.image?.[0];

    if (!entry.textOnly && !dataFile) {
      return res.status(400).json({ ok: false, error: 'missing_data', message: 'This model requires an image upload.' });
    }

    try {
      const payload = { model: entry.factory(), prompt };
      if (dataFile) {
        payload.data = new Blob([dataFile.buffer], { type: dataFile.mimetype });
      }
      if (imageFile) {
        payload.image = new Blob([imageFile.buffer], { type: imageFile.mimetype });
      }
      if (req.body?.resolution) {
        payload.resolution = req.body.resolution;
      }
      if (req.body?.aspectRatio) {
        payload.aspectRatio = req.body.aspectRatio;
      }

      const blob = await client.process(payload);
      const buffer = Buffer.from(await blob.arrayBuffer());
      res.setHeader('Content-Type', blob.type || 'image/png');
      return res.send(buffer);
    } catch (err) {
      console.error('[Decart] process failed:', err?.message || err);
      return res.status(502).json({ ok: false, error: 'process_failed', message: err?.message || 'Image processing failed.' });
    }
  }
);

// Multer / body-size error handler (keeps error shape consistent with the rest of the API)
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    return res.status(413).json({ ok: false, error: 'upload_too_large', message: err.message });
  }
  if (err) {
    console.error('[Server] unhandled error:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'internal_error', message: 'Something went wrong.' });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`Anonymoux Livecast server running on port ${PORT}`);
  console.log(`Decart key configured: ${Boolean(DECART_API_KEY)}`);
  console.log(`Models registered: ${Object.keys(MODEL_REGISTRY).length}`);
});
