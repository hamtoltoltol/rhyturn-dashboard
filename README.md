# Rhyturn 야간안전 통합 운영 플랫폼 — 관제 대시보드 MVP

기준 문서: 소프트웨어 설계서 v1.0, 외주용역 과업지시서(요양시설 관리자 웹 대시보드 MVP)

## 구성
```
태블릿/브라우저 ──HTTP/WS──> server.js(L1 엣지 역할: 수집·판정·알람) <──(WS: 장치 접속 | HTTP: 서버가 장치 접속)── ESP32-S3
```
| 경로 | 내용 |
|---|---|
| `config/facility.json` | 공간 마스터(가온요양원: 3층 구관 A 301~307, 3층 신관 B 308~311, 2층 구관 C 201~207·신관 D 208~211 *가정*). 호실·구역은 코드에 하드코딩하지 않고 이 파일이 대시보드 그리드를 결정 |
| `public/engine.js` | 알람 엔진 (등급 6단계, 이벤트 E-01/E-02/E-03/E-07, 쿨다운 180초, 에스컬레이션 3분, Shadow Mode, 상태 흐름, 점검 S-01). 서버와 데모가 동일 코드 사용 |
| `public/` | 태블릿 PWA 화면 (현황·객실 상세·알람·시스템·로그·설정) |
| `server.js` | 인증, API, WebSocket, 영상 중계(메모리 전용, 저장 안 함) |
| `demo.html` | 서버 없이 더블클릭으로 열리는 데모 (`python3 build-demo.py`로 재생성) |
| `firmware/dimming_v3_ap` | 핫스팟(AP) 모드 펌웨어 (`XIAO-CAM`/`12345678`, 장치 1대 시험용) |
| `firmware/dimming_v3_ws` | 공유기 모드 + WebSocket 펌웨어 (호실 10대 이상) |

## 설계서 반영 현황
- 알람 6등급(▲긴급 ●주의 ◆관찰 ▬안정 ○부재 ▣점검): 색상·도형·좌측바(6/4/3/2px)·문구 3중 인코딩, 색은 상태만 표현(구역·층은 문구로만 구분), 라이트/다크 토큰
- 타일 색 = 미해소 알람 중 최고 등급, SYS(점검)는 별개 배지
- 알람 상태: 신규 → 확인 → 출동 → 해소 → 인계 / 오알람 분기, L4 3분 미확인 시 에스컬레이션, 모든 전이를 `alert_transition`에 행위자·시각과 기록(로그 화면)
- 화면: W-02 현황판, W-03 객실 상세, W-04 알람 대응, W-05 조명 제어(10단계 시나리오·밝기·색온도·4채널), W-07 로그, W-08 시스템, W-10 설정(임계값·Shadow Mode)
- 표현 규칙 준수: "수면의 질 점수" 미사용, 규칙 기반 판정(AI 이상행동 탐지로 부르지 않음)
- 영상은 서버 메모리에서만 중계하고 저장하지 않음(P1)

### 아직 구현하지 않은 것 (설계서 대비)
- 이벤트 E-04/E-05/E-06/E-08, 시스템 오류 S-02~S-07, 센서 퓨전(PIR/mmWave/ToF) — 현재 센서는 카메라·BH1750·장치 상태뿐
- 낙상/재실 **판정 모델**: 장치/분석 모듈이 `{type:'vision', present, fall}`을 보내면 알람이 생성됨(입력 지점만 구현)
- 역할 분리(RBAC)와 PIN 로그인, 보호자 앱, 클라우드(L2: NestJS/PostgreSQL), MQTT — 이번 MVP는 관리자 1계정, WebSocket/HTTP (과업지시서 기준)
- 호실별 침상 수·실면적·입소자 프로파일 등은 `null`(미확정)

## 서버 실행
```
npm install
ADMIN_USER=admin ADMIN_PASS=비번 DEVICE_TOKEN=장치토큰 SESSION_SECRET=임의문자열 node server.js
```
| 환경변수 | 설명 |
|---|---|
| `DEVICES` | HTTP 연결 장치 `308=http://192.168.4.1` (핫스팟 모드) |
| `SIM` | `0`이면 장치 없는 호실을 시뮬레이션하지 않음(운영) |
| `MAX_LIVE` | 동시 실시간 영상 호실 수(기본 4) |
| `FACILITY` | 다른 시설의 facility.json 경로 |
운영 시 `ADMIN_PASS`·`DEVICE_TOKEN` 변경과 HTTPS 필수.

## 핫스팟(AP)으로 실제 카메라 확인
1. `firmware/dimming_v3_ap/dimming_v3_ap.ino` 업로드 (라이브러리 `BH1750`, BH1750은 D4/D5)
2. PC Wi-Fi를 `XIAO-CAM`(`12345678`)에 연결
3. `start-hotspot.bat` 실행 → `http://localhost:3000` → **308호**에 실제 영상·조도, 나머지는 시뮬레이션
4. 태블릿도 같은 핫스팟에 연결해 `http://PC의IP:3000` 접속 (PC IP는 `ipconfig`)

## 태블릿 앱 설치(PWA)
태블릿 브라우저에서 접속 → "홈 화면에 추가". 기준 해상도 1280×800 가로, 세로/iPad 지원, 화면 꺼짐 방지.

## ESP32 Wi-Fi(10대 이상)
`firmware/dimming_v3_ws`의 `config.h`에서 호실(`ROOM_ID`, 예: "308")·Wi-Fi·서버 주소 설정. 2.4GHz 전용, AP 1대당 15~20대 이하, RSSI -70dBm 이상. 보지 않을 때 VGA 1fps(약 0.3Mbps), 볼 때 SVGA 10fps(약 4Mbps).
