import type { FrameInfo } from "./types";

export interface FrameRect {
  // position/size of the frame relative to the output canvas (px); the
  // canvas is always the size of the latest frame, so x/y can be negative
  // (frame sticks out → cropped) or positive (frame is smaller → padded).
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OutputCanvas {
  w: number;
  h: number;
}

// Output canvas = latest frame. Every frame is placed so its content lines
// up with the latest frame's content (global ox/oy coordinates).
export function outputCanvas(frames: FrameInfo[]): OutputCanvas | null {
  const last = frames[frames.length - 1];
  return last ? { w: last.w, h: last.h } : null;
}

export function frameRect(frame: FrameInfo, frames: FrameInfo[]): FrameRect | null {
  const last = frames[frames.length - 1];
  if (!last) return null;
  return { x: frame.ox - last.ox, y: frame.oy - last.oy, w: frame.w, h: frame.h };
}

export function sameGeometry(a: FrameInfo, b: FrameInfo): boolean {
  return a.w === b.w && a.h === b.h && a.ox === b.ox && a.oy === b.oy;
}
