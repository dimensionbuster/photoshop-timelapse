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
