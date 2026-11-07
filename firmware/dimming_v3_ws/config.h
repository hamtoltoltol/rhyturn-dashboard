// ============================================================
// 호실별 설정 (장치마다 ROOM_ID만 다르게 해서 업로드)
// ============================================================
#pragma once

// ---- 호실 ----
#define ROOM_ID        "101"            // 대시보드의 호실 번호 (101~, 서버 ROOM_COUNT 범위)

// ---- Wi-Fi (공유기) : 2.4GHz 전용 ----
#define WIFI_SSID      "YOUR_WIFI_SSID"
#define WIFI_PASS      "YOUR_WIFI_PASSWORD"

// ---- 대시보드 서버 ----
#define SERVER_HOST    "your-server.example.com"   // 클라우드 서버 도메인 또는 IP
#define SERVER_PORT    443                          // HTTPS(리버스 프록시)면 443, 평문이면 3000
#define USE_TLS        1                            // 1: wss://, 0: ws:// (내부망 시험용)
#define DEVICE_TOKEN   "device-secret"              // 서버의 DEVICE_TOKEN과 동일

// ---- 영상 ----
// 보는 사람이 없을 때(AI 분석/썸네일): 저속 / 보고 있을 때: 고속
#define FRAME_LO       FRAMESIZE_VGA    // 640x480
#define FRAME_HI       FRAMESIZE_SVGA   // 800x600  (더 높이려면 FRAMESIZE_HD 1280x720)
#define JPEG_Q_MIN     10               // 숫자가 작을수록 고화질
#define JPEG_Q_MAX     24               // Wi-Fi가 느릴 때 자동으로 여기까지 낮춤

// ---- 조도센서 BH1750 (I2C) : XIAO ESP32-S3 D4=SDA(GPIO5), D5=SCL(GPIO6) ----
#define I2C_SDA        5
#define I2C_SCL        6
