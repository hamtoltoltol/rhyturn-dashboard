// ====================================================================
// Rhyturn 호실 모듈 v3 — XIAO ESP32-S3 Sense
//  - 공유기(STA) 접속 + 서버로 WebSocket 접속(장치가 먼저 연결 → 공유기/방화벽 설정 불필요)
//  - 카메라: 보는 사람 없음=VGA 1fps / 보고 있음=SVGA 10fps, Wi-Fi 상태에 따라 화질 자동 조절
//  - 조도센서 BH1750, 4채널 PWM 스무스 페이딩 (D0=G, D1=Y, D2=B, D3=R)
// ★ ESP32 Arduino Core v2.0.x 기준
// 필요 라이브러리(라이브러리 매니저): "WebSockets" (Markus Sattler), "BH1750" (Christopher Laws)
// ====================================================================
#include "esp_camera.h"
#include <WiFi.h>
#include <Wire.h>
#include <WebSocketsClient.h>
#include <BH1750.h>
#include "config.h"

#define FW_VERSION "3.0"

// ----------------- 카메라 핀 (XIAO ESP32-S3 Sense) -----------------
#define PWDN_GPIO_NUM  -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM  10
#define SIOD_GPIO_NUM  40
#define SIOC_GPIO_NUM  39
#define Y9_GPIO_NUM    48
#define Y8_GPIO_NUM    11
#define Y7_GPIO_NUM    12
#define Y6_GPIO_NUM    14
#define Y5_GPIO_NUM    16
#define Y4_GPIO_NUM    18
#define Y3_GPIO_NUM    17
#define Y2_GPIO_NUM    15
#define VSYNC_GPIO_NUM 38
#define HREF_GPIO_NUM  47
#define PCLK_GPIO_NUM  13

// ----------------- PWM -----------------
const int PwmPins[4] = {1, 2, 3, 4};
const int PwmLCh[4]  = {4, 5, 6, 7};
const int PwmFreq = 5000, PwmRes = 8;
float currentPwm[4] = {0, 0, 0, 0};
int   targetPwm[4]  = {0, 0, 0, 0};
unsigned long lastFadeTick = 0;
const int fadeInterval = 10;

const int RHYTHM[10][4] = {   // {G, Y, B, R}
  {22, 24, 4, 26}, {76, 23, 27, 26}, {132, 33, 61, 28}, {106, 26, 49, 22}, {89, 26, 32, 30},
  {51, 31, 12, 31}, {26, 23, 6, 23}, {11, 13, 2, 13}, {1, 1, 0, 1}, {1, 5, 0, 5}
};
int currentRhythm = 2;

// ----------------- 상태 -----------------
WebSocketsClient ws;
BH1750 lightMeter(0x23);
bool gCamReady = false, gLuxReady = false, gWsUp = false;
float gLux = 0;
int  gStreamFps = 1;                 // 서버가 지정
bool gStreamHi = false;              // 서버가 지정
framesize_t gCurSize = FRAME_LO;
int  gJpegQ = 12;
unsigned long nextFrameAt = 0, lastStateAt = 0, lastLuxAt = 0, lastWifiOk = 0;
int  gSentFrames = 0; float gFps = 0; unsigned long fpsT = 0;
int  gSlowCount = 0, gFastCount = 0;

// ====================================================================
// 하드웨어
// ====================================================================
bool initCamera() {
  camera_config_t cfg;
  cfg.ledc_channel = LEDC_CHANNEL_0; cfg.ledc_timer = LEDC_TIMER_0;
  cfg.pin_d0 = Y2_GPIO_NUM; cfg.pin_d1 = Y3_GPIO_NUM; cfg.pin_d2 = Y4_GPIO_NUM; cfg.pin_d3 = Y5_GPIO_NUM;
  cfg.pin_d4 = Y6_GPIO_NUM; cfg.pin_d5 = Y7_GPIO_NUM; cfg.pin_d6 = Y8_GPIO_NUM; cfg.pin_d7 = Y9_GPIO_NUM;
  cfg.pin_xclk = XCLK_GPIO_NUM; cfg.pin_pclk = PCLK_GPIO_NUM; cfg.pin_vsync = VSYNC_GPIO_NUM; cfg.pin_href = HREF_GPIO_NUM;
  cfg.pin_sccb_sda = SIOD_GPIO_NUM; cfg.pin_sccb_scl = SIOC_GPIO_NUM; cfg.pin_pwdn = PWDN_GPIO_NUM; cfg.pin_reset = RESET_GPIO_NUM;
  cfg.xclk_freq_hz = 20000000;
  cfg.pixel_format = PIXFORMAT_JPEG;
  cfg.grab_mode    = CAMERA_GRAB_LATEST;     // 항상 최신 프레임
  cfg.frame_size   = FRAME_HI;               // 버퍼는 가장 큰 크기로 할당
  cfg.jpeg_quality = gJpegQ;
  if (psramFound()) { cfg.fb_count = 2; cfg.fb_location = CAMERA_FB_IN_PSRAM; }
  else { cfg.frame_size = FRAMESIZE_QVGA; cfg.fb_count = 1; cfg.fb_location = CAMERA_FB_IN_DRAM; }
  if (esp_camera_init(&cfg) != ESP_OK) return false;
  sensor_t* s = esp_camera_sensor_get();
  if (s) { s->set_framesize(s, FRAME_LO); gCurSize = FRAME_LO; s->set_quality(s, gJpegQ); }
  return true;
}

void setCamera(framesize_t size, int q) {
  sensor_t* s = esp_camera_sensor_get(); if (!s) return;
  if (size != gCurSize) {
    s->set_framesize(s, size); gCurSize = size;
    for (int i = 0; i < 2; i++) { camera_fb_t* f = esp_camera_fb_get(); if (f) esp_camera_fb_return(f); } // 전환 직후 프레임 버림
  }
  if (q != gJpegQ) { gJpegQ = q; s->set_quality(s, q); }
}

void initPWM() {
  for (int i = 0; i < 4; i++) { ledcSetup(PwmLCh[i], PwmFreq, PwmRes); ledcAttachPin(PwmPins[i], PwmLCh[i]); ledcWrite(PwmLCh[i], 0); }
}
void applyRhythm(int idx) {
  if (idx >= 0 && idx <= 9) { currentRhythm = idx; for (int i = 0; i < 4; i++) targetPwm[i] = RHYTHM[idx][i]; }
  else if (idx == -1) { currentRhythm = -1; for (int i = 0; i < 4; i++) targetPwm[i] = 0; }
}
void updateFade() {
  unsigned long now = millis();
  if (now - lastFadeTick < fadeInterval) return;
  lastFadeTick = now;
  for (int i = 0; i < 4; i++) {
    if ((int)currentPwm[i] != targetPwm[i]) {
      currentPwm[i] += (currentPwm[i] < targetPwm[i]) ? 1.0 : -1.0;
      int out = (int)currentPwm[i];
      ledcWrite(PwmLCh[i], out > 0 ? map(out, 1, 255, 23, 255) : 0);   // 최소 밝기 보정
    }
  }
}

// ====================================================================
// 서버 통신
// ====================================================================
static bool jInt(const char* j, const char* key, int& out) {
  char pat[24]; snprintf(pat, sizeof pat, "\"%s\":", key);
  const char* p = strstr(j, pat); if (!p) return false; out = atoi(p + strlen(pat)); return true;
}

void onMessage(const char* j) {
  int v;
  if (strstr(j, "\"type\":\"rhythm\"") && jInt(j, "id", v)) applyRhythm(v);
  else if (strstr(j, "\"type\":\"set\"")) {
    int ch, val;
    if (jInt(j, "ch", ch) && jInt(j, "val", val) && ch >= 0 && ch <= 3) { currentRhythm = -2; targetPwm[ch] = constrain(val, 0, 255); }
  } else if (strstr(j, "\"type\":\"stream\"")) {
    if (jInt(j, "fps", v)) gStreamFps = constrain(v, 1, 15);
    gStreamHi = strstr(j, "\"size\":\"hi\"") != nullptr;
    nextFrameAt = 0;
  }
}

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:    gWsUp = true;  Serial.println("[WS] 연결됨"); break;
    case WStype_DISCONNECTED: gWsUp = false; Serial.println("[WS] 끊김"); break;
    case WStype_TEXT:         onMessage((const char*)payload); break;
    default: break;
  }
}

void sendState() {
  char b[256];
  snprintf(b, sizeof b,
    "{\"type\":\"state\",\"ch\":[%d,%d,%d,%d],\"rhythm\":%d,\"lux\":%d,\"fps\":%.1f,\"rssi\":%d,\"cam_ok\":%s,\"lux_ok\":%s,\"heap\":%u,\"fw\":\"%s\"}",
    targetPwm[0], targetPwm[1], targetPwm[2], targetPwm[3], currentRhythm, (int)(gLux + 0.5f), gFps, WiFi.RSSI(),
    gCamReady ? "true" : "false", gLuxReady ? "true" : "false", (unsigned)ESP.getFreeHeap(), FW_VERSION);
  ws.sendTXT(b);
}

// 프레임 전송 + 전송 시간 기반 화질 자동 조절
void sendFrame() {
  framesize_t want = gStreamHi ? FRAME_HI : FRAME_LO;
  setCamera(want, gJpegQ);
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) return;
  unsigned long t0 = millis();
  ws.sendBIN(fb->buf, fb->len);
  unsigned long dt = millis() - t0;
  esp_camera_fb_return(fb);

  gSentFrames++;
  unsigned long now = millis();
  if (now - fpsT >= 2000) { gFps = gSentFrames * 1000.0f / (now - fpsT); gSentFrames = 0; fpsT = now; }

  // 전송이 느리면(Wi-Fi 혼잡) 화질을 낮추고, 여유가 있으면 다시 올린다
  if (dt > 250) { gFastCount = 0; if (++gSlowCount >= 3 && gJpegQ < JPEG_Q_MAX) { setCamera(gCurSize, gJpegQ + 2); gSlowCount = 0; } }
  else if (dt < 70) { gSlowCount = 0; if (++gFastCount >= 30 && gJpegQ > JPEG_Q_MIN) { setCamera(gCurSize, gJpegQ - 1); gFastCount = 0; } }
  else { gSlowCount = gFastCount = 0; }
}

// ====================================================================
// Wi-Fi
// ====================================================================
void startWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setHostname("rhyturn-" ROOM_ID);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  WiFi.setSleep(false);            // 절전 해제 → 지연/끊김 최소화 (전력 여유 필요)
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}
void wifiWatch() {
  static unsigned long lastTry = 0;
  if (WiFi.status() == WL_CONNECTED) { lastWifiOk = millis(); return; }
  unsigned long now = millis();
  if (now - lastTry > 15000) { lastTry = now; Serial.println("[WiFi] 재접속"); WiFi.disconnect(); WiFi.begin(WIFI_SSID, WIFI_PASS); }
  if (now - lastWifiOk > 5UL * 60000) { Serial.println("[WiFi] 5분 이상 불가 → 재부팅"); ESP.restart(); }
}

// ====================================================================
void setup() {
  Serial.begin(115200); delay(300);
  Serial.printf("\n[Rhyturn] 호실 %s  fw %s\n", ROOM_ID, FW_VERSION);
  initPWM(); applyRhythm(2);
  gCamReady = initCamera(); Serial.printf("[CAM] %s\n", gCamReady ? "OK" : "FAIL");
  Wire.begin(I2C_SDA, I2C_SCL);
  gLuxReady = lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE); Serial.printf("[BH1750] %s\n", gLuxReady ? "OK" : "FAIL");
  startWiFi(); lastWifiOk = millis();

  char path[160]; snprintf(path, sizeof path, "/ws/device?room=%s&token=%s", ROOM_ID, DEVICE_TOKEN);
#if USE_TLS
  ws.beginSSL(SERVER_HOST, SERVER_PORT, path);      // 인증서 검증 생략(간단). 보안 강화 시 루트 CA 지정 권장
#else
  ws.begin(SERVER_HOST, SERVER_PORT, path);
#endif
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(3000);
  ws.enableHeartbeat(15000, 3000, 2);               // 끊긴 연결 감지
  nextFrameAt = millis() + (atoi(ROOM_ID) * 97) % 1000;   // 호실별 시작 시점 분산 (동시 전송 폭주 방지)
}

void loop() {
  updateFade();
  wifiWatch();
  if (WiFi.status() != WL_CONNECTED) { delay(5); return; }
  ws.loop();
  unsigned long now = millis();

  if (gLuxReady && now - lastLuxAt >= 500) { lastLuxAt = now; float l = lightMeter.readLightLevel(); if (l >= 0) gLux = l; }
  if (!gWsUp) return;
  if (now - lastStateAt >= 1000) { lastStateAt = now; sendState(); }
  if (gCamReady && (long)(now - nextFrameAt) >= 0) { nextFrameAt = now + 1000 / gStreamFps; sendFrame(); }
}
