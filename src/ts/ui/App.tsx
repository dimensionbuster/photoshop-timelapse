import React, { useEffect, useState } from "react";
import { shell } from "uxp";
import * as controller from "../core/controller";
import type { UiState } from "../core/types";
import { secondsToHHMMSS } from "../core/time-format";
import { checkForUpdate, type UpdateInfo } from "../core/update-check";
import { PlaybackPanel } from "./PlaybackPanel";
import { SettingsPanel } from "./SettingsPanel";

function statusLabel(status: UiState["status"]): string {
  switch (status) {
    case "recording":
      return "기록 중";
    case "stopped":
      return "일시정지";
    default:
      return "시작 전";
  }
}

interface Toast {
  message: string;
  isError: boolean;
}

export function App(): React.JSX.Element {
  const [state, setState] = useState<UiState>(controller.getState());
  const [toast, setToast] = useState<Toast>({ message: "", isError: false });
  const [showPlayback, setShowPlayback] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    void controller.refreshForActiveDocument();
    return unsubscribe;
  }, []);

  useEffect(() => {
    void checkForUpdate().then((info) => {
      if (info?.available) setUpdateInfo(info);
    });
  }, []);

  useEffect(() => {
    if (state.captureError) {
      setToast({ message: `프레임 캡처 실패: ${state.captureError}`, isError: true });
    }
  }, [state.captureError]);

  // The clock only *recalculates* accumulatedSeconds on a real history
  // event, so without a live tick here it visibly sat frozen any time the
  // user wasn't actively editing. This re-renders once a second while
  // recording so it reads like a running stopwatch, without changing how
  // accumulation itself works (still frozen past the 60s idle cutoff).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.status !== "recording") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [state.status]);

  const liveSeconds = (() => {
    if (state.status !== "recording" || state.lastEventTimestamp == null) {
      return state.accumulatedSeconds;
    }
    const gap = now - state.lastEventTimestamp;
    const cutoffMs = state.settings.idleCutoffSeconds * 1000;
    return gap > cutoffMs ? state.accumulatedSeconds : state.accumulatedSeconds + gap / 1000;
  })();

  // Wall-clock time: ticks purely off timestamps, so it's correct regardless
  // of whether Photoshop has focus or the panel was actively re-rendering.
  const rawWallSeconds =
    state.status !== "recording" || state.recordingStartedAt == null
      ? state.wallSeconds
      : state.wallSeconds + (now - state.recordingStartedAt) / 1000;
  // Wall time can never be less than work time (work is a subset of wall) —
  // this is a logical floor, not just a display nicety. wallSeconds is only
  // persisted periodically (see history-listener.ts's maybeFlush), so a
  // reload mid-recording can momentarily load a stale, lower wallSeconds off
  // disk than the accumulatedSeconds it's supposed to contain. Clamping here
  // keeps the displayed numbers self-consistent even during that window,
  // instead of briefly showing 전체 below 기록 중 시계.
  const liveWallSeconds = Math.max(rawWallSeconds, liveSeconds);
  const liveIdleSeconds = Math.max(0, liveWallSeconds - liveSeconds);
  // Clamped defensively: wallSeconds and accumulatedSeconds are flushed to
  // disk at different points (see history-listener.ts's maybeFlush), so a
  // narrow window can still see work time transiently exceed wall time.
  const workPercent = liveWallSeconds > 0 ? Math.min(100, Math.round((liveSeconds / liveWallSeconds) * 100)) : 0;

  const isRecording = state.status === "recording";
  const canToggle = isRecording || state.hasSavedDoc;
  const canExport = state.frameCount > 0;
  const canReset = state.hasSavedDoc;

  async function handleStart(): Promise<void> {
    try {
      await controller.start();
    } catch (e) {
      setToast({ message: `시작 실패: ${(e as Error).message}`, isError: true });
    }
  }

  function handleToggle(): void {
    if (isRecording) controller.stop();
    else void handleStart();
  }

  async function handleResetTimer(): Promise<void> {
    await controller.resetTimer();
    setToast({ message: "타이머를 초기화했습니다.", isError: false });
  }

  async function handleExport(): Promise<void> {
    setToast({ message: "MP4로 내보내는 중...", isError: false });
    try {
      const result = await controller.exportVideo();
      setToast({
        message: result.cancelled ? "" : `내보내기 완료: ${result.outputPath}`,
        isError: false,
      });
    } catch (e) {
      setToast({ message: `내보내기 실패: ${(e as Error).message}`, isError: true });
    }
  }

  async function handleResetConfirmed(): Promise<void> {
    setConfirmingReset(false);
    await controller.resetRecording();
    setToast({ message: "기록을 초기화했습니다.", isError: false });
  }

  if (showSettings) {
    return (
      <div id="app">
        <SettingsPanel state={state} onClose={() => setShowSettings(false)} />
      </div>
    );
  }

  if (showPlayback) {
    // Only the playback UI while it's open — stacking it below the full set
    // of controls was what pushed panel height past the UXP window's fixed
    // frame (no auto-resize, no scroll jank we want to rely on).
    return (
      <div id="app" className="app-fill">
        <PlaybackPanel
          onClose={() => setShowPlayback(false)}
          onNoFrames={(reason) => {
            setShowPlayback(false);
            setToast({
              message: reason === "no-session" ? "재생할 기록이 없습니다." : "재생할 프레임이 없습니다.",
              isError: false,
            });
          }}
          onError={(e) => {
            setShowPlayback(false);
            setToast({ message: `다시보기 실패: ${e instanceof Error ? e.message : String(e)}`, isError: true });
          }}
        />
      </div>
    );
  }

  return (
    <div id="app">
      {updateInfo ? (
        <div
          id="update-banner"
          className="update-banner"
          onClick={() =>
            void shell
              .openExternal(updateInfo.releaseUrl)
              .catch((e) => console.error("openExternal failed:", e))
          }
        >
          v{updateInfo.latestVersion} 사용 가능 (현재 v{updateInfo.currentVersion}) — 클릭해서 보기
        </div>
      ) : null}
      <div id="doc-name" className="doc-name">
        {state.docName || "(저장된 문서 없음)"}
      </div>
      <div id="hint" className="hint">
        {state.hasSavedDoc ? "" : "먼저 파일을 저장하세요."}
      </div>
      <div id="status-label" className="status-label">
        {statusLabel(state.status)}
      </div>
      <div id="clock" className="clock">
        {secondsToHHMMSS(liveSeconds)}
      </div>
      <div className="time-stats">
        <span>전체 {secondsToHHMMSS(liveWallSeconds)}</span>
        <span>논 시간 {secondsToHHMMSS(liveIdleSeconds)}</span>
      </div>
      <div className="frame-row">
        <span>
          프레임: <span id="frame-count">{state.frameCount}</span>
        </span>
        <span>작업 시간 비율: {String(workPercent).padStart(2, "0")}%</span>
      </div>

      <div className="button-row">
        <button id="btn-toggle" disabled={!canToggle} onClick={handleToggle}>
          {isRecording ? "정지" : "타임랩스 시작"}
        </button>
        <button id="btn-reset-timer" disabled={!state.hasSavedDoc} onClick={() => void handleResetTimer()}>
          타이머 초기화
        </button>
      </div>
      <div className="button-row">
        <button id="btn-playback" onClick={() => setShowPlayback(true)}>
          다시보기
        </button>
        <button id="btn-export" disabled={!canExport} onClick={() => void handleExport()}>
          영상 내보내기(MP4)
        </button>
      </div>
      <div className="button-row">
        <button id="btn-settings" onClick={() => setShowSettings(true)}>
          설정
        </button>
      </div>
      {confirmingReset ? (
        <div className="confirm-row">
          <span>기록을 모두 삭제할까요? 되돌릴 수 없습니다.</span>
          <div className="button-row">
            <button className="danger" onClick={() => void handleResetConfirmed()}>
              삭제
            </button>
            <button onClick={() => setConfirmingReset(false)}>취소</button>
          </div>
        </div>
      ) : (
        <div className="button-row">
          <button id="btn-reset" className="danger" disabled={!canReset} onClick={() => setConfirmingReset(true)}>
            기록 초기화
          </button>
        </div>
      )}
      <div id="status-toast" className={`toast${toast.isError ? " toast-error" : ""}`}>
        {toast.message}
      </div>
    </div>
  );
}
