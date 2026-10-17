'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import { Mic, Square, X } from 'lucide-react';
import api from '@/lib/api';
import { showError, showInfo } from '@/lib/toast';

// Clique sem querer no microfone vira áudio de "0 segundos" — o WhatsApp também
// descarta gravação curta demais.
const MIN_AUDIO_MS = 800;

/** Explica pro operador por que o navegador não liberou o microfone (antes era
 *  um alert genérico e, no envio, o erro ia só pro console — "não acontece nada"). */
function micErrorMessage(err: unknown): string {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return 'A gravação de áudio só funciona com o sistema aberto em https.';
  }
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microfone bloqueado. Clique no cadeado ao lado do endereço do site e permita o microfone.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'Nenhum microfone encontrado neste aparelho.';
  }
  if (name === 'NotReadableError') {
    return 'O microfone está sendo usado por outro programa. Feche-o e tente de novo.';
  }
  return 'Não foi possível acessar o microfone.';
}

type HttpError = { response?: { status?: number; data?: { message?: string | string[] } } } | null;

function uploadErrorMessage(err: unknown): string {
  const e = err as HttpError;
  const status = e?.response?.status;
  if (status === 429) return 'Muitos envios em sequência. Espere alguns segundos e tente de novo.';
  const msg = e?.response?.data?.message;
  if (msg) return `Falha ao enviar o áudio: ${Array.isArray(msg) ? msg.join(', ') : msg}`;
  if (!e?.response) return 'Falha ao enviar o áudio: sem conexão com o servidor.';
  return 'Falha ao enviar o áudio.';
}

export type AudioRecorderStatus = 'idle' | 'recording' | 'sending';

interface UseAudioRecorderOptions {
  conversationId: string | null | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bolha da API (formato do MessageItem de cada tela)
  onSent: (msg: any) => void;
  onRecordingStart?: () => void;
}

/**
 * Grava um áudio pelo microfone e envia pra conversa (POST /messages/send-audio).
 * O áudio vai SEMPRE pra conversa em que a gravação começou: trocar de conversa
 * no meio descarta a gravação (antes, parar depois de trocar mandava o áudio
 * pra conversa nova).
 */
export function useAudioRecorder({ conversationId, onSent, onRecordingStart }: UseAudioRecorderOptions) {
  const [status, setStatus] = useState<AudioRecorderStatus>('idle');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const recordingConvRef = useRef<string | null>(null);
  const startingRef = useRef(false);
  const currentConvRef = useRef(conversationId);
  currentConvRef.current = conversationId;
  const onSentRef = useRef(onSent);
  onSentRef.current = onSent;
  const onStartRef = useRef(onRecordingStart);
  onStartRef.current = onRecordingStart;

  const releaseMic = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* já parado */ }
      }
    }
    chunksRef.current = [];
    recordingConvRef.current = null;
    releaseMic();
    setStatus((s) => (s === 'recording' ? 'idle' : s));
  }, [releaseMic]);

  const start = useCallback(async () => {
    const convId = conversationId;
    if (!convId || startingRef.current || recorderRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      showError(window.isSecureContext
        ? 'Este navegador não grava áudio. Use o Chrome, Edge ou Safari atualizado.'
        : 'A gravação de áudio só funciona com o sistema aberto em https.');
      return;
    }
    startingRef.current = true;
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      // Trocou de conversa enquanto o navegador pedia permissão: não grava.
      if (currentConvRef.current !== convId) {
        mic.getTracks().forEach((t) => t.stop());
        return;
      }
      // Prioriza OGG (formato PTT nativo do WhatsApp) → WebM → MP4 (Safari)
      const preferredTypes = [
        'audio/ogg;codecs=opus',
        'audio/ogg',
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
      ];
      const mimeType = preferredTypes.find((t) => MediaRecorder.isTypeSupported(t)) || '';
      const recorder = new MediaRecorder(mic, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start();
      recorderRef.current = recorder;
      streamRef.current = mic;
      recordingConvRef.current = convId;
      startedAtRef.current = Date.now();
      setStartedAt(startedAtRef.current);
      setStream(mic);
      setStatus('recording');
      onStartRef.current?.();
    } catch (err) {
      console.warn('[AUDIO] Microfone indisponível:', err);
      showError(micErrorMessage(err));
    } finally {
      startingRef.current = false;
    }
  }, [conversationId]);

  const stopAndSend = useCallback(() => {
    const recorder = recorderRef.current;
    const convId = recordingConvRef.current;
    if (!recorder || !convId) return;
    recorderRef.current = null;
    recordingConvRef.current = null;
    const durationMs = Date.now() - startedAtRef.current;

    recorder.onstop = async () => {
      const mimeType = recorder.mimeType || chunksRef.current[0]?.type || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type: mimeType });
      chunksRef.current = [];
      if (durationMs < MIN_AUDIO_MS || blob.size === 0) {
        setStatus('idle');
        showInfo('Áudio muito curto — toque no microfone, fale e depois toque em enviar.');
        return;
      }
      try {
        // Deriva extensão do mimeType real gravado pelo browser
        const clean = mimeType.split(';')[0].trim();
        const extMap: Record<string, string> = {
          'audio/ogg': 'ogg',
          'audio/webm': 'webm',
          'audio/mp4': 'mp4',
          'audio/mpeg': 'mp3',
          'audio/wav': 'wav',
        };
        const ext = extMap[clean] ?? clean.split('/')[1] ?? 'webm';
        const formData = new FormData();
        formData.append('conversationId', convId);
        formData.append('audio', blob, `gravacao.${ext}`);
        const res = await api.post('/messages/send-audio', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        if (res.data?.id) onSentRef.current(res.data);
      } catch (e) {
        console.error('[AUDIO] Falha ao enviar áudio:', e);
        showError(uploadErrorMessage(e));
      } finally {
        setStatus('idle');
      }
    };

    setStatus('sending');
    try {
      recorder.stop();
    } catch {
      setStatus('idle');
    }
    releaseMic();
  }, [releaseMic]);

  // Trocou de conversa (ou saiu da tela) gravando: descarta e solta o microfone.
  useEffect(() => cancel, [conversationId, cancel]);

  return { status, stream, startedAt, start, stopAndSend, cancel };
}

/** Cronômetro + ondas do microfone ao vivo (como no WhatsApp). Componente
 *  próprio pra não redesenhar a tela inteira do chat 10× por segundo. */
export function RecordingWave({ stream, startedAt, bars = 36 }: { stream: MediaStream | null; startedAt: number; bars?: number }) {
  const [levels, setLevels] = useState<number[]>(() => Array(bars).fill(0));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    if (stream) {
      try {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
        ctx = new Ctor();
        ctx.resume?.().catch(() => {});
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(analyser);
      } catch {
        analyser = null;
      }
    }
    const buf = analyser ? new Uint8Array(analyser.fftSize) : null;
    const id = setInterval(() => {
      setNow(Date.now());
      if (!analyser || !buf) return;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
      setLevels((prev) => [...prev.slice(1), level]);
    }, 100);
    return () => {
      clearInterval(id);
      ctx?.close().catch(() => {});
    };
  }, [stream]);

  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

  return (
    <div className="flex items-center gap-2.5 min-w-0 flex-1">
      <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shrink-0" />
      <span className="text-[15px] tabular-nums text-foreground shrink-0 w-10">{clock}</span>
      <div className="flex items-center gap-[3px] h-7 flex-1 min-w-0 overflow-hidden" aria-hidden>
        {levels.map((l, i) => (
          <span
            key={i}
            className="wa-wave-bar w-[3px] rounded-full shrink-0"
            style={{ height: `${Math.max(12, Math.round(l * 100))}%` }}
          />
        ))}
      </div>
    </div>
  );
}

interface AudioRecorderProps {
  conversationId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bolha da API (formato do MessageItem de cada tela)
  onSent: (msg: any) => void;
  disabled?: boolean;
  onRecordingStart?: () => void;
}

/** Botão compacto de gravar (usado no chat de tela cheia e na visão split). */
export function AudioRecorder({ conversationId, onSent, disabled, onRecordingStart }: AudioRecorderProps) {
  const rec = useAudioRecorder({ conversationId, onSent, onRecordingStart });

  if (rec.status === 'sending') {
    return (
      <div className="flex items-center px-3 py-2 text-xs text-muted-foreground animate-pulse">
        Enviando áudio...
      </div>
    );
  }

  if (rec.status === 'recording') {
    return (
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs text-red-400 font-medium animate-pulse">
          <span className="w-2 h-2 bg-red-500 rounded-full" />
          Gravando...
        </span>
        <button
          onClick={rec.cancel}
          className="p-2 rounded-xl text-muted-foreground hover:bg-accent transition-colors"
          title="Cancelar gravação"
        >
          <X size={18} />
        </button>
        <button
          onClick={rec.stopAndSend}
          className="p-2 rounded-xl bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
          title="Parar e enviar"
        >
          <Square size={18} fill="currentColor" />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={rec.start}
      disabled={disabled}
      className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50 transition-colors"
      title="Gravar áudio"
    >
      <Mic size={18} />
    </button>
  );
}
