import React from "react";
import * as controller from "../core/controller";
import type { SamplingMode, UiState } from "../core/types";
import { CAPTURE_WIDTH_OPTIONS, IDLE_CUTOFF_OPTIONS } from "../core/constants";

interface Props {
  state: UiState;
  onClose(): void;
}

export function SettingsPanel({ state, onClose }: Props): React.JSX.Element {
  return (
    <div id="settings-section">
      <div className="settings-row">
        <label>
          해상도
          <select
            value={state.settings.captureWidth}
            disabled={state.settingsLocked}
            onChange={(e) => void controller.updateSettings({ captureWidth: Number(e.target.value) })}
          >
            {CAPTURE_WIDTH_OPTIONS.map((width) => (
              <option key={width} value={width}>
                {width}px
              </option>
            ))}
          </select>
        </label>
        <label>
          <div>캡처 방식</div>
          <div className="tips">선택적 방식은 용량이 크고, 실시간 방식은 기록 중 압축을 수행하므로 CPU 사용량이 높아질 수 있습니다.</div>
          <select
            value={state.settings.samplingMode}
            disabled={state.settingsLocked}
            onChange={(e) => void controller.updateSettings({ samplingMode: e.target.value as SamplingMode })}
          >
            <option value="selective">선택적 (기록 후 압축)</option>
            <option value="realtime">실시간 (기록 중 압축)</option>
          </select>
        </label>
        <label>
          무작업 판정 시간
          <select
            value={state.settings.idleCutoffSeconds}
            disabled={state.settingsLocked}
            onChange={(e) => void controller.updateSettings({ idleCutoffSeconds: Number(e.target.value) })}
          >
            {IDLE_CUTOFF_OPTIONS.map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds}초
              </option>
            ))}
          </select>
        </label>
      </div>
      {state.settingsLocked && state.hasSavedDoc ? (
        <div className="hint">설정은 기록을 시작하기 전(프레임 0개)에만 변경할 수 있습니다. 바꾸려면 먼저 기록을 초기화하세요.</div>
      ) : null}
      <div className="button-row">
        <button onClick={onClose}>닫기</button>
      </div>
    </div>
  );
}
