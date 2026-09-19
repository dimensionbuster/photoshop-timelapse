// gaps longer than this are excluded from accumulated (active) time — now a
// per-document setting (meta.settings.idleCutoffSeconds), these are just its
// default and the options offered in the settings UI.
export const DEFAULT_IDLE_CUTOFF_SECONDS = 30;
export const IDLE_CUTOFF_OPTIONS = [10, 30, 60, 120] as const;

// Hard cap on exported video length. Long recordings must be thinned down to
// fit this either at capture time ("realtime" sampling) or at export time
// ("selective" sampling) — see capture-queue.ts and export-ffmpeg.ts.
export const MAX_EXPORT_SECONDS = 60;
export const DEFAULT_FRAMERATE = 30;
export const REALTIME_FRAME_BUDGET = MAX_EXPORT_SECONDS * DEFAULT_FRAMERATE;

export const DEFAULT_CAPTURE_WIDTH = 960;
export const CAPTURE_WIDTH_OPTIONS = [960, 1280, 1920] as const;

// Bare string literal (not importing SamplingMode from ./types) to avoid a
// constants.ts -> types.ts dependency; it still structurally matches.
export const DEFAULT_SAMPLING_MODE = "selective" as const;
