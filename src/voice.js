// Запись с микрофона (MediaRecorder) + распознавание через Groq Whisper
// (прокси Vite: /api/transcribe -> api.groq.com/openai/v1/audio/transcriptions).

let mediaRecorder = null;
let chunks = [];
let activeStream = null;

export function isRecording() {
  return mediaRecorder?.state === 'recording';
}

export async function startRecording() {
  if (isRecording()) return;
  activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  chunks = [];
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  mediaRecorder = mime ? new MediaRecorder(activeStream, { mimeType: mime }) : new MediaRecorder(activeStream);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  mediaRecorder.start();
}

export function stopRecording() {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      reject(new Error('Запись не начата'));
      return;
    }
    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      activeStream?.getTracks().forEach((t) => t.stop());
      activeStream = null;
      resolve(blob);
    };
    mediaRecorder.stop();
  });
}

export async function transcribe(blob) {
  const form = new FormData();
  form.append('file', blob, 'recording.webm');
  form.append('model', 'whisper-large-v3');
  const res = await fetch('/api/transcribe', { method: 'POST', body: form });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Groq Whisper ${res.status}: ${detail || res.statusText}`);
  }
  const data = await res.json();
  return (data.text || '').trim();
}
