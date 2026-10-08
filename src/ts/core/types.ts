export type RecordingStatus = "not_started" | "recording" | "stopped";

export type SamplingMode = "selective" | "realtime";

export interface TimelapseSettings {
  samplingMode: SamplingMode;
  captureWidth: number;
  idleCutoffSeconds: number;
}

export interface ExportRecord {
  exportedAt: number;
  frameCountAtExport: number;
  outputPath: string;
}

// Per-frame geometry. w/h = JPEG pixel size; ox/oy = position of the frame's
// top-left in a global content coordinate space (capture px, first frame at
// 0,0). Canvas-size changes shift ox/oy so content stays put across frames.
export interface FrameInfo {
  w: number;
  h: number;
  ox: number;
  oy: number;
}

export interface TimelapseMeta {
  docPath: string;
  docName: string;
  status: RecordingStatus;
  createdAt: number | null;
  accumulatedSeconds: number;
  frameCount: number;
  lastEventTimestamp: number | null;
  // Wall-clock (not gap-filtered) recording time. recordingStartedAt marks
  // when the current "recording" segment began; wallSeconds accumulates
  // completed segments on stop(). Together with accumulatedSeconds (which
  // excludes idle gaps) this is what lets the UI show idle time as their
  // difference.
  recordingStartedAt: number | null;
  wallSeconds: number;
  exportHistory: ExportRecord[];
  settings: TimelapseSettings;
  // Which frames_g{N} folder (generation 0 == the original "frames" folder)
  // is currently canonical. Only "realtime" sampling ever advances this;
  // "selective" recordings stay on generation 0 forever.
  frameGeneration: number;
  // History events required between captures. Always 1 in "selective" mode
  // (capture every event, exactly like before this field existed).
  captureStride: number;
  eventsSinceLastCapture: number;
  // capture px per document px, fixed at the first capture so a canvas-size
  // change never rescales content. null until the first frame.
  captureScale: number | null;
  // Parallel to frame files (frames[i] describes frame i+1). Empty for
  // recordings made before this field existed.
  frames: FrameInfo[];
}

export interface UiState {
  hasSavedDoc: boolean;
  docName: string | null;
  status: RecordingStatus | "not_started";
  accumulatedSeconds: number;
  formattedTime: string;
  lastEventTimestamp: number | null;
  recordingStartedAt: number | null;
  wallSeconds: number;
  frameCount: number;
  captureError: string | null;
  settings: TimelapseSettings;
  settingsLocked: boolean;
}
