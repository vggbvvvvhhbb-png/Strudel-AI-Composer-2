#!/bin/bash
# Проверка аудио-блока на развёрнутой студии: отчёт рендера попадает в скор.
BASE=https://music.34.88.114.146.sslip.io
REPORT='{"engineVersion":"strudel-web@1.3.0/superdough@1.3.0","sampleRate":48000,"renderMode":"offline","repeatability":{"runs":2,"lufsDeltaDb":0.02,"passed":true},"lufsI":-14,"truePeakDbtp":-1.2,"peakDbfs":-1.4,"clipCount":0,"crestDb":12,"bands":{"sub":-30,"low":-20,"lowMid":-15,"mid":-12,"highMid":-20,"high":-30},"silence":{"head":0,"tail":0,"internal":0},"parts":{}}'

echo "--- без отчёта (только код) ---"
curl -sk -X POST "$BASE/api/music/analyze" -H 'Content-Type: application/json' \
  -d '{"code":"s(\"bd*4\").gain(0.8)","style":"techno"}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("total:", d["score"]["total"], "| audio:", d["score"]["audio"])'

echo "--- с отчётом о рендере (аудио-блок 20%) ---"
curl -sk -X POST "$BASE/api/music/analyze" -H 'Content-Type: application/json' \
  -d "{\"code\":\"s(\\\"bd*4\\\").gain(0.8)\",\"style\":\"techno\",\"audioReport\":$REPORT}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("total:", d["score"]["total"], "| v1Total:", d["score"]["v1Total"], "| audio block:", d["score"]["audio"]["total"], "| findings:", len(d["audio"]["findings"]), "| rejected:", d.get("audioRejected"))'

echo "--- битый отчёт не ломает запрос ---"
curl -sk -X POST "$BASE/api/music/analyze" -H 'Content-Type: application/json' \
  -d '{"code":"s(\"bd*4\").gain(0.8)","style":"techno","audioReport":{"lufsI":"громко"}}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("total:", d["score"]["total"], "| audio:", d["score"]["audio"], "| rejected:", d.get("audioRejected"))'
