#include <WiFi.h>
#include <HTTPClient.h>
#include "DHT.h"

// =========================
// Wi-Fi
// =========================
const char* WIFI_SSID = "";
const char* WIFI_PASSWORD = "";

// =========================
// FastAPI Backend
// =========================
// Your Mac's current home Wi-Fi IP
const char* API_URL = "http://192.168.1.55:8000/api/sensors";

// =========================
// Device
// =========================
const char* DEVICE_ID = "esp32-fire-01";

// =========================
// Sensors
// =========================
#define DHTPIN 4
#define DHTTYPE DHT11

#define FLAME1_PIN 27
#define FLAME2_PIN 26

// MQ-2 NOT CONNECTED YET
#define MQ2_CONNECTED 0
#define MQ2_PIN 34

DHT dht(DHTPIN, DHTTYPE);

// Send data every 1 second
const unsigned long SEND_INTERVAL = 1000;
unsigned long lastSendTime = 0;


// =========================
// Wi-Fi Connection
// =========================
void connectWiFi() {

  Serial.println();
  Serial.println("================================");
  Serial.println("Connecting to Wi-Fi...");
  Serial.println("================================");

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

    Serial.println("Wi-Fi connected!");
    Serial.print("ESP32 IP: ");
    Serial.println(WiFi.localIP());

    Serial.print("Backend: ");
    Serial.println(API_URL);

  } else {

    Serial.println("Wi-Fi connection FAILED.");
    Serial.println("Check SSID/password.");
  }
}


// =========================
// Setup
// =========================
void setup() {

  Serial.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println("================================");
  Serial.println("SMART FIRE & SMOKE MONITOR");
  Serial.println("ESP32 Sensor Node");
  Serial.println("================================");

  // Sensor setup
  dht.begin();

  pinMode(FLAME1_PIN, INPUT);
  pinMode(FLAME2_PIN, INPUT);

  // Connect Wi-Fi
  connectWiFi();

  Serial.println();
  Serial.println("System ready.");
}


// =========================
// Send data to FastAPI
// =========================
void sendSensorData() {

  // -------------------------
  // Read DHT11
  // -------------------------
  float temperature = dht.readTemperature();
  float humidity = dht.readHumidity();

  // -------------------------
  // Read flame sensors
  // Active LOW:
  // 0 = flame detected
  // 1 = no flame
  // -------------------------
  int flame1 = digitalRead(FLAME1_PIN);
  int flame2 = digitalRead(FLAME2_PIN);

  // -------------------------
  // MQ-2
  // -------------------------
  String smokeValue = "null";

#if MQ2_CONNECTED

  int smoke = analogRead(MQ2_PIN);
  smokeValue = String(smoke);

#endif

  // -------------------------
  // DHT11 JSON values
  // -------------------------
  String temperatureValue;
  String humidityValue;

  if (isnan(temperature) || isnan(humidity)) {

    temperatureValue = "null";
    humidityValue = "null";

    Serial.println("DHT11: data unavailable");

  } else {

    temperatureValue = String(temperature, 1);
    humidityValue = String(humidity, 1);
  }


  // -------------------------
  // Create JSON
  // -------------------------
  String json = "{";

  json += "\"temperature\":" + temperatureValue + ",";
  json += "\"humidity\":" + humidityValue + ",";
  json += "\"flame1\":" + String(flame1) + ",";
  json += "\"flame2\":" + String(flame2) + ",";
  json += "\"smoke\":" + smokeValue + ",";
  json += "\"device_id\":\"" + String(DEVICE_ID) + "\"";

  json += "}";


  // -------------------------
  // Serial output
  // -------------------------
  Serial.println();
  Serial.println("--------------------------------");
  Serial.println("Sensor Data");
  Serial.println("--------------------------------");

  Serial.print("Temperature: ");
  Serial.print(temperatureValue);
  Serial.println(" °C");

  Serial.print("Humidity: ");
  Serial.print(humidityValue);
  Serial.println(" %");

  Serial.print("Flame 1: ");
  Serial.println(flame1);

  Serial.print("Flame 2: ");
  Serial.println(flame2);

  Serial.print("MQ-2: ");
  Serial.println(smokeValue);

  Serial.print("JSON: ");
  Serial.println(json);


  // -------------------------
  // Check Wi-Fi
  // -------------------------
  if (WiFi.status() != WL_CONNECTED) {

    Serial.println("Wi-Fi disconnected.");
    Serial.println("Reconnecting...");

    connectWiFi();

    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("Could not reconnect.");
      return;
    }
  }


  // -------------------------
  // HTTP POST
  // -------------------------
  HTTPClient http;

  Serial.println();
  Serial.println("Sending data to FastAPI...");

  http.begin(API_URL);

  http.addHeader("Content-Type", "application/json");

  int httpResponseCode = http.POST(json);


  // -------------------------
  // Response
  // -------------------------
  if (httpResponseCode > 0) {

    Serial.print("HTTP Response Code: ");
    Serial.println(httpResponseCode);

    String response = http.getString();

    Serial.print("Backend Response: ");
    Serial.println(response);

  } else {

    Serial.print("HTTP Request FAILED. Error: ");
    Serial.println(http.errorToString(httpResponseCode));

  }

  http.end();
}


// =========================
// Main Loop
// =========================
void loop() {

  unsigned long currentTime = millis();

  if (currentTime - lastSendTime >= SEND_INTERVAL) {

    lastSendTime = currentTime;

    sendSensorData();
  }

}