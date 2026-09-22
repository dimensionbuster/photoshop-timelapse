import { app, action } from "photoshop";
import { computeDocKey, getCachedMeta, saveMeta } from "./storage";
import { enqueue as enqueueCapture } from "./capture-queue";
import type { TimelapseMeta } from "./types";

const FLUSH_EVERY_N_FRAMES = 20;
const FLUSH_EVERY_MS = 5000;

type TickCallback = (docKey: string, meta: TimelapseMeta) => void;

let listenerRegistered = false;
let onTick: TickCallback | null = null;

let framesSinceFlush = 0;
let lastFlushAt = Date.now();

export function init(tickCallback: TickCallback): void {
  onTick = tickCallback;
  if (listenerRegistered) return;
  listenerRegistered = true;
  action.addNotificationListener(["historyStateChanged"], handleHistoryEvent);
}

function handleHistoryEvent(): void {
  const doc = app.activeDocument;
  if (!doc) return;

  let docPath: string;
  try {
    docPath = doc.path;
  } catch (e) {
    return; // unsaved document, not tracked
  }
  if (!docPath) return;

  const docKey = computeDocKey(docPath);
  const meta = getCachedMeta(docKey);
  if (!meta || meta.status !== "recording") return;

  const now = Date.now();
  if (meta.lastEventTimestamp != null) {
    const gap = now - meta.lastEventTimestamp;
    if (gap <= meta.settings.idleCutoffSeconds * 1000) {
      meta.accumulatedSeconds += gap / 1000;
    }
    // gap over the cutoff: user was idle, that stretch is excluded from
    // active time (still counted in wallSeconds, surfaced as idle time)
  }
  meta.lastEventTimestamp = now;

  if (onTick) onTick(docKey, meta);

  // "realtime" sampling captures only every captureStride-th event (stride
  // doubles over a long session, see capture-queue.ts's compactRealtime);
  // "selective" sampling keeps captureStride pinned at 1, so this fires on
  // every event exactly like before this gate existed.
  meta.eventsSinceLastCapture += 1;
  if (meta.eventsSinceLastCapture >= meta.captureStride) {
    meta.eventsSinceLastCapture = 0;
    enqueueCapture(docKey, meta);
  }
  maybeFlush(docKey, meta);
}

function maybeFlush(docKey: string, meta: TimelapseMeta): void {
  framesSinceFlush += 1;
  const now = Date.now();
  if (framesSinceFlush >= FLUSH_EVERY_N_FRAMES || now - lastFlushAt >= FLUSH_EVERY_MS) {
    framesSinceFlush = 0;
    lastFlushAt = now;
    // Roll the in-progress wall-clock segment into wallSeconds and rebase
    // recordingStartedAt, same as stop() does. Without this, wallSeconds on
    // disk only ever advances on an explicit stop(), while accumulatedSeconds
    // above is flushed continuously — so a mid-session reload (which resets
    // recordingStartedAt to "now" to avoid counting time the plugin was
    // closed) throws away the wall time elapsed since the last stop() but
    // keeps the real accumulatedSeconds, and 전체/논 시간 reset while 작업
    // 비율 spikes past 100%.
    if (meta.recordingStartedAt != null) {
      meta.wallSeconds += (now - meta.recordingStartedAt) / 1000;
      meta.recordingStartedAt = now;
    }
    saveMeta(docKey, meta).catch((e) => console.error("[timelapse] meta flush failed", e));
  }
}
