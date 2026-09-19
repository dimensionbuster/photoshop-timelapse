import React, { useEffect, useRef, useState } from "react";
import * as controller from "../core/controller";
import type { PlaybackSession } from "../core/playback";

const PLAY_INTERVAL_MS = 1000 / 12;
const LOAD_TIMEOUT_MS = 400;

interface Props {
  onClose(): void;
  onNoFrames(reason: "no-session" | "no-frames"): void;
  onError(error: unknown): void;
}

function loadInto(el: HTMLImageElement, dataUrl: string): Promise<void> {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, LOAD_TIMEOUT_MS);
    el.onload = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    el.onerror = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    el.src = dataUrl;
  });
}

export function PlaybackPanel({ onClose, onNoFrames, onError }: Props): React.JSX.Element | null {
  const sessionRef = useRef<PlaybackSession | null>(null);
  const indexRef = useRef(0);
  const countRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  // Bumped on every showFrame() call; a stale in-flight call (superseded by
  // a newer one, e.g. from fast slider dragging) checks this after each
  // await and bails instead of overwriting the display with an old frame.
  const requestIdRef = useRef(0);
  // Two stacked <img> elements swapped by toggling which is on top, instead
  // of reusing one element's src. UXP's webview has no drawImage() on
  // canvas 2d and no decode() on <img>, so there's no way to know a single
  // element's new src is actually painted before swapping it in — but
  // load *does* fire reliably on an in-DOM <img>, so we can fully load the
  // next frame into the currently-hidden element, and only then flip
  // opacity, which is an instant compositing change with no new decode.
  const imgARef = useRef<HTMLImageElement | null>(null);
  const imgBRef = useRef<HTMLImageElement | null>(null);
  const frontIsARef = useRef(true);

  const [frontIsA, setFrontIsA] = useState(true);
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = controller.openPlayback();
        if (!session) {
          onNoFrames("no-session");
          return;
        }
        sessionRef.current = session;
        const c = await session.load();
        if (cancelled) return;
        if (c === 0) {
          onNoFrames("no-frames");
          return;
        }
        countRef.current = c;
        setCount(c);
        setReady(true);
        await showFrame(0);
      } catch (e) {
        if (!cancelled) onError(e);
      }
    })();
    return () => {
      cancelled = true;
      stopPlaying();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function showFrame(i: number): Promise<void> {
    const session = sessionRef.current;
    if (!session) return;
    const myRequest = ++requestIdRef.current;
    indexRef.current = i;
    setIndex(i);
    try {
      const dataUrl = await session.frameAt(i);
      if (!dataUrl || myRequest !== requestIdRef.current) return;
      const backEl = frontIsARef.current ? imgBRef.current : imgARef.current;
      if (!backEl) return;
      await loadInto(backEl, dataUrl);
      if (myRequest !== requestIdRef.current) return;
      frontIsARef.current = !frontIsARef.current;
      setFrontIsA(frontIsARef.current);
    } catch (e) {
      onError(e);
    }
  }

  function stopPlaying(): void {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setPlaying(false);
  }

  function togglePlay(): void {
    if (timerRef.current != null) {
      stopPlaying();
      return;
    }
    setPlaying(true);
    timerRef.current = window.setInterval(() => {
      if (indexRef.current >= countRef.current - 1) {
        stopPlaying();
        return;
      }
      void showFrame(indexRef.current + 1);
    }, PLAY_INTERVAL_MS);
  }

  function handleClose(): void {
    stopPlaying();
    onClose();
  }

  if (!ready) return null;

  const layerStyle = (visible: boolean): React.CSSProperties => ({
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "contain",
    opacity: visible ? 1 : 0,
  });

  return (
    <div id="playback-section">
      <div id="playback-image">
        <img ref={imgARef} alt="frame preview" style={layerStyle(frontIsA)} />
        <img ref={imgBRef} alt="" aria-hidden="true" style={layerStyle(!frontIsA)} />
      </div>
      <div className="playback-index">
        {index + 1} / {count}
      </div>
      <input
        id="playback-slider"
        type="range"
        min={0}
        max={Math.max(0, count - 1)}
        step={1}
        value={index}
        onChange={(e) => void showFrame(Math.round(Number(e.target.value)))}
      />
      <div className="button-row">
        <button onClick={togglePlay}>{playing ? "정지" : "재생"}</button>
        <button onClick={handleClose}>닫기</button>
      </div>
    </div>
  );
}
