# Rhyturn 요양시설 관제 대시보드

## 구성
```
브라우저/태블릿 앱 ──HTTPS/WSS──> 클라우드 서버(server.js) <──WSS(장치가 먼저 접속)── ESP32-S3 × 호실 수
```
- `server.js` 서버, `public/` 화면(PWA), `demo.html` 서버 없이 열리는 데모
- `firmware/dimming_v3_ws/` 호실 모듈 펌웨어 (호실마다 `config.h`의 `ROOM_ID`만 변경)
- `firmware/dimming_v2_sta/` 이전 버전(공유기 접속 + 로컬 웹서버, 단독 시험용)

## 서버 실행
```
npm install
ADMIN_USER=admin ADMIN_PASS=비번 DEVICE_TOKEN=장치토큰 SESSION_SECRET=임의문자열 ROOM_COUNT=10 node server.js
```
| 환경변수 | 기본 | 설명 |
|---|---|---|
| ROOM_COUNT | 10 | 호실 수 (101부터 순번, 최대 60) |
| MAX_LIVE | 4 | 동시에 실시간 영상을 볼 수 있는 호실 수 |
| SIM | 1 | 1: 장치가 없는 호실은 시뮬레이션, 0: 끄기(운영) |
| ADMIN_PASS / DEVICE_TOKEN | 기본값 있음 | **운영 시 반드시 변경** |

운영 시 HTTPS 필수(리버스 프록시: Caddy/nginx 등, WebSocket 업그레이드 허용). 영상은 메모리로만 중계하고 저장하지 않습니다.

## 태블릿 앱으로 설치 (PWA)
1. 태블릿 크롬/사파리에서 `https://서버주소` 접속 → 로그인
2. 메뉴 → "홈 화면에 추가 / 앱 설치" → 전체화면 앱으로 실행
3. 기준 화면: 10인치 1280×800 가로(10개 호실이 스크롤 없이 한 화면), 세로/iPad 1024×768도 지원
4. 관제용으로 화면 꺼짐 방지(Wake Lock) 적용

스토어 배포용 APK/IPA가 필요하면 Capacitor로 같은 화면을 감싸면 됩니다.
`npm i @capacitor/core @capacitor/cli @capacitor/android` → `npx cap init Rhyturn kr.rhyturn.app` → `server.url`에 서버 주소 지정 → `npx cap add android`

## ESP32 Wi-Fi 운영 가이드 (10대 이상)
- **2.4GHz 전용**. 공유기 2.4GHz에 호실 장치 전용 SSID를 두고 채널은 1/6/11 중 간섭 적은 곳으로 고정
- 공유기/AP 1대당 장치 15~20대 이하 권장 (층/복도마다 AP 분산). 장치는 RSSI -70dBm 이상 확보(대시보드 호실 상세에 표시)
- ESP32가 서버로 먼저 접속하므로 공유기 포트포워딩/고정IP 불필요
- 대역폭: 평상시 호실당 약 0.3Mbps(VGA 1fps), 보는 호실은 약 4Mbps(SVGA 10fps). 동시 시청은 `MAX_LIVE`로 제한
- 장치 쪽 최적화: Wi-Fi 절전 해제, 자동 재접속+5분 불통 시 재부팅, 하트비트로 끊김 감지, 호실별 전송 시점 분산, 전송 지연 시 JPEG 화질 자동 조절
- 영상이 끊기면 외장 안테나(U.FL) 사용, 장치 전원은 5V 1A 이상 안정 공급

## 펌웨어 업로드
Arduino IDE, 보드 `XIAO_ESP32S3`(PSRAM: OPI 켜기), ESP32 core 2.0.x. 라이브러리: `WebSockets`(Markus Sattler), `BH1750`(Christopher Laws).
`config.h`에서 `ROOM_ID`, Wi-Fi, 서버 주소, `DEVICE_TOKEN`을 설정. BH1750은 D4(SDA)/D5(SCL)에 연결(3.3V).

## 핫스팟(AP) 모드로 먼저 확인하기 — `firmware/dimming_v3_ap/`
공유기/클라우드 없이 ESP32 1대와 PC만으로 영상·조도·조명 제어를 확인하는 방법입니다.
1. `dimming_v3_ap.ino` 업로드 (핫스팟 `XIAO-CAM` / `12345678`, 장치 주소 `192.168.4.1`). BH1750은 D4/D5, 라이브러리 `BH1750` 설치
2. PC(또는 태블릿)의 Wi-Fi를 `XIAO-CAM`에 연결 (이 동안 PC 인터넷은 끊김)
3. PC에서 `start-hotspot.bat` 더블클릭 (또는 `DEVICES=101=http://192.168.4.1 node server.js`) — Node.js 18+ 필요
4. 브라우저 `http://localhost:3000` → 로그인 → **101호 카드에 실제 카메라 영상/조도** 표시, 나머지 호실은 시뮬레이션
5. 같은 핫스팟에 태블릿을 연결해 `http://PC의IP:3000`(PC IP는 `ipconfig`, 보통 192.168.4.2)으로도 접속 가능 (Windows 방화벽에서 Node 허용)
- 서버가 장치에서 영상을 가져오는 방식: 보는 사람 없음=VGA 1fps, 상세 화면을 열면 SVGA 약 10fps
- 장치가 여러 대인 핫스팟 구성은 불가(AP 1대당 장치 1대). 여러 대는 공유기 모드(`dimming_v3_ws`)를 사용
