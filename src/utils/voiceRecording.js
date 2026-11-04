// Voice recording with MediaRecorder, independent of React so every outcome is testable with fakes.
//
// startVoiceRecording() resolves once recording has started (or rejects with a VoiceError), and returns
// { stop(), done }. `done` resolves with { blob, mimeType, seconds, interrupted } or rejects with a
// VoiceError. A recording counts only if it produced bytes within the size limit; nothing here claims
// it is saved (that happens when the record is submitted).
import { MEDIA_RULES } from '../database/mediaStore.js';

export class VoiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VoiceError';
    this.code = code;
  }
}

// Recording formats in order of preference. The server accepts WebM voice as video/webm (its content
// sniffing reports WebM as video), so the declared type is normalised accordingly.
const VOICE_FORMATS = [
  ['audio/webm;codecs=opus', 'video/webm'], ['audio/webm', 'video/webm'], ['audio/mp4', 'audio/mp4'], ['audio/ogg;codecs=opus', 'audio/ogg'],
];

export const voiceFormat = (isSupported = (t) => globalThis.MediaRecorder?.isTypeSupported?.(t)) => VOICE_FORMATS.find(([t]) => isSupported(t)) ?? null;

export async function startVoiceRecording({
  mediaDevices = globalThis.navigator?.mediaDevices,
  Recorder = globalThis.MediaRecorder,
  maxSeconds = 120,
  maxBytes = MEDIA_RULES.feedback_voice.maxBytes,
  onTick = () => {},
  now = () => Date.now(),
  setInterval: every = globalThis.setInterval,
  clearInterval: cancel = globalThis.clearInterval,
} = {}) {
  const format = Recorder && voiceFormat((t) => Recorder.isTypeSupported?.(t));
  if (!mediaDevices?.getUserMedia || !format) throw new VoiceError('unsupported', 'Voice recording is not supported by this browser.');
  let stream;
  try {
    stream = await mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
      throw new VoiceError('permission_denied', 'Microphone permission was denied. Allow it in the browser settings to record.');
    }
    throw new VoiceError('no_microphone', 'No microphone is available.');
  }
  const [recordType, declaredType] = format;
  const chunks = [];
  let size = 0;
  let interrupted = false;
  const recorder = new Recorder(stream, { mimeType: recordType, audioBitsPerSecond: 32_000 });
  const started = now();
  const seconds = () => Math.floor((now() - started) / 1000);
  const stopNow = () => {
    if (recorder.state !== 'inactive') recorder.stop();
  };
  const timer = every(() => {
    onTick(seconds());
    if (seconds() >= maxSeconds) stopNow();
  }, 500);

  const done = new Promise((resolve, reject) => {
    recorder.ondataavailable = (e) => {
      if (!e.data?.size) return;
      chunks.push(e.data);
      size += e.data.size;
      if (size > maxBytes) stopNow();
    };
    recorder.onerror = () => {
      interrupted = true;
      stopNow();
    };
    recorder.onstop = () => {
      cancel(timer);
      stream.getTracks().forEach((t) => t.stop());
      if (!size) return reject(new VoiceError('empty', 'Nothing was recorded.'));
      if (size > maxBytes) return reject(new VoiceError('too_large', 'The recording is too large. Record a shorter comment.'));
      return resolve({ blob: new Blob(chunks, { type: declaredType }), mimeType: declaredType, seconds: seconds(), interrupted });
    };
  });
  // The microphone was taken away (phone call, permission revoked): keep what was recorded so far.
  stream.getAudioTracks?.()[0]?.addEventListener?.('ended', () => {
    interrupted = true;
    stopNow();
  });
  recorder.start(1000);
  return { stop: stopNow, done };
}
