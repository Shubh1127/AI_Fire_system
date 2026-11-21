/*
  SMART FIRE DETECTION + AUTOMATIC SUPPRESSION
  ESP32 node: 2x IR flame sensor, DHT11, servo-aimed nozzle, water pump (via relay)

  Libraries (Arduino IDE > Library Manager):
    - DHT sensor library (Adafruit)
    - ESP32Servo (Kevin Harrington)
    - ArduinoJson (Benoit Blanchon), version 7.x

  How control works:
    1. ESP32 reads sensors and POSTs them to FastAPI every 500 ms.
    2. FastAPI decides (AI / rules) and replies with:
         {"command": {"servo_angle": 120, "pump": true}, ...}
    3. ESP32 aims the nozzle and runs the pump.
    4. If the backend does not answer for 3 s (Wi-Fi down, laptop off),
       the ESP32 switches to LOCAL mode and decides by itself from the
       flame sensors, so the system never depends on Wi-Fi to put out a fire.
    5. Pump safety limits (max run time, cooldown) always apply,
       whatever the backend says.
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include "DHT.h"
#include "driver/gpio.h"

// =========================
// Wi-Fi + backend
// =========================
const char* WIFI_SSID     = "";
const char* WIFI_PASSWORD = "";
const char* API_URL       = "http://192.168.1.49:8000/api/sensors";
const char* DEVICE_ID     = "esp32-fire-01";

// =========================
// Pins
// =========================
#define DHTPIN   4
#define DHTTYPE  DHT11

#define FLAME1_PIN 27      // LEFT flame sensor, DO pin
#define FLAME2_PIN 26      // RIGHT flame sensor, DO pin

// Optional: wire each flame sensor's AO pin for smoother aiming.
// Must be ADC1 pins (32-39). ADC2 pins do not work while Wi-Fi is on.
#define FLAME_ANALOG_CONNECTED 0
#define FLAME1_AO_PIN 32
#define FLAME2_AO_PIN 33

#define MQ2_CONNECTED 0
#define MQ2_PIN 34

#define SERVO_PIN 18       // servo signal (orange/yellow wire)
#define PUMP_PIN  25       // relay module IN

// Status LEDs: pin -> resistor (220 to 1k ohm) -> LED long leg; LED short leg -> GND
#define LED_GREEN_PIN 19   // ON when no fire
#define LED_RED_PIN   21   // ON when fire detected or pump spraying

// Active buzzer: + leg (or module I/O pin) -> D23, - leg -> GND
#define BUZZER_PIN 23
#define BUZZER_ACTIVE_LOW 0          // set to 1 if your buzzer module beeps when I/O is LOW
const unsigned long BEEP_MS = 300;   // beep on 300 ms, off 300 ms while there is fire

// Most blue 1-channel relay modules switch ON when IN is LOW.
// If your pump runs when it should be off, change this to 0.
#define PUMP_ACTIVE_LOW 1

// =========================
// Aiming (tune after mounting)
// =========================
// If the nozzle turns the wrong way, swap ANGLE_LEFT and ANGLE_RIGHT.
const int ANGLE_CENTER = 90;
const int ANGLE_LEFT   = 135;
const int ANGLE_RIGHT  = 45;

// One side on fire: spray that side's zone, sweeping +/- SWEEP_WIDTH around it
const int SWEEP_WIDTH  = 20;
// Both sides on fire: sweep the whole area around the centre, +/- BOTH_SWEEP_WIDTH (30 to 150 deg)
const int BOTH_SWEEP_WIDTH = 60;
// true = pump starts the moment fire is seen, while the servo is still turning
// false = pump waits until the nozzle reaches the fire zone (less wasted water)
const bool START_PUMP_IMMEDIATELY = true;
const unsigned long SERVO_TICK_MS = 20; // servo moves 1-2 degrees per tick
const int SERVO_STEP_DEG = 2;

// =========================
// Timing and safety
// =========================
const unsigned long SEND_INTERVAL      = 500;   // POST to backend
const unsigned long BACKEND_TIMEOUT_MS = 3000;  // after this, local mode
const unsigned long PUMP_MAX_ON_MS     = 10000; // never run pump longer than this in one go
const unsigned long PUMP_COOLDOWN_MS   = 3000;  // rest after a max-length run
const unsigned long FLAME_HOLD_MS      = 2000;  // local mode: keep spraying after flame disappears
const unsigned long WIFI_RETRY_MS      = 5000;

// =========================
// State
// =========================
DHT dht(DHTPIN, DHTTYPE);
Servo nozzle;

float temperature = NAN;
float humidity    = NAN;
int flame1 = HIGH, flame2 = HIGH;   // LOW = flame detected
int flame1Ao = -1, flame2Ao = -1;
int smoke = -1;

int  targetAngle  = ANGLE_CENTER;
int  currentAngle = ANGLE_CENTER;
int  sweepOffset  = 0;
int  sweepDir     = 1;

bool pumpRequested = false;   // what the decision layer wants
bool pumpOn        = false;   // what the relay is actually doing
unsigned long pumpOnSince       = 0;
unsigned long pumpCooldownUntil = 0;

unsigned long lastFlameSeen  = 0;
unsigned long lastBackendOk  = 0;
unsigned long lastSendTime   = 0;
unsigned long lastServoTick  = 0;
unsigned long lastWifiRetry  = 0;

const char* controlMode = "local";
bool backendSaysFire = false;
const char* firePosition = "none";      // none / left / right / both
const char* sprayPattern = "none";      // last fire pattern, kept while the pump finishes spraying
const char* lastPrintedPosition = "none";   // backend's "risk" == "FIRE" on the last reply


// =========================
// Pump
// =========================
void writePumpPin(bool on) {
#if PUMP_ACTIVE_LOW
  digitalWrite(PUMP_PIN, on ? LOW : HIGH);
#else
  digitalWrite(PUMP_PIN, on ? HIGH : LOW);
#endif
}

void setPump(bool on) {
  if (on == pumpOn) return;
  pumpOn = on;
  writePumpPin(on);
  if (on) pumpOnSince = millis();
  Serial.println(on ? ">>> PUMP ON" : ">>> PUMP OFF");
}

void applyPumpSafety() {
  unsigned long now = millis();

  // Hard limit on continuous run time
  if (pumpOn && now - pumpOnSince >= PUMP_MAX_ON_MS) {
    setPump(false);
    pumpCooldownUntil = now + PUMP_COOLDOWN_MS;
    Serial.println("Pump hit max run time, cooling down.");
    return;
  }

  bool cooledDown = (long)(now - pumpCooldownUntil) >= 0;

  // Only start spraying once the nozzle is roughly pointing at the target
  bool aimed = START_PUMP_IMMEDIATELY || abs(currentAngle - targetAngle) <= currentSweepWidth() + 2;

  if (pumpRequested && cooledDown && (pumpOn || aimed)) {
    setPump(true);
  } else if (!pumpRequested) {
    setPump(false);
  }
}


// =========================
// Servo
// =========================
int currentSweepWidth() {
  return strcmp(sprayPattern, "both") == 0 ? BOTH_SWEEP_WIDTH : SWEEP_WIDTH;
}
void updateServo() {
  // Sweep around the target while spraying: one side = that zone, both sides = whole area
  if (pumpOn) {
    int w = currentSweepWidth();
    sweepOffset += sweepDir;
    if (sweepOffset >= w)       sweepDir = -1;
    else if (sweepOffset <= -w) sweepDir = 1;
  } else {
    sweepOffset = 0;
  }

  int desired = constrain(targetAngle + sweepOffset, 0, 180);

  if (currentAngle < desired) currentAngle = min(currentAngle + SERVO_STEP_DEG, desired);
  else if (currentAngle > desired) currentAngle = max(currentAngle - SERVO_STEP_DEG, desired);

  nozzle.write(currentAngle);
}


// =========================
// Sensors
// =========================
void readFlames() {
  flame1 = digitalRead(FLAME1_PIN);
  flame2 = digitalRead(FLAME2_PIN);
#if FLAME_ANALOG_CONNECTED
  flame1Ao = analogRead(FLAME1_AO_PIN);
  flame2Ao = analogRead(FLAME2_AO_PIN);
#endif
  if (flame1 == LOW || flame2 == LOW) lastFlameSeen = millis();
}

void readSlowSensors() {
  temperature = dht.readTemperature();
  humidity    = dht.readHumidity();
#if MQ2_CONNECTED
  smoke = analogRead(MQ2_PIN);
#endif
}


// =========================
// Local decision (fallback when backend is unreachable)
// =========================
int localAimAngle() {
  bool f1 = (flame1 == LOW);
  bool f2 = (flame2 == LOW);

#if FLAME_ANALOG_CONNECTED
  // Lower AO value = stronger IR. Weight the angle by relative strength.
  if (f1 || f2) {
    long s1 = max(0, 4095 - flame1Ao);
    long s2 = max(0, 4095 - flame2Ao);
    if (s1 + s2 > 0) {
      return ANGLE_RIGHT + (ANGLE_LEFT - ANGLE_RIGHT) * s1 / (s1 + s2);
    }
  }
#endif

  if (f1 && f2) return ANGLE_CENTER;
  if (f1)       return ANGLE_LEFT;
  if (f2)       return ANGLE_RIGHT;
  return targetAngle;  // no flame now: hold last aim
}

void decideLocally() {
  targetAngle   = localAimAngle();
  pumpRequested = lastFlameSeen > 0 && (millis() - lastFlameSeen < FLAME_HOLD_MS);
}


// =========================
// Wi-Fi
// =========================
void connectWiFi() {
  Serial.println("Connecting to Wi-Fi...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Wi-Fi connected. ESP32 IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Wi-Fi FAILED. Running in local mode.");
  }
}


// =========================
// Backend exchange
// =========================
void sendSensorData() {
  // Non-blocking reconnect: never stall the loop during a fire
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastWifiRetry > WIFI_RETRY_MS) {
      lastWifiRetry = millis();
      Serial.println("Wi-Fi down, retrying in background...");
      WiFi.reconnect();
    }
    return;
  }

  JsonDocument doc;
  if (isnan(temperature)) doc["temperature"] = nullptr; else doc["temperature"] = round(temperature * 10) / 10.0;
  if (isnan(humidity))    doc["humidity"]    = nullptr; else doc["humidity"]    = round(humidity * 10) / 10.0;
  doc["flame1"] = flame1;
  doc["flame2"] = flame2;
  if (flame1Ao >= 0) doc["flame1_ao"] = flame1Ao;
  if (flame2Ao >= 0) doc["flame2_ao"] = flame2Ao;
  if (smoke >= 0) doc["smoke"] = smoke; else doc["smoke"] = nullptr;
  doc["device_id"]   = DEVICE_ID;
  doc["pump_on"]     = pumpOn;
  doc["servo_angle"] = currentAngle;
  doc["mode"]        = controlMode;
  doc["fire_position"] = firePosition;

  String body;
  serializeJson(doc, body);

  HTTPClient http;
  http.setConnectTimeout(600);
  http.setTimeout(800);
  http.begin(API_URL);
  http.addHeader("Content-Type", "application/json");

  int code = http.POST(body);

  if (code == 200) {
    String resp = http.getString();
    JsonDocument r;
    if (!deserializeJson(r, resp)) {
      JsonVariant cmd = r["command"];
      if (!cmd.isNull()) {
        targetAngle   = constrain((int)(cmd["servo_angle"] | targetAngle), 0, 180);
        pumpRequested = cmd["pump"] | false;
        backendSaysFire = strcmp(r["risk"] | "SAFE", "FIRE") == 0;
        lastBackendOk = millis();
        controlMode   = "backend";
      }
    }
  } else if (code < 0) {
    Serial.print("HTTP failed: ");
    Serial.println(http.errorToString(code));
  } else {
    Serial.print("HTTP code: ");
    Serial.println(code);
  }

  http.end();
}

// =========================
// Status LEDs
// =========================
void writeBuzzer(bool on) {
#if BUZZER_ACTIVE_LOW
  digitalWrite(BUZZER_PIN, on ? LOW : HIGH);
#else
  digitalWrite(BUZZER_PIN, on ? HIGH : LOW);
#endif
}

void updateLeds(bool backendAlive) {
  bool flameNow    = (flame1 == LOW || flame2 == LOW);
  bool flameRecent = lastFlameSeen > 0 && (millis() - lastFlameSeen < FLAME_HOLD_MS);
  bool fire = flameNow || flameRecent || pumpOn || (backendAlive && backendSaysFire);

  digitalWrite(LED_RED_PIN,   fire ? HIGH : LOW);
  digitalWrite(LED_GREEN_PIN, fire ? LOW : HIGH);

  // Buzzer: beep-beep while there is fire, silent otherwise
  bool beepPhase = (millis() / BEEP_MS) % 2 == 0;
  writeBuzzer(fire && beepPhase);
}

// =========================
// Fire position (from which IR sensor sees the flame)
// =========================
void updateFirePosition() {
  bool f1 = (flame1 == LOW);   // sensor 1 = LEFT
  bool f2 = (flame2 == LOW);   // sensor 2 = RIGHT

  if (f1 && f2)      firePosition = "both";
  else if (f1)       firePosition = "left";
  else if (f2)       firePosition = "right";
  else               firePosition = "none";

  // Remember the pattern while spraying, so the sweep keeps going during the
  // 2 s hold after the flame disappears; reset once the pump stops
  if (strcmp(firePosition, "none") != 0) sprayPattern = firePosition;
  else if (!pumpOn && !pumpRequested)    sprayPattern = "none";

  // Print only when the position changes, so it stands out in Serial Monitor
  if (strcmp(firePosition, lastPrintedPosition) != 0) {
    lastPrintedPosition = firePosition;
    if (strcmp(firePosition, "none") == 0) {
      Serial.println("*** Fire cleared: no flame seen ***");
    } else if (strcmp(firePosition, "both") == 0) {
      Serial.printf("*** FIRE on BOTH sides (sensors 1 + 2) -> sweeping %d to %d deg and spraying ***\n",
                    ANGLE_CENTER - BOTH_SWEEP_WIDTH, ANGLE_CENTER + BOTH_SWEEP_WIDTH);
    } else {
      bool left = strcmp(firePosition, "left") == 0;
      int zone = left ? ANGLE_LEFT : ANGLE_RIGHT;
      Serial.printf("*** FIRE on the %s (sensor %s) -> turning to %d deg, spraying %d to %d deg ***\n",
                    left ? "LEFT" : "RIGHT", left ? "1" : "2",
                    zone, zone - SWEEP_WIDTH, zone + SWEEP_WIDTH);
    }
  }
}

void printStatus() {
  Serial.printf("T=%s H=%s F1=%d F2=%d smoke=%d | fire=%s | mode=%s target=%d angle=%d pump=%s led=%s\n",
                isnan(temperature) ? "null" : String(temperature, 1).c_str(),
                isnan(humidity)    ? "null" : String(humidity, 1).c_str(),
                flame1, flame2, smoke, firePosition,
                controlMode, targetAngle, currentAngle, pumpOn ? "ON" : "off",
                digitalRead(LED_RED_PIN) ? "RED" : "GREEN");
}


// =========================
// Setup
// =========================
void setup() {
  // Pump OFF before anything else, so it never fires during boot
  pinMode(PUMP_PIN, OUTPUT);
  writePumpPin(false);

  Serial.begin(115200);
  delay(500);
  Serial.println("\nSMART FIRE DETECTION + SUPPRESSION NODE");
  Serial.println("Pins: flame D27/D26, DHT D4, servo D18, relay D25, LEDs green D19 / red D21, buzzer D23");

  // Status LEDs. Weakest drive strength limits LED current a little,
  // but still use a 220 to 1k ohm resistor in series with each LED.
  pinMode(LED_GREEN_PIN, OUTPUT);
  pinMode(LED_RED_PIN, OUTPUT);
  gpio_set_drive_capability((gpio_num_t)LED_GREEN_PIN, GPIO_DRIVE_CAP_0);
  gpio_set_drive_capability((gpio_num_t)LED_RED_PIN, GPIO_DRIVE_CAP_0);
  digitalWrite(LED_GREEN_PIN, HIGH);
  digitalWrite(LED_RED_PIN, LOW);

  pinMode(BUZZER_PIN, OUTPUT);
  writeBuzzer(false);

  dht.begin();
  pinMode(FLAME1_PIN, INPUT);
  pinMode(FLAME2_PIN, INPUT);

  ESP32PWM::allocateTimer(0);
  nozzle.setPeriodHertz(50);
  nozzle.attach(SERVO_PIN, 500, 2400);  // SG90 pulse range
  nozzle.write(ANGLE_CENTER);

  connectWiFi();
  Serial.println("System ready.");
}


// =========================
// Main loop
// =========================
void loop() {
  unsigned long now = millis();

  readFlames();  // cheap, every loop, so local mode reacts fast

  if (now - lastSendTime >= SEND_INTERVAL) {
    lastSendTime = now;
    readSlowSensors();
    sendSensorData();
    printStatus();
  }

  bool backendAlive = lastBackendOk > 0 && (millis() - lastBackendOk < BACKEND_TIMEOUT_MS);
  if (!backendAlive) {
    controlMode = "local";
    decideLocally();
  }

  applyPumpSafety();
  updateFirePosition();
  updateLeds(backendAlive);

  if (millis() - lastServoTick >= SERVO_TICK_MS) {
    lastServoTick = millis();
    updateServo();
  }
}
