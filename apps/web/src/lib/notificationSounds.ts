export type SoundId = 'ding' | 'chime' | 'pop' | 'swoosh' | 'bell';

export interface SoundDef {
  id: SoundId;
  label: string;
  description: string;
}

export const NOTIFICATION_SOUNDS: SoundDef[] = [
  { id: 'ding',   label: 'Ding',       description: 'Sino simples e suave' },
  { id: 'chime',  label: 'Chime',      description: 'Dois tons ascendentes' },
  { id: 'pop',    label: 'Pop',        description: 'Bolha leve' },
  { id: 'swoosh', label: 'Swoosh',     description: 'Varredura ascendente' },
  { id: 'bell',   label: 'Sino Rico',  description: 'Sino com harmônicos' },
];

const STORAGE_KEY = 'notification_sound_id';

export function getNotificationSoundId(): SoundId {
  if (typeof window === 'undefined') return 'ding';
  return (localStorage.getItem(STORAGE_KEY) as SoundId) || 'ding';
}

export function setNotificationSoundId(id: SoundId): void {
  localStorage.setItem(STORAGE_KEY, id);
}

// ─── WAV generator ───────────────────────────────────────────────
// Gera um buffer WAV 16-bit mono diretamente em PCM (sem arquivo externo).

function writeStr(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function buildWav(samples: Float32Array, sampleRate: number): Blob {
  const numSamples = samples.length;
  const buf = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buf);
  writeStr(view, 0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(view, 8, 'WAVE');
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);   // PCM
  view.setUint16(22, 1, true);   // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(view, 36, 'data');
  view.setUint32(40, numSamples * 2, true);
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

type Partial2 = { freq: number; vol: number };

function synthWav(
  partials: Partial2[],
  duration: number,
  sampleRate = 22050,
  attackTime = 0.005,
): Blob {
  const n = Math.floor(sampleRate * duration);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, t / attackTime) * Math.exp(-t * 6);
    let s = 0;
    for (const { freq, vol } of partials) {
      s += Math.sin(2 * Math.PI * freq * t) * vol * env;
    }
    out[i] = s;
  }
  return buildWav(out, sampleRate);
}

// Pre-generates WAV blobs for each sound at module load time.
function makeSounds(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const make = URL.createObjectURL;
  return {
    ding:   make(synthWav([{ freq: 880, vol: 0.4 }], 0.9)),
    chime:  make(synthWav([{ freq: 659, vol: 0.3 }, { freq: 784, vol: 0.25 }], 0.8, 22050, 0.01)),
    pop:    make(synthWav([{ freq: 280, vol: 0.55 }], 0.12, 22050, 0.001)),
    swoosh: make(synthWav([{ freq: 350, vol: 0.3 }, { freq: 700, vol: 0.2 }, { freq: 1100, vol: 0.1 }], 0.35, 22050, 0.06)),
    bell:   make(synthWav([
      { freq: 440, vol: 0.40 }, { freq: 880, vol: 0.20 },
      { freq: 1100, vol: 0.15 }, { freq: 1320, vol: 0.10 },
    ], 1.4, 22050, 0.01)),
  };
}

const SOUND_URLS: Record<string, string> = makeSounds();

// ─── Audio element singleton ─────────────────────────────────────
// <audio> elements desbloqueados via user gesture não ficam suspensos
// como o AudioContext. O padrão é: play()+pause() no primeiro gesto
// do usuário para desbloquear; depois play() funciona de qualquer contexto.

let _audio: HTMLAudioElement | null = null;
let _unlocked = false;

function getAudio(soundUrl: string): HTMLAudioElement {
  if (!_audio) {
    _audio = new Audio(soundUrl);
  } else {
    _audio.src = soundUrl;
  }
  _audio.currentTime = 0;
  return _audio;
}

/**
 * Chame no primeiro clique/keydown do usuário para desbloquear o áudio.
 * Após isso, playNotificationSound() funciona a qualquer momento.
 */
export function unlockAudioContext(): void {
  if (_unlocked || typeof window === 'undefined') return;
  const soundId = getNotificationSoundId();
  const url = SOUND_URLS[soundId] || SOUND_URLS['ding'];
  if (!url) return;
  const audio = new Audio(url);
  audio.volume = 0.001;
  audio.play().then(() => {
    audio.pause();
    _unlocked = true;
  }).catch(() => { _unlocked = true; }); // mark as attempted even on error
}

export function playNotificationSound(soundId?: SoundId | string): void {
  if (typeof window === 'undefined') return;
  const id: string = soundId ?? getNotificationSoundId();
  const url = SOUND_URLS[id] || SOUND_URLS['ding'];
  if (!url) return;

  try {
    const audio = getAudio(url);
    audio.volume = 1;
    const p = audio.play();
    if (p) p.catch(() => {});
  } catch {
    // silently ignore
  }
}
