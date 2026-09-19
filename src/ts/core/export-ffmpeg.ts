import { storage as uxpStorage, shell } from "uxp";
import type { UxpFolderEntry } from "uxp";
import { listFrameEntries, selectExportFrames, getFramesFolder, getTmpFolder, getFfmpegEntry, exportCleanup } from "./storage";
import { DEFAULT_FRAMERATE, REALTIME_FRAME_BUDGET } from "./constants";
import type { TimelapseMeta } from "./types";

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PollResult {
  ok: boolean;
  timedOut?: boolean;
}

async function pollForCompletion(statusEntry: { read(options?: { format?: string }): Promise<string | ArrayBuffer> }): Promise<PollResult> {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await delay(POLL_INTERVAL_MS);
    try {
      const text = (await statusEntry.read({ format: uxpStorage.formats.utf8 })) as string;
      if (text && text.trim().length > 0) {
        const parsed = JSON.parse(text) as { exitCode: string | number };
        return { ok: String(parsed.exitCode) === "0" };
      }
    } catch (e) {
      // sentinel file not written yet, keep polling
    }
  }
  return { ok: false, timedOut: true };
}

interface ExportFrameSource {
  folder: UxpFolderEntry;
  cleanup: (() => Promise<void>) | null;
}

// Regardless of sampling mode, never feed more than the export budget to
// ffmpeg — "realtime" mode should already keep frameCount at or under budget,
// but this also acts as a safety net for the narrow window right after the
// budget is crossed and before a realtime compaction finishes, and it's what
// actually enforces the cap for "selective" mode's unbounded cache.
async function resolveExportFrameSource(docKey: string, meta: TimelapseMeta, budget: number): Promise<ExportFrameSource> {
  const allFrames = await listFrameEntries(docKey, meta.frameGeneration);
  if (allFrames.length <= budget) {
    return { folder: await getFramesFolder(docKey, meta.frameGeneration), cleanup: null };
  }

  // Copy (not symlink — no such primitive in the UXP storage API used here,
  // and Windows symlinks need elevated privileges) the selected subset into
  // a sequentially-renumbered temp folder so ffmpeg's %06d glob stays
  // contiguous. The original frames folder is never touched — exporting
  // must stay non-destructive to the cache.
  const subset = selectExportFrames(allFrames, budget);
  const tmpRoot = await getTmpFolder();
  const subsetFolder = await tmpRoot.createFolder(`export_subset_${Date.now()}`);
  for (let i = 0; i < subset.length; i++) {
    const entry = subset[i];
    if (!entry) continue;
    const bytes = await entry.read({ format: uxpStorage.formats.binary });
    const dst = await subsetFolder.createFile(String(i + 1).padStart(6, "0") + ".jpg", { overwrite: true });
    await dst.write(bytes, { format: uxpStorage.formats.binary });
  }
  return { folder: subsetFolder, cleanup: () => subsetFolder.delete().then(() => undefined).catch(() => undefined) };
}

export interface ExportResult {
  cancelled: boolean;
  outputPath?: string;
}

export async function exportToMp4(
  docKey: string,
  meta: TimelapseMeta,
  { framerate = DEFAULT_FRAMERATE }: { framerate?: number } = {}
): Promise<ExportResult> {
  if (meta.frameCount === 0) {
    throw new Error("내보낼 프레임이 없습니다.");
  }

  const fs = uxpStorage.localFileSystem;
  const baseName = (meta.docName || "timelapse").replace(/\.[^./\\]+$/, "");
  const outputEntry = await fs.getFileForSaving(`${baseName}_timelapse.mp4`, { types: ["mp4"] });
  if (!outputEntry) {
    return { cancelled: true };
  }

  const source = await resolveExportFrameSource(docKey, meta, REALTIME_FRAME_BUDGET);
  const tmpFolder = await getTmpFolder();
  const ffmpegEntry = await getFfmpegEntry();

  const ts = Date.now();
  const batEntry = await tmpFolder.createFile(`export_${ts}.bat`, { overwrite: true });
  const statusEntry = await tmpFolder.createFile(`export_${ts}_status.json`, { overwrite: true });

  try {
    // %% escapes cmd.exe's own %N parameter substitution so ffmpeg still sees %06d
    const inputPattern = `${source.folder.nativePath}\\%%06d.jpg`;
    const script = [
      "@echo off",
      // cmd.exe runs .bat files using the system's active codepage (e.g. CP949
      // on Korean Windows), not UTF-8 — the .bat itself is written as UTF-8, so
      // a Korean document name flowing into the output filename got mangled on
      // the way to ffmpeg's argv, which then rejected it with EINVAL (-22).
      // Switching the console to UTF-8 (65001) before running ffmpeg fixes it.
      "chcp 65001 >nul",
      // libx264+yuv420p requires even width/height (chroma is subsampled by
      // 2). We only pin capture width to a fixed setting and let height follow
      // the document's aspect ratio, so odd heights (e.g. 1357) are common and
      // libx264 refuses to open the encoder for them — force both dimensions
      // even here regardless of what the source frames measure.
      `"${ffmpegEntry.nativePath}" -y -framerate ${framerate} -i "${inputPattern}" -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -pix_fmt yuv420p "${outputEntry.nativePath}"`,
      `echo {"exitCode": "%errorlevel%"}> "${statusEntry.nativePath}"`,
    ].join("\r\n");
    await batEntry.write(script, { format: uxpStorage.formats.utf8 });

    await shell.openPath(
      batEntry.nativePath,
      "타임랩스 플러그인이 MP4로 내보내기 위해 ffmpeg.exe를 실행해야 합니다."
    );

    const result = await pollForCompletion(statusEntry);
    if (!result.ok) {
      throw new Error(
        result.timedOut
          ? "ffmpeg 실행이 시간 내에 끝나지 않았습니다."
          : "ffmpeg 실행에 실패했습니다."
      );
    }

    const outputMeta = await outputEntry.getMetadata();
    if (!outputMeta || outputMeta.size === 0) {
      throw new Error("MP4 파일이 생성되지 않았습니다.");
    }

    const exportRecord = {
      exportedAt: Date.now(),
      frameCountAtExport: meta.frameCount,
      outputPath: outputEntry.nativePath,
    };
    await exportCleanup(docKey, meta, exportRecord);

    return { cancelled: false, outputPath: outputEntry.nativePath };
  } finally {
    await batEntry.delete().catch(() => undefined);
    await statusEntry.delete().catch(() => undefined);
    await source.cleanup?.();
  }
}
