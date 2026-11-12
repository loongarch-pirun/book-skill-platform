; installer.nsh — NSIS 自定义脚本（electron-builder 从 build/installer.nsh 自动拾取）
;
; 为什么需要这个文件：随包 MinerU 运行时会留下两处**用户看不见的残留**，
; 而 electron-builder 默认的卸载流程只删 $INSTDIR 与（可选）整个 $APPDATA\<app>：
;   1. 随包 doclib 是 detached 进程（刻意如此：关窗口不中断已开始的解析），
;      卸载时它很可能还在跑，占着 $INSTDIR\runtime\mineru-python 与 userData\mineru-home
;      下的文件 → RMDir 静默跳过 → 装一次留一份几百 MB 的运行时 + 解析缓存；
;   2. userData\mineru-home 与 userData\mineru-run 是可再生的运行时产物
;      （token 配置 + doclib 缓存 + 锁文件），**不是用户数据**：书库和原件在
;      userData\library、userData\books，那些必须留着。
;
; 本脚本只做两件精确限定的事：
;   A. 调 build\stop-mineru.ps1 停随包 doclib（按 endpoint.json 的 pid 树 + exe 路径前缀，
;      不会误杀用户自己 ~/.mineru 的 doclib）；
;   B. 删 mineru-home 与 mineru-run。
; 「连书库一起删干净」是安装器 deleteAppDataOnUninstall 的语义，本脚本不抢。

!macro customUnInstall
  ; A. 先停随包 doclib —— 不停则 B 里 RMDir 会静默失败，运行时目录也删不干净
  ;    参数用 $INSTDIR 与 $APPDATA\${APP_PACKAGE_NAME}：后者是 Electron userData 的真实目录名
  ;    （package.json name = book-skill-platform，不是 productName）。
  nsExec::ExecToLog `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\stop-mineru.ps1" -InstallDir "$INSTDIR" -HomeDir "$APPDATA\${APP_PACKAGE_NAME}\mineru-home"`
  Pop $0

  ; B. 只删运行时产物，不碰 library / books / 配置 / 日志
  RMDir /r "$APPDATA\${APP_PACKAGE_NAME}\mineru-home"
  RMDir /r "$APPDATA\${APP_PACKAGE_NAME}\mineru-run"
!macroend
