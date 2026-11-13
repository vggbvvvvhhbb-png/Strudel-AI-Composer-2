#!/bin/bash
# Проверка развёрнутой студии: страница, ассеты, API, швейка.
BASE=https://music.34.88.114.146.sslip.io

echo "--- главная страница ---"
curl -sk "$BASE/" | grep -o '<title>[^<]*</title>'
echo -n "элементов панели: "
curl -sk "$BASE/" | grep -c 'code-input'

echo "--- ассеты ---"
for a in $(curl -sk "$BASE/" | grep -o '/assets/[^"]*\.js' | head -2); do
  echo -n "$a -> "
  curl -sk -o /dev/null -w '%{http_code}\n' "$BASE$a"
done
echo -n "/worklets/master-processor.js -> "
curl -sk -o /dev/null -w '%{http_code}\n' "$BASE/worklets/master-processor.js"

echo "--- API: разбор ---"
curl -sk -X POST "$BASE/api/music/analyze" \
  -H 'Content-Type: application/json' \
  -d '{"code":"s(\"bd*4\").gain(0.8)","style":"techno"}' | head -c 300
echo

echo "--- API: разбор с отчётом о рендере (аудио-блок) ---"
curl -sk -X POST "$BASE/api/music/analyze" \
  -H 'Content-Type: application/json' \
  -d '{"code":"s(\"bd*4\").gain(0.8)","style":"techno","audioReport":{"engineVersion":"strudel-web@1.3.0/superdough@1.3.0","sampleRate":48000,"renderMode":"offline","repeatability":{"runs":2,"lufsDeltaDb":0.02,"passed":true},"lufsI":-14,"truePeakDbtp":-1.2,"peakDbfs":-1.4,"clipCount":0,"crestDb":12,"bands":{"sub":-30,"low":-20,"lowMid":-15,"mid":-12,"highMid":-20,"high":-30},"silence":{"head":0,"tail":0,"internal":0},"parts":{}}}' \
  | head -c 400
echo

echo "--- швейка не сломана ---"
curl -sk -o /dev/null -w 'shveyka-igolka.ru: %{http_code}\n' https://shveyka-igolka.ru/ || true
curl -sk -o /dev/null -w 'shveyka sslip: %{http_code}\n' https://34.88.114.146.sslip.io/
