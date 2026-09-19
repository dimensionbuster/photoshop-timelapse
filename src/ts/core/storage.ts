import { storage } from "uxp";
import type { UxpEntry, UxpFileEntry, UxpFolderEntry } from "uxp";
import type { ExportRecord, TimelapseMeta } from "./types";
import { DEFAULT_CAPTURE_WIDTH, DEFAULT_SAMPLING_MODE, DEFAULT_IDLE_CUTOFF_SECONDS } from "./constants";

const FRAMES_FOLDER_NAME = /^frames(?:_g(\d+))?$/;

const fs = storage.localFileSystem;

// docKey -> meta object (mutable, shared by reference across modules)
const metaCache = new Map<string, TimelapseMeta>();

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function computeDocKey(docPath: string): string {
  return fnv1a(docPath);
}

function defaultMeta(docPath: string, docName: string): TimelapseMeta {
  return {
    docPath,
    docName,
    status: "not_started",
    createdAt: null,
    accumulatedSeconds: 0,
    frameCount: 0,
    lastEventTimestamp: null,
    recordingStartedAt: null,
    wallSeconds: 0,
    exportHistory: [],
    settings: {
      samplingMode: DEFAULT_SAMPLING_MODE,
      captureWidth: DEFAULT_CAPTURE_WIDTH,
      idleCutoffSeconds: DEFAULT_IDLE_CUTOFF_SECONDS,
    },
    frameGeneration: 0,
    captureStride: 1,
    eventsSinceLastCapture: 0,
  };
}

async function getOrCreateFolder(parent: UxpFolderEntry, name: string): Promise<UxpFolderEntry> {
  try {
    const entry = await parent.getEntry(name);
    return entry as UxpFolderEntry;
  } catch (e) {
    return parent.createFolder(name);
  }
}

async function getRecordingsRoot(): Promise<UxpFolderEntry> {
  const dataFolder = await fs.getDataFolder();
  return getOrCreateFolder(dataFolder, "recordings");
}

async function getRecordingFolder(docKey: string): Promise<UxpFolderEntry> {
  const root = await getRecordingsRoot();
  return getOrCreateFolder(root, docKey);
}

function framesFolderName(generation: number): string {
  return generation === 0 ? "frames" : `frames_g${generation}`;
}

export async function getFramesFolder(docKey: string, generation: number): Promise<UxpFolderEntry> {
  const recording = await getRecordingFolder(docKey);
  return getOrCreateFolder(recording, framesFolderName(generation));
}

async function deleteEntryRecursive(entry: UxpEntry): Promise<void> {
  if (entry.isFolder) {
    const children = await entry.getEntries();
    await Promise.all(children.map((c) => deleteEntryRecursive(c)));
  }
  await entry.delete().catch(() => undefined);
}

// Deletes every past-generation frames_g{N} folder except the one currently
// pointed to by meta.frameGeneration. Run once per cold load (never while a
// doc's meta is warm in metaCache) so an in-session PlaybackPanel that
// snapshotted an older generation's file list is never pulled out from
// under it — see the "realtime" compaction design in capture-queue.ts.
async function gcStaleGenerations(docKey: string, currentGeneration: number): Promise<void> {
  try {
    const recording = await getRecordingFolder(docKey);
    const entries = await recording.getEntries();
    for (const e of entries) {
      if (!e.isFolder) continue;
      const match = FRAMES_FOLDER_NAME.exec(e.name);
      if (!match) continue;
      const gen = match[1] ? Number(match[1]) : 0;
      if (gen !== currentGeneration) {
        await deleteEntryRecursive(e);
      }
    }
  } catch (e) {
    // best-effort cleanup only, never blocks meta loading
  }
}

export async function getTmpFolder(): Promise<UxpFolderEntry> {
  const dataFolder = await fs.getDataFolder();
  return getOrCreateFolder(dataFolder, "tmp");
}

export async function getFfmpegEntry(): Promise<UxpFileEntry> {
  const pluginFolder = await fs.getPluginFolder();
  const ffmpegFolder = (await pluginFolder.getEntry("ffmpeg")) as UxpFolderEntry;
  return ffmpegFolder.getEntry("ffmpeg.exe") as Promise<UxpFileEntry>;
}

async function loadMetaFromDisk(docKey: string, docPath: string, docName: string): Promise<TimelapseMeta> {
  const folder = await getRecordingFolder(docKey);
  try {
    const entry = (await folder.getEntry("meta.json")) as UxpFileEntry;
    const text = (await entry.read({ format: storage.formats.utf8 })) as string;
    const parsed = JSON.parse(text) as Partial<TimelapseMeta>;
    // keep docPath/docName fresh in case the file moved slightly or name changed
    parsed.docPath = docPath;
    parsed.docName = docName;
    // Backfill fields that didn't exist in older meta.json files. Every
    // default here reproduces the pre-existing behavior exactly (generation
    // 0 = the original flat "frames" folder, stride 1 = capture every
    // event, "selective" = today's unthrottled capture + full-cache export).
    parsed.settings = parsed.settings ?? { samplingMode: DEFAULT_SAMPLING_MODE, captureWidth: DEFAULT_CAPTURE_WIDTH, idleCutoffSeconds: DEFAULT_IDLE_CUTOFF_SECONDS };
    parsed.settings.idleCutoffSeconds = parsed.settings.idleCutoffSeconds ?? DEFAULT_IDLE_CUTOFF_SECONDS;
    parsed.frameGeneration = parsed.frameGeneration ?? 0;
    parsed.captureStride = parsed.captureStride ?? 1;
    parsed.eventsSinceLastCapture = parsed.eventsSinceLastCapture ?? 0;
    parsed.recordingStartedAt = parsed.recordingStartedAt ?? null;
    parsed.wallSeconds = parsed.wallSeconds ?? 0;
    const meta = parsed as TimelapseMeta;
    await gcStaleGenerations(docKey, meta.frameGeneration);
    return meta;
  } catch (e) {
    return defaultMeta(docPath, docName);
  }
}

export async function ensureMetaLoaded(docKey: string, docPath: string, docName: string): Promise<TimelapseMeta> {
  const cached = metaCache.get(docKey);
  if (cached) {
    cached.docName = docName;
    return cached;
  }
  const meta = await loadMetaFromDisk(docKey, docPath, docName);
  metaCache.set(docKey, meta);
  return meta;
}

export function getCachedMeta(docKey: string): TimelapseMeta | null {
  return metaCache.get(docKey) || null;
}

export async function saveMeta(docKey: string, meta: TimelapseMeta): Promise<void> {
  const folder = await getRecordingFolder(docKey);
  const entry = await folder.createFile("meta.json", { overwrite: true });
  await entry.write(JSON.stringify(meta, null, 2), { format: storage.formats.utf8 });
}

export async function listFrameEntries(docKey: string, generation: number): Promise<UxpFileEntry[]> {
  const frames = await getFramesFolder(docKey, generation);
  const entries = await frames.getEntries();
  return entries
    .filter((e): e is UxpFileEntry => e.isFile && e.name.toLowerCase().endsWith(".jpg"))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Evenly-spaced subset of `frames` so the result has at most `budget`
// entries, always including the first and last frame. Used at export time to
// enforce MAX_EXPORT_SECONDS regardless of sampling mode (see export-ffmpeg.ts).
export function selectExportFrames(frames: UxpFileEntry[], budget: number): UxpFileEntry[] {
  const n = frames.length;
  if (n <= budget || budget <= 1) return frames;
  const picks: UxpFileEntry[] = [];
  let lastIndex = -1;
  for (let i = 0; i < budget; i++) {
    const srcIndex = Math.round((i * (n - 1)) / (budget - 1));
    if (srcIndex === lastIndex) continue; // guards float-rounding collisions when n is only slightly > budget
    const frame = frames[srcIndex];
    if (frame) picks.push(frame);
    lastIndex = srcIndex;
  }
  return picks;
}

// Wipes every past and present frames_g{N} folder for a doc (used only by
// fullReset — a normal export or realtime compaction never deletes frames).
async function clearAllFrameGenerations(docKey: string): Promise<void> {
  const recording = await getRecordingFolder(docKey);
  const entries = await recording.getEntries();
  await Promise.all(
    entries.filter((e) => e.isFolder && FRAMES_FOLDER_NAME.test(e.name)).map((e) => deleteEntryRecursive(e))
  );
}

// After a successful MP4 export: just log it. Frames/accumulated time/frame count
// stay untouched so drawing can continue and a later export still covers the
// full session — only the manual "기록 초기화" (fullReset) wipes that.
export async function exportCleanup(
  docKey: string,
  meta: TimelapseMeta,
  exportRecord: ExportRecord
): Promise<TimelapseMeta> {
  meta.exportHistory = meta.exportHistory || [];
  meta.exportHistory.push(exportRecord);
  await saveMeta(docKey, meta);
  return meta;
}

// Manual "기록 초기화": wipe everything, stop recording, back to not_started.
// settings (captureWidth/samplingMode) are deliberately NOT reset — clearing
// the cache is what unlocks them for editing again, not this function.
export async function fullReset(docKey: string, meta: TimelapseMeta): Promise<TimelapseMeta> {
  await clearAllFrameGenerations(docKey);
  meta.status = "not_started";
  meta.createdAt = null;
  meta.accumulatedSeconds = 0;
  meta.frameCount = 0;
  meta.lastEventTimestamp = null;
  meta.recordingStartedAt = null;
  meta.wallSeconds = 0;
  meta.exportHistory = [];
  meta.frameGeneration = 0;
  meta.captureStride = 1;
  meta.eventsSinceLastCapture = 0;
  await saveMeta(docKey, meta);
  return meta;
}
