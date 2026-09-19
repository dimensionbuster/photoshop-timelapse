# Photoshop Timelapse (UXP)

클립스튜디오 페인트의 타임랩스 기능을 포토샵에서 재현하는 UXP 플러그인.
TypeScript + React(18) + esbuild. UI는 `src/ts/ui/`, PS/UXP를 직접 다루는 로직은 프레임워크 무관하게 `src/ts/core/`에 분리.

## 기능

- **타임랩스 시작**: 저장된 문서 기준으로 히스토리 변경을 감지해 기록 시작.
- **실제 누적 작업시간**: 히스토리 이벤트 간 간격이 60초 이하일 때만 누적 (유휴시간 제외), `HH:MM:SS`로 표시.
- **다시보기**: 저장된 프레임을 슬라이더로 스크럽하거나 재생.
- **영상 내보내기(MP4)**: 번들된 `ffmpeg.exe`를 `.bat` + `shell.openPath`로 실행해 프레임 시퀀스를 MP4로 인코딩.
- **기록 초기화**: 현재 문서의 누적시간/프레임/메타정보 전부 삭제.
- **내보내기 후 캐시 자동 삭제**: 내보내기 성공 시 프레임 이미지 + 누적시간/프레임수를 초기화하고 바로 다음 구간 기록을 이어감 (내보낸 이력은 `exportHistory`에 남음).

세부 설계는 `C:\Users\kiamm\.claude\plans\photoshop-federated-codd.md` 참고.

## 설치

### 1. 준비물

1. **Adobe UXP Developer Tool** — Creative Cloud 앱에서 검색 설치, 또는 `developer.adobe.com/photoshop/uxp`에서 다운로드.
2. **ffmpeg.exe** — `ffmpeg/README.txt` 참고해서 `ffmpeg/ffmpeg.exe`에 배치 (저장소에는 포함 안 됨, `.gitignore` 처리됨).
3. Node.js (이미 설치돼 있음: v22.21.1).

### 2. 저장소 클론 & 빌드

```
git clone https://github.com/dimensionbuster/photoshop-timelapse.git
cd photoshop-timelapse
npm install
npm run typecheck  # tsc --noEmit — 수정할 때마다 실행
npm run build      # typecheck 통과 후 esbuild 번들 (dist/bundle.js)
```

`photoshop`/`uxp` 모듈 타입: `photoshop`은 `@types/photoshop`(DefinitelyTyped), `uxp`는 공식 타입 패키지가 없어서 실제로 쓰는 범위만 `src/ts/types/uxp.d.ts`에 직접 선언.

### 3. UXP Developer Tool에서 플러그인 로드

1. "Add Plugin" → 이 폴더의 `manifest.json` 선택.
2. Photoshop 실행 중인 상태에서 "Load".
3. Photoshop 메뉴 Plugins > Timelapse 패널 열기.

### 4. 개발 모드

```
npm run watch  # esbuild --watch (타입체크는 안 됨, 저장 시 번들만 재생성)
```

`npm run watch` 켜두고 UDT의 "Watch" 옵션도 켜면 저장할 때마다 자동 리로드됨.

## 알려진 제약 (v1)

- 저장된 적 없는 문서는 기록 불가 (Start 버튼 비활성).
- 한 번에 활성 문서 1개만 기록 (멀티 문서 동시 기록은 v2 과제).
- 매 히스토리 상태마다 프레임을 캡처하므로 오래 작업할수록 데이터 폴더 용량이 커짐 — 영상 내보내기 후 자동 정리됨. (한때 캡처를 1초로 스로틀링했었는데, `executeAsModal`에 `interactive: true`를 넣은 뒤로는 안 그래도 커서/버튼 문제가 없어서 다시 뺐음 — 브러시 연타로 문제 재발하면 `history-listener.ts`에 스로틀 다시 넣을 것.)
