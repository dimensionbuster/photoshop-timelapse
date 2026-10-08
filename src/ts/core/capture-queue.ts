import { storage as uxpStorage } from "uxp";
import type { UxpFileEntry } from "uxp";
import { app, imaging, core } from "photoshop";
import { getFramesFolder, saveMeta } from "./storage";
import { REALTIME_FRAME_BUDGET } from "./constants";
import type { FrameInfo, TimelapseMeta } from "./types";

interface QueueItem {
  docKey: string;
  meta: TimelapseMeta;
}

type CapturedCallback = (docKey: string, meta: TimelapseMeta) => void;
type ErrorCallback = (docKey: string, error: unknown) => void;

const queue: QueueItem[] = [];
let processing = false;
let onCaptured: CapturedCallback | null = null;
let onError: ErrorCallback | null = null;

export function setCallbacks(callbacks: { onCaptured?: CapturedCallback; onError?: ErrorCallback }): void {
  onCaptured = callbacks.onCaptured || null;
  onError = callbacks.onError || null;
}

export function enqueue(docKey: string, meta: TimelapseMeta): void {
  queue.push({ docKey, meta });
  if (!processing) {
    processing = true;
    void processQueue();
  }
}

async function processQueue(): Promise<void> {
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const { docKey, meta } = item;
    try {
      const info = await captureOne(docKey, meta);
      // only advance the counter on a successful write so frame filenames
      // stay contiguous (ffmpeg's %06d pattern breaks on gaps)
      meta.frameCount += 1;
      if (info) meta.frames.push(info);
      if (meta.settings.samplingMode === "realtime" && meta.frameCount > REALTIME_FRAME_BUDGET) {
        await compactRealtime(docKey, meta);
      }
      if (onCaptured) onCaptured(docKey, meta);
    } catch (e) {
      console.error("[timelapse] frame capture failed, skipping this history event", e);
      if (onError) onError(docKey, e);
    }
  }
  processing = false;
}

interface LayerPos {
  left: number;
  top: number;
}

// docKey -> layer positions (document px) at the previous capture. Compared
// against the next capture when the canvas size changed, to recover where the
// canvas-size anchor put the content. In-memory only: after a cold start the
// first size change falls back to a centered anchor.
const layerSnapshots = new Map<string, Map<number, LayerPos>>();
const MAX_SNAPSHOT_LAYERS = 40;

function snapshotLayers(): Map<number, LayerPos> {
  const out = new Map<number, LayerPos>();
  const doc = app.activeDocument;
  if (!doc) return out;
  const walk = (layers: ReadonlyArray<{ id: number; isBackgroundLayer: boolean; layers?: ReadonlyArray<unknown>; bounds: { left: number; top: number; right: number; bottom: number } }>): void => {
    for (const layer of layers) {
      if (out.size >= MAX_SNAPSHOT_LAYERS) return;
      if (layer.layers) {
        walk(layer.layers as typeof layers);
      } else if (!layer.isBackgroundLayer) {
        // bounds of an empty layer are all 0 — carries no position info
        const b = layer.bounds;
        if (Number(b.right) <= Number(b.left) || Number(b.bottom) <= Number(b.top)) continue;
        out.set(layer.id, { left: Number(b.left), top: Number(b.top) });
      }
    }
  };
  walk(doc.layers as unknown as Parameters<typeof walk>[0]);
  return out;
}

// The canvas-size dialog only offers a 3x3 anchor grid, so along each axis the
// content shift is one of 0, delta/2, delta (delta = new - old size, doc px).
// Pick the candidate the most layers agree with (exact match, 1.5px slack).
// Layers whose bounds get clipped by the canvas match nothing and are simply
// outvoted — raw "most common shift" was thrown off by them.
function pickAxisShift(deltas: number[], size: number): number | null {
  if (size === 0) return 0;
  const candidates = [0, size / 2, size];
  let best = -1;
  let bestScore = 0;
  candidates.forEach((c, i) => {
    const score = deltas.filter((d) => Math.abs(d - c) <= 1.5).length;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  if (best >= 0) return candidates[best] ?? null;
  if (deltas.length === 0) return null;
  // nothing matched exactly: snap the median observed shift to the nearest anchor
  const sorted = deltas.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return candidates.reduce((a, b) => (Math.abs(b - median) < Math.abs(a - median) ? b : a));
}

// Content shift (doc px) between two layer snapshots, snapped to a valid
// anchor position; null when there is no usable layer to compare.
function detectAnchorShift(
  prev: Map<number, LayerPos>,
  cur: Map<number, LayerPos>,
  deltaW: number,
  deltaH: number
): { dx: number; dy: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [id, p] of prev) {
    const c = cur.get(id);
    if (!c) continue;
    xs.push(c.left - p.left);
    ys.push(c.top - p.top);
  }
  const dx = pickAxisShift(xs, deltaW);
  const dy = pickAxisShift(ys, deltaH);
  return dx === null || dy === null ? null : { dx, dy };
}

async function captureOne(docKey: string, meta: TimelapseMeta): Promise<FrameInfo | null> {
  const frameIndex = meta.frameCount + 1;
  // Frame geometry is only tracked when every earlier frame has an entry;
  // recordings from before this feature keep the old fixed-width behavior.
  const tracking = meta.frames.length === meta.frameCount;
  const last = tracking && meta.frameCount > 0 ? meta.frames[meta.frameCount - 1] : undefined;
  // getPixels touches the document and PS 24+ rejects it outside a modal
  // scope ("only allowed from inside a modal scope") — keep the modal window
  // as short as possible, just the read, since it blocks the PS UI thread.
  // encodeImageData only ever produces jpeg, which can't hold an alpha
  // channel; applyAlpha mats RGBA down to RGB (over white) at the source so
  // we never hand encodeImageData data it can't encode.
  // interactive:true (PS 23.3+) tells executeAsModal to skip the blocking
  // progress dialog and relax the input restrictions that were freezing the
  // panel's buttons and glitching the brush cursor on every capture.
  const pixels = await core.executeAsModal(
    () => {
      // Fixed px-per-doc-px scale (set on the first frame) so resizing the
      // canvas never rescales existing content.
      let targetWidth = meta.settings.captureWidth;
      if (tracking) {
        const docWidth = Number(app.activeDocument.width);
        if (meta.captureScale === null) meta.captureScale = meta.settings.captureWidth / docWidth;
        targetWidth = Math.max(1, Math.round(docWidth * meta.captureScale));
      }
      return imaging.getPixels({ targetSize: { width: targetWidth }, applyAlpha: true });
    },
    { commandName: "Timelapse 프레임 캡처", interactive: true }
  );
  const w = pixels.imageData.width;
  const h = pixels.imageData.height;
  const base64 = (await imaging.encodeImageData({
    imageData: pixels.imageData,
    base64: true,
  })) as string;
  const bytes = base64ToArrayBuffer(base64);
  const frames = await getFramesFolder(docKey, meta.frameGeneration);
  const fileName = String(frameIndex).padStart(6, "0") + ".jpg";
  const entry = await frames.createFile(fileName, { overwrite: true });
  await entry.write(bytes, { format: uxpStorage.formats.binary });
  pixels.imageData.dispose();

  if (!tracking) return null;

  let ox = 0;
  let oy = 0;
  let snapshot: Map<number, LayerPos> | null = null;
  try {
    snapshot = snapshotLayers();
  } catch (e) {
    snapshot = null; // layer bounds are best-effort; fall back to centered anchor
  }
  if (last) {
    ox = last.ox;
    oy = last.oy;
    if (last.w !== w || last.h !== h) {
      // Canvas size changed: new frame's top-left sits at -shift relative to
      // the previous frame (content moved by +shift inside the new canvas).
      const scale = meta.captureScale ?? 1;
      const prevSnap = layerSnapshots.get(docKey);
      const shift = prevSnap && snapshot ? detectAnchorShift(prevSnap, snapshot, (w - last.w) / scale, (h - last.h) / scale) : null;
      if (shift) {
        ox -= shift.dx * scale;
        oy -= shift.dy * scale;
      } else {
        ox -= (w - last.w) / 2;
        oy -= (h - last.h) / 2;
      }
    }
  }
  if (snapshot) layerSnapshots.set(docKey, snapshot);
  else layerSnapshots.delete(docKey);
  return { w, h, ox: Math.round(ox), oy: Math.round(oy) };
}

// "realtime" sampling: once the stored frame count crosses the export
// budget, halve it by keeping only even-indexed frames (2,4,6,...) in a new
// generation folder, and double captureStride so future captures happen
// half as often. Repeating this keeps disk usage bounded to roughly
// [budget/2, budget] frames for an arbitrarily long recording, while keeping
// the surviving frames spread evenly across the *whole* elapsed session
// (early content gets thinned too, not just "capture stops after budget").
// Streams one file at a time (no whole-session buffering) and only commits
// via a single saveMeta once the new generation is fully written — see the
// append-only generation-folder design notes in storage.ts.
async function compactRealtime(docKey: string, meta: TimelapseMeta): Promise<void> {
  const oldGeneration = meta.frameGeneration;
  const newGeneration = oldGeneration + 1;
  const oldFolder = await getFramesFolder(docKey, oldGeneration);
  const newFolder = await getFramesFolder(docKey, newGeneration);

  const keepCount = Math.floor(meta.frameCount / 2);
  for (let k = 1; k <= keepCount; k++) {
    const oldIndex = k * 2;
    const srcName = String(oldIndex).padStart(6, "0") + ".jpg";
    const dstName = String(k).padStart(6, "0") + ".jpg";
    const srcEntry = (await oldFolder.getEntry(srcName)) as UxpFileEntry;
    const bytes = await srcEntry.read({ format: uxpStorage.formats.binary });
    const dstEntry = await newFolder.createFile(dstName, { overwrite: true });
    await dstEntry.write(bytes, { format: uxpStorage.formats.binary });
  }

  if (meta.frames.length === meta.frameCount) {
    const kept: FrameInfo[] = [];
    for (let k = 1; k <= keepCount; k++) {
      const info = meta.frames[k * 2 - 1];
      if (info) kept.push(info);
    }
    meta.frames = kept;
  }
  meta.frameGeneration = newGeneration;
  meta.frameCount = keepCount;
  meta.captureStride *= 2;
  meta.eventsSinceLastCapture = 0;
  await saveMeta(docKey, meta);
  // oldFolder (generation `oldGeneration`) is intentionally left on disk —
  // it's swept lazily on the doc's next cold meta load (storage.ts:gcStaleGenerations).
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
