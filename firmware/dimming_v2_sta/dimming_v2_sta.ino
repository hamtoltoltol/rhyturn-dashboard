// ====================================================================
// XIAO ESP32-S3 Sense — 웹서버 + 카메라 + 생체리듬 조명 (스무스 페이딩)
// ★ ESP32 Arduino Core v2.x (2.0.12) 전용 ★
//
// D0=Green, D1=Yellow, D2=Blue, D3=Red
// ====================================================================

#include "esp_camera.h"
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>

// ----------------- 공유기(STA) 접속 설정 -----------------
// ★ 현장 공유기 정보로 수정 (2.4GHz 전용. ESP32-S3는 5GHz 미지원)
const char* sta_ssid = "YOUR_WIFI_SSID";
const char* sta_pass = "YOUR_WIFI_PASSWORD";
const char* hostName = "rhyturn-room01";   // 호실별로 다르게 (mDNS: http://rhyturn-room01.local)
const unsigned long STA_TIMEOUT_MS = 15000;

// 공유기 접속 실패 시 설정/복구용 자체 핫스팟으로 전환
const char* ap_ssid = "XIAO-CAM";
const char* ap_pass = "12345678";
bool gApMode = false;
unsigned long gLastWifiCheck = 0;

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

// ----------------- PWM (D0=G, D1=Y, D2=B, D3=R) -----------------
const int PwmPins[4] = {1, 2, 3, 4}; // D0~D3 핀
const int PwmLCh[4]  = {4, 5, 6, 7}; // 타이머 충돌 방지용 채널
const int PwmFreq = 5000;
const int PwmRes  = 8;

// 페이딩(자연스러운 전환)을 위한 변수 분리
float currentPwm[4] = {0, 0, 0, 0}; // 현재 하드웨어에서 출력 중인 밝기
int   targetPwm[4]  = {0, 0, 0, 0}; // 사용자가 설정한 최종 목표 밝기
unsigned long lastFadeTick = 0;
const int fadeInterval = 10; // 페이드 속도 (ms). 10ms면 0~255까지 약 2.5초 소요

// ----------------- 생체리듬 데이터 구조체 -----------------
struct RhythmMode {
  String name;
  int g; // D0 (Green)
  int y; // D1 (Yellow/Amber)
  int b; // D2 (Blue)
  int r; // D3 (Red)
};

const RhythmMode rhythms[10] = {
  {"기상 유도 (Dawn)",       22,  24,   4,  26},
  {"아침 각성 (Morning)",    76,  23,  27,  26},
  {"주간 피크 (Daytime)",   132,  33,  61,  28},
  {"정오 (Midday)",         106,  26,  49,  22},
  {"오후 활동 (Afternoon)",  89,  26,  32,  30},
  {"일몰 전환 (Wind-down)",  51,  31,  12,  31},
  {"저녁 (Evening)",         26,  23,   6,  23},
  {"취침 준비 (Pre-sleep)",  11,  13,   2,  13},
  {"야간 수면 (Night)",       1,   1,   0,   1},
  {"야간 이동 (Night nav)",   1,   5,   0,   5} 
};

int currentRhythm = 2; // 초기 상태: 2번 (주간 피크)

// ----------------- 시스템 변수 -----------------
int gFrameCount = 0;
unsigned long gLastFpsCheck = 0;
float gFps = 0;
bool gCamReady = false;

WebServer server(80);

// ====================================================================
// HTML (PROGMEM)
// ====================================================================
const char INDEX_HTML[] PROGMEM = R"raw(
<!DOCTYPE html><html lang="ko"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Circadian Rhythm Light</title>
<style>
*{box-sizing:border-box}
body{background:#0f1117;color:#e8eaf0;font-family:system-ui,sans-serif;margin:0;padding:14px;text-align:center}
h1{font-size:18px;margin:4px 0 12px; color:#fff;}
.cam,.panel{display:block;margin:0 auto 12px;max-width:640px;width:100%}
.cam{border:2px solid #2a2f3a;border-radius:10px;overflow:hidden;background:#000;min-height:180px}
.cam img{display:block;width:100%;height:auto}
.panel{padding:12px;background:#161b22;border-radius:10px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:15px;}
.btn{padding:12px 6px;border-radius:8px;border:none;font-weight:600;cursor:pointer;font-size:13px;transition:0.2s;background:#2a2f3a;color:#9ca3af;}
.btn:active{transform:scale(0.97)}
.btn.active{background:#38bdf8;color:#0f1117;box-shadow:0 0 10px rgba(56,189,248,0.4)}
.btn-off{background:#ef4444!important;color:#fff!important; grid-column: span 2;}
.row{display:flex;align-items:center;gap:10px;margin:8px 4px}
.row label{font-weight:600;min-width:55px;color:#9ca3af;font-size:13px;text-align:left}
.row .v{min-width:35px;text-align:right;color:#22d3ee;font-family:monospace}
.slider{flex:1;-webkit-appearance:none;height:6px;border-radius:3px;background:#2a2f3a}
.slider::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:#4ade80;cursor:pointer}
.meta{margin-top:12px;font-size:12px;color:#6b7280; border-top:1px solid #2a2f3a; padding-top:10px;}
</style></head><body>
<h1>XIAO-S3 생체리듬 조명 제어</h1>
<div class="cam"><img id="cam" src="/snapshot"></div>
<div class="panel">
  <div class="grid">
    <button class="btn" id="r0" onclick="setR(0)">기상 유도 (Dawn)</button>
    <button class="btn" id="r1" onclick="setR(1)">아침 각성 (Morning)</button>
    <button class="btn active" id="r2" onclick="setR(2)">주간 피크 (Daytime)</button>
    <button class="btn" id="r3" onclick="setR(3)">정오 (Midday)</button>
    <button class="btn" id="r4" onclick="setR(4)">오후 활동 (Afternoon)</button>
    <button class="btn" id="r5" onclick="setR(5)">일몰 전환 (Wind-down)</button>
    <button class="btn" id="r6" onclick="setR(6)">저녁 (Evening)</button>
    <button class="btn" id="r7" onclick="setR(7)">취침 준비 (Pre-sleep)</button>
    <button class="btn" id="r8" onclick="setR(8)">야간 수면 (Night)</button>
    <button class="btn" id="r9" onclick="setR(9)">야간 이동 (Night nav)</button>
    <button class="btn btn-off" onclick="setR(-1)">전체 소등 (OFF)</button>
  </div>
  
  <div class="row"><label>D0(🟢)</label><input id="s0" class="slider" type="range" min="0" max="255" value="0"><span class="v" id="v0">0</span></div>
  <div class="row"><label>D1(🟡)</label><input id="s1" class="slider" type="range" min="0" max="255" value="0"><span class="v" id="v1">0</span></div>
  <div class="row"><label>D2(🔵)</label><input id="s2" class="slider" type="range" min="0" max="255" value="0"><span class="v" id="v2">0</span></div>
  <div class="row"><label>D3(🔴)</label><input id="s3" class="slider" type="range" min="0" max="255" value="0"><span class="v" id="v3">0</span></div>
  
  <div class="meta">카메라: <span id="camTag" style="color:#4ade80">OK</span> | FPS: <span id="fps">-</span></div>
</div>
<script>
let camOk=true;
for(let i=0;i<4;i++){
  const s=document.getElementById('s'+i);
  const v=document.getElementById('v'+i);
  let t=null;
  s.addEventListener('input',()=>{
    v.textContent=s.value;
    clearTimeout(t);
    updateBtnStyle(-2); 
    t=setTimeout(()=>{fetch('/set?ch='+i+'&val='+s.value).catch(()=>{});},30);
  });
}

function updateBtnStyle(id) {
  for(let i=0;i<=9;i++){
    let btn = document.getElementById('r'+i);
    if(btn) {
      if(i === id) btn.classList.add('active');
      else btn.classList.remove('active');
    }
  }
}

async function setR(id){
  try{
    await fetch('/rhythm?id='+id);
    updateBtnStyle(id);
  }catch(e){}
}

const img=document.getElementById('cam');
function refreshCam(){ if(camOk){ img.src='/snapshot?t='+Date.now(); } }
img.addEventListener('error',()=>{ camOk=false; setTimeout(()=>{camOk=true;refreshCam();},1000); });
setInterval(refreshCam,130);

setInterval(async()=>{
  try{
    const s=await(await fetch('/state')).json();
    document.getElementById('fps').textContent=s.fps;
    const ct=document.getElementById('camTag');
    if(s.cam_ok){ct.textContent='OK';ct.style.color='#4ade80';}
    else{ct.textContent='FAIL';ct.style.color='#ef4444';}
    
    for(let i=0;i<4;i++){
      document.getElementById('s'+i).value=s.ch[i];
      document.getElementById('v'+i).textContent=s.ch[i];
    }
    updateBtnStyle(s.rhythm);
  }catch(e){}
},500);
</script></body></html>)raw";

// ====================================================================
// 하드웨어 제어 함수
// ====================================================================
void initCamera() {
  camera_config_t cfg;
  cfg.ledc_channel = LEDC_CHANNEL_0;
  cfg.ledc_timer   = LEDC_TIMER_0;
  cfg.pin_d0 = Y2_GPIO_NUM; cfg.pin_d1 = Y3_GPIO_NUM;
  cfg.pin_d2 = Y4_GPIO_NUM; cfg.pin_d3 = Y5_GPIO_NUM;
  cfg.pin_d4 = Y6_GPIO_NUM; cfg.pin_d5 = Y7_GPIO_NUM;
  cfg.pin_d6 = Y8_GPIO_NUM; cfg.pin_d7 = Y9_GPIO_NUM;
  cfg.pin_xclk     = XCLK_GPIO_NUM;
  cfg.pin_pclk     = PCLK_GPIO_NUM;
  cfg.pin_vsync    = VSYNC_GPIO_NUM;
  cfg.pin_href     = HREF_GPIO_NUM;
  cfg.pin_sccb_sda = SIOD_GPIO_NUM;
  cfg.pin_sccb_scl = SIOC_GPIO_NUM;
  cfg.pin_pwdn     = PWDN_GPIO_NUM;
  cfg.pin_reset    = RESET_GPIO_NUM;
  cfg.xclk_freq_hz = 20000000;
  cfg.pixel_format = PIXFORMAT_JPEG;
  cfg.grab_mode    = CAMERA_GRAB_LATEST;

  if (psramFound()) {
    cfg.frame_size   = FRAMESIZE_QVGA;
    cfg.jpeg_quality = 12;
    cfg.fb_count     = 1;
    cfg.fb_location  = CAMERA_FB_IN_PSRAM;
  } else {
    cfg.frame_size   = FRAMESIZE_QVGA;
    cfg.jpeg_quality = 16;
    cfg.fb_count     = 1;
    cfg.fb_location  = CAMERA_FB_IN_DRAM;
  }

  esp_err_t err = esp_camera_init(&cfg);
  gCamReady = (err == ESP_OK);
}

void initPWM() {
  for (int i = 0; i < 4; i++) {
    ledcSetup(PwmLCh[i], PwmFreq, PwmRes);
    ledcAttachPin(PwmPins[i], PwmLCh[i]);
    ledcWrite(PwmLCh[i], 0);
  }
}

// 이제 하드웨어에 바로 쏘지 않고 '목표값'만 설정해둡니다.
void setTargetPWM(int ch, int val) {
  targetPwm[ch] = val;
}

// 생체리듬 단계 적용 함수
void applyRhythm(int index) {
  if (index >= 0 && index <= 9) {
    currentRhythm = index;
    setTargetPWM(0, rhythms[index].g); 
    setTargetPWM(1, rhythms[index].y); 
    setTargetPWM(2, rhythms[index].b); 
    setTargetPWM(3, rhythms[index].r); 
    Serial.printf("[Rhythm] %s 페이딩 시작\n", rhythms[index].name.c_str());
  } 
  else if (index == -1) { 
    currentRhythm = -1;
    for(int i=0; i<4; i++) setTargetPWM(i, 0);
    Serial.println("[Rhythm] 전체 소등 페이딩 시작");
  }
}

// ★ 스무스 페이딩 처리 및 최소 밝기 보정 로직 (loop 에서 지속 실행)
void updateFade() {
  unsigned long now = millis();
  if (now - lastFadeTick >= fadeInterval) {
    lastFadeTick = now;
    
    for (int i = 0; i < 4; i++) {
      if ((int)currentPwm[i] != targetPwm[i]) {
        // 목표값을 향해 부드럽게 1씩 증감
        if (currentPwm[i] < targetPwm[i]) currentPwm[i] += 1.0;
        else currentPwm[i] -= 1.0;
        
        // 최소값 23 보정 로직
        int out = (int)currentPwm[i];
        int actualVal = 0;
        if (out > 0) {
          actualVal = map(out, 1, 255, 23, 255); 
        }
        ledcWrite(PwmLCh[i], actualVal);
      }
    }
  }
}

// ====================================================================
// 웹 핸들러
// ====================================================================
void handleRoot() {
  server.sendHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  server.send_P(200, PSTR("text/html; charset=utf-8"), INDEX_HTML);
}

void handleSnapshot() {
  if (!gCamReady) { server.send(503, "text/plain", "no camera"); return; }
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) { server.send(500, "text/plain", "no fb"); return; }

  server.sendHeader("Cache-Control", "no-store");
  server.setContentLength(fb->len);
  server.send(200, "image/jpeg", "");
  server.client().write(fb->buf, fb->len);
  esp_camera_fb_return(fb);

  gFrameCount++;
  unsigned long now = millis();
  if (now - gLastFpsCheck >= 1000) {
    gFps = (float)gFrameCount * 1000.0f / (float)(now - gLastFpsCheck);
    gFrameCount = 0; gLastFpsCheck = now;
  }
}

void handleSet() {
  if (server.hasArg("ch") && server.hasArg("val")) {
    int ch = server.arg("ch").toInt();
    int v  = constrain(server.arg("val").toInt(), 0, 255);
    if (ch >= 0 && ch <= 3) {
      currentRhythm = -2; 
      setTargetPWM(ch, v); // 슬라이더 조작도 부드럽게 반영됨
    }
  }
  server.send(200, "text/plain", "OK");
}

void handleRhythm() {
  if (server.hasArg("id")) {
    int id = server.arg("id").toInt();
    applyRhythm(id);
  }
  server.send(200, "text/plain", "OK");
}

void handleState() {
  String j = "{\"ch\":[";
  for (int i = 0; i < 4; i++) { j += String(targetPwm[i]); if (i < 3) j += ','; }
  j += "],\"fps\":";     j += String(gFps, 1);
  j += ",\"rhythm\":";   j += String(currentRhythm);
  j += ",\"cam_ok\":";   j += (gCamReady ? "true" : "false");
  j += ",\"rssi\":";     j += String(gApMode ? 0 : WiFi.RSSI());
  j += ",\"ap\":";       j += (gApMode ? "true" : "false");
  j += ",\"host\":\"";    j += hostName; j += "\"";
  j += "}";
  
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", j);
}

// ====================================================================
// WiFi: 공유기 접속(STA) 우선, 실패 시 AP 폴백
// ====================================================================
void startApFallback() {
  WiFi.mode(WIFI_AP);
  WiFi.softAP(ap_ssid, ap_pass);
  gApMode = true;
  Serial.print("[AP] 폴백 모드 주소: http://");
  Serial.println(WiFi.softAPIP());
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(hostName);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  WiFi.setSleep(false);            // 절전 해제: 지연시간(Latency) 최소화
  WiFi.begin(sta_ssid, sta_pass);
  Serial.printf("[STA] '%s' 접속 중", sta_ssid);

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < STA_TIMEOUT_MS) {
    delay(300); Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    gApMode = false;
    Serial.print("[STA] 접속 완료. 주소: http://");
    Serial.println(WiFi.localIP());
    if (MDNS.begin(hostName)) {
      MDNS.addService("http", "tcp", 80);
      Serial.printf("[mDNS] http://%s.local\n", hostName);
    }
  } else {
    startApFallback();
  }
}

// AP 폴백 상태에서는 주기적으로 공유기 재접속 시도 (공유기 재부팅 대비)
void wifiWatchdog() {
  unsigned long now = millis();
  if (now - gLastWifiCheck < 30000) return;
  gLastWifiCheck = now;
  if (gApMode) {
    Serial.println("[STA] 재접속 시도");
    WiFi.begin(sta_ssid, sta_pass);
    unsigned long t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 8000) { delay(200); server.handleClient(); }
    if (WiFi.status() == WL_CONNECTED) {
      WiFi.softAPdisconnect(true);
      WiFi.mode(WIFI_STA);
      gApMode = false;
      MDNS.begin(hostName);
      Serial.print("[STA] 복구 완료: ");
      Serial.println(WiFi.localIP());
    }
  }
}

// ====================================================================
// setup / loop
// ====================================================================
void setup() {
  Serial.begin(115200);
  delay(500);

  initCamera();
  initPWM();
  
  applyRhythm(2); // 초기 전원 인가 시 '주간 피크' 모드 페이딩 시작

  connectWiFi();

  server.on("/",         HTTP_GET, handleRoot);
  server.on("/snapshot", HTTP_GET, handleSnapshot);
  server.on("/set",      HTTP_GET, handleSet);
  server.on("/rhythm",   HTTP_GET, handleRhythm);
  server.on("/state",    HTTP_GET, handleState);
  server.begin();
}

void loop() {
  server.handleClient();
  updateFade(); // 백그라운드에서 계속 밝기를 부드럽게 변화시킴
  wifiWatchdog();
  yield();
}