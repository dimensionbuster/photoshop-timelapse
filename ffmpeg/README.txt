ffmpeg.exe를 이 폴더에 직접 넣어야 합니다 (자동 다운로드 안 됨).

**중요: 반드시 static(정적 링크) 빌드를 받으세요.** ffmpeg.exe 하나만 있고
avcodec-XX.dll / avdevice-XX.dll / avformat-XX.dll 같은 별도 DLL이 필요한
"shared" 빌드를 받으면 실행 시 "avdevice-XX.dll이(가) 없어..." 에러가 납니다.
static 빌드의 ffmpeg.exe는 보통 70~150MB입니다 — 받은 파일이 수백 KB~수 MB면
shared 빌드를 잘못 받은 것이니 다시 받으세요.

받는 곳 (둘 중 하나, Windows static 빌드):
- https://www.gyan.dev/ffmpeg/builds/ → "release essentials" 또는 "release full"
  (파일명에 "shared"가 들어간 건 피하세요)
- https://github.com/BtbN/FFmpeg-Builds/releases → 파일명에 "shared"가 아니라
  그냥 "win64-gpl.zip" 같은 걸 받으세요 (BtbN은 static/shared를 파일명으로 구분)

받은 압축 안의 bin\ffmpeg.exe 하나만 꺼내서 여기 경로에 두면 됩니다:
  ffmpeg\ffmpeg.exe

(shared 빌드밖에 없다면 bin\ 폴더 안의 ffmpeg.exe + 모든 *.dll을 전부 이 폴더에
같이 복사해도 됩니다 — exe와 같은 폴더에 dll이 있으면 윈도우가 찾아서 씁니다.)

주의: libx264 포함된 static 빌드는 보통 GPL 라이선스입니다. 개인용으로 쓰는 건 문제없지만,
이 플러그인을 다른 사람에게 배포할 계획이면 라이선스 고지/소스 제공 의무를 확인하세요.
