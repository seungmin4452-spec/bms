' 관리 웹(127.0.0.1:20020)을 콘솔 창 없이 띄운다. 작업 스케줄러 "PigonAdminWeb" 이 로그온 때 실행한다.
' 서버가 끝날 때까지 기다리므로, 서버가 죽으면 작업 스케줄러가 실패로 보고 다시 실행한다.
' 이미 떠 있으면 포트 충돌로 바로 종료된다(중복 실행 안 됨). 출력은 logs\admin-web.log
Set sh = CreateObject("WScript.Shell")
root = "C:\Users\SMSHIN\pigon-chat-bot"
sh.CurrentDirectory = root
cmd = "cmd /c """"C:\Program Files\nodejs\node.exe"" """ & root & "\admin\server.js"" >> """ & root & "\logs\admin-web.log"" 2>&1"""
WScript.Quit sh.Run(cmd, 0, True)
