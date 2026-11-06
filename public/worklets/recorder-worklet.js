// AudioWorklet: копит PCM float32 всех каналов мастер-шины во время записи.
class RecProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.channels = [];
    this.frames = 0;
    this.port.onmessage = (e) => {
      if (e.data.cmd === 'start') {
        this.recording = true;
        this.channels = [];
        this.frames = 0;
      }
      if (e.data.cmd === 'stop') {
        this.recording = false;
        this.port.postMessage({ done: true, channels: this.channels, frames: this.frames });
        this.channels = [];
      }
    };
  }

  process(inputs) {
    if (!this.recording) return true;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const snapshot = [];
    for (let c = 0; c < input.length; c++) snapshot.push(new Float32Array(input[c]));
    if (!this.channels.length) {
      for (let c = 0; c < snapshot.length; c++) this.channels.push([]);
    }
    for (let c = 0; c < snapshot.length && c < this.channels.length; c++) {
      this.channels[c].push(snapshot[c]);
    }
    this.frames += snapshot[0].length;
    this.port.postMessage({ frames: this.frames });
    return true;
  }
}

registerProcessor('rec-processor', RecProcessor);
