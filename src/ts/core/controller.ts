import { app } from "photoshop";
import { computeDocKey, ensureMetaLoaded, getCachedMeta, saveMeta, fullReset } from "./storage";
import * as historyListener from "./history-listener";
import * as captureQueue from "./capture-queue";
import { exportToMp4, type ExportResult } from "./export-ffmpeg";
import { createPlaybackSession, type PlaybackSession } from "./playback";
import { secondsToHHMMSS } from "./time-format";
import { DEFAULT_CAPTURE_WIDTH, DEFAULT_SAMPLING_MODE, DEFAULT_IDLE_CUTOFF_SECONDS } from "./constants";
import type { TimelapseMeta, TimelapseSettings, UiState } from "./types";

type Listener = (state: UiState) => void;

let listeners: Listener[] = [];
let currentDocKey: string | null = null;
let currentMeta: TimelapseMeta | null = null;
let lastCaptureError: string | null = null;

// historyListener's onTick fires (and calls notify) *before* a frame finishes
// writing to disk, so without this the frame counter always lagged one
// capture behind — and capture failures only went to console.error, which
// nobody sees in a Photoshop panel, so they looked like "frame count stuck
// at 0" instead of a real error.
captureQueue.setCallbacks({
  onCaptured: (docKey) => {
    lastCaptureError = null;
    if (docKey === currentDocKey) notify();
  },
  onError: (docKey, error) => {
    lastCaptureError = error instanceof Error ? error.message : String(error);
    if (docKey === currentDocKey) notify();
  },
});

export function subscribe(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

function notify(): void {
  const state = getState();
  listeners.forEach((fn) => fn(state));
}

// Settings may only change while there is no cache yet for the current doc —
// once recording starts or any frame exists, they're locked until a full
// "기록 초기화" reset (fullReset also resets frameCount back to 0, which is
// what re-unlocks this).
export function isSettingsLocked(meta: TimelapseMeta | null): boolean {
  return !meta || !(meta.status === "not_started" && meta.frameCount === 0);
}

export function getState(): UiState {
  return {
    hasSavedDoc: !!currentDocKey,
    docName: currentMeta ? currentMeta.docName : null,
    status: currentMeta ? currentMeta.status : "not_started",
    accumulatedSeconds: currentMeta ? currentMeta.accumulatedSeconds : 0,
    formattedTime: secondsToHHMMSS(currentMeta ? currentMeta.accumulatedSeconds : 0),
    lastEventTimestamp: currentMeta ? currentMeta.lastEventTimestamp : null,
    recordingStartedAt: currentMeta ? currentMeta.recordingStartedAt : null,
    wallSeconds: currentMeta ? currentMeta.wallSeconds : 0,
    frameCount: currentMeta ? currentMeta.frameCount : 0,
    captureError: lastCaptureError,
    settings: currentMeta
      ? currentMeta.settings
      : { samplingMode: DEFAULT_SAMPLING_MODE, captureWidth: DEFAULT_CAPTURE_WIDTH, idleCutoffSeconds: DEFAULT_IDLE_CUTOFF_SECONDS },
    settingsLocked: isSettingsLocked(currentMeta),
  };
}

export async function updateSettings(partial: Partial<TimelapseSettings>): Promise<void> {
  if (!currentDocKey || !currentMeta) return;
  if (isSettingsLocked(currentMeta)) {
    console.warn("[timelapse] updateSettings ignored: settings are locked");
    return;
  }
  currentMeta.settings = { ...currentMeta.settings, ...partial };
  await saveMeta(currentDocKey, currentMeta);
  notify();
}

function getActiveDocInfo(): { docPath: string; docName: string } | null {
  const doc = app.activeDocument;
  if (!doc) return null;
  let docPath: string;
  try {
    docPath = doc.path;
  } catch (e) {
    return null;
  }
  if (!docPath) return null;
  return { docPath, docName: doc.name };
}

// Called on panel show and whenever the active document changes (polled from
// entrypoints.tsx) so switching documents, or reopening a doc that was left
// mid-recording in a previous PS session, re-syncs the panel correctly.
export async function refreshForActiveDocument(): Promise<void> {
  const info = getActiveDocInfo();
  if (!info) {
    currentDocKey = null;
    currentMeta = null;
    notify();
    return;
  }
  const docKey = computeDocKey(info.docPath);
  const wasCached = getCachedMeta(docKey) !== null;
  currentDocKey = docKey;
  currentMeta = await ensureMetaLoaded(docKey, info.docPath, info.docName);

  if (currentMeta.status === "recording") {
    // Freshly loaded from disk with status still "recording" means the last
    // session ended mid-recording. The history listener is only registered by
    // start(), so without this the clock and frame capture stayed dead while
    // the wall-clock timer kept running off the stale recordingStartedAt.
    if (!wasCached) {
      currentMeta.lastEventTimestamp = null;
      currentMeta.recordingStartedAt = Date.now(); // don't count the time the plugin was closed
      await saveMeta(docKey, currentMeta);
    }
    historyListener.init(handleTick);
  }
  notify();
}

export async function start(): Promise<void> {
  if (!currentDocKey || !currentMeta) return;
  lastCaptureError = null;
  if (currentMeta.status !== "recording") {
    currentMeta.status = "recording";
    if (!currentMeta.createdAt) currentMeta.createdAt = Date.now();
    currentMeta.lastEventTimestamp = null; // avoid counting the gap since the last session as edit time
    currentMeta.recordingStartedAt = Date.now();
    await saveMeta(currentDocKey, currentMeta);
  }
  historyListener.init(handleTick);
  notify();
}

export function stop(): void {
  if (!currentDocKey || !currentMeta) return;
  if (currentMeta.recordingStartedAt != null) {
    currentMeta.wallSeconds += (Date.now() - currentMeta.recordingStartedAt) / 1000;
    currentMeta.recordingStartedAt = null;
  }
  currentMeta.status = "stopped";
  saveMeta(currentDocKey, currentMeta).catch((e) => console.error("[timelapse] save on stop failed", e));
  notify();
}

function handleTick(docKey: string): void {
  if (docKey === currentDocKey) notify();
}

export async function exportVideo(): Promise<ExportResult> {
  if (!currentDocKey || !currentMeta) throw new Error("기록 중인 문서가 없습니다.");
  const result = await exportToMp4(currentDocKey, currentMeta);
  notify();
  return result;
}

// Zero the clock / wall / idle displays without touching status, frames or
// settings. Contrast with resetRecording(), which wipes the whole cache.
export async function resetTimer(): Promise<void> {
  if (!currentDocKey || !currentMeta) return;
  currentMeta.accumulatedSeconds = 0;
  currentMeta.wallSeconds = 0;
  currentMeta.lastEventTimestamp = null;
  currentMeta.recordingStartedAt = currentMeta.status === "recording" ? Date.now() : null;
  await saveMeta(currentDocKey, currentMeta);
  notify();
}

export async function resetRecording(): Promise<void> {
  if (!currentDocKey || !currentMeta) return;
  currentMeta = await fullReset(currentDocKey, currentMeta);
  notify();
}

export function openPlayback(): PlaybackSession | null {
  if (!currentDocKey || !currentMeta) return null;
  return createPlaybackSession(currentDocKey, currentMeta.frameGeneration);
}
