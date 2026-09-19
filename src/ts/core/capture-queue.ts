import { storage as uxpStorage } from "uxp";
import type { UxpFileEntry } from "uxp";
import { imaging, core } from "photoshop";
import { getFramesFolder, saveMeta } from "./storage";
import { REALTIME_FRAME_BUDGET } from "./constants";
import type { TimelapseMeta } from "./types";

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
      await captureOne(docKey, meta.frameCount + 1, meta.frameGeneration, meta.settings.captureWidth);
      // only advance the counter on a successful write so frame filenames
      // stay contiguous (ffmpeg's %06d pattern breaks on gaps)
      meta.frameCount += 1;
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

async function captureOne(docKey: string, frameIndex: number, frameGeneration: number, captureWidth: number): Promise<void> {
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
    () => imaging.getPixels({ targetSize: { width: captureWidth }, applyAlpha: true }),
    { commandName: "Timelapse 프레임 캡처", interactive: true }
  );
  const base64 = (await imaging.encodeImageData({
    imageData: pixels.imageData,
    base64: true,
  })) as string;
  const bytes = base64ToArrayBuffer(base64);
  const frames = await getFramesFolder(docKey, frameGeneration);
  const fileName = String(frameIndex).padStart(6, "0") + ".jpg";
  const entry = await frames.createFile(fileName, { overwrite: true });
  await entry.write(bytes, { format: uxpStorage.formats.binary });
  pixels.imageData.dispose();
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
