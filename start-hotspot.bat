@echo off
chcp 65001 >nul
rem XIAO-CAM 핫스팟에 PC를 연결한 뒤 실행. 308호(PoC 신관)에 192.168.4.1 장치를 연결, 나머지 호실은 시뮬레이션
set DEVICES=308=http://192.168.4.1
set ADMIN_USER=admin
set ADMIN_PASS=rhyturn1234
if not exist node_modules call npm install
node server.js
pause
