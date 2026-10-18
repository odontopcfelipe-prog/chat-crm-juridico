'use client';

// Lembrete em ÁUDIO (teste) — o texto vira mensagem de voz. Escolha motor, voz, sotaque e
// velocidade, ouça aqui e mande o teste pro seu número. Não envia sozinho pra paciente.
import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Play, Save, Send, Variable } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import {
  AUDIO_MOTORES, AUDIO_MOTOR_LABEL, AUDIO_SOTAQUES, AUDIO_TESTE_VARIAVEIS, AUDIO_TEXTO_MAX,
  AUDIO_VELOCIDADE_MAX, AUDIO_VELOCIDADE_MIN, AUDIO_VOZES, DEFAULT_AUDIO_TESTE,
  normalizarAudioConfig, type AudioMotor, type AudioTesteConfig,
} from '@crm/shared';

export function AudioTesteEditor({ podeEditar }: { podeEditar: boolean }) {
  const [cfg, setCfg] = useState<AudioTesteConfig>(DEFAULT_AUDIO_TESTE);
  const [motores, setMotores] = useState<Partial<Record<AudioMotor, boolean>> | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [gerando, setGerando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [telefone, setTelefone] = useState('');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const player = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    api.get('/disparos/audio-teste/config')
      .then((r) => { setCfg(normalizarAudioConfig(r.data?.config || {})); setMotores(r.data?.motores || null); })
      .catch(() => {})
      .finally(() => setCarregando(false));
  }, []);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);

  // Normaliza voz/sotaque/velocidade, mas deixa o TEXTO como a pessoa digitou (apagar tudo
  // não pode voltar sozinho pro padrão no meio da edição).
  const mudar = (p: Partial<AudioTesteConfig>) =>
    setCfg((c) => ({ ...normalizarAudioConfig({ ...c, ...p }), texto: (p.texto ?? c.texto).slice(0, AUDIO_TEXTO_MAX) }));
  const trocarMotor = (motor: AudioMotor) => setCfg((c) => normalizarAudioConfig({ ...c, motor, voz: AUDIO_VOZES[motor][0].id }));

  const ouvir = async () => {
    setGerando(true);
    try {
      const r = await api.post('/disparos/audio-teste/ouvir', cfg, { responseType: 'blob', timeout: 90000 });
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      const url = URL.createObjectURL(r.data);
      setAudioUrl(url);
      setTimeout(() => player.current?.play().catch(() => {}), 50);
    } catch (e: any) {
      // Erro vem como Blob (responseType blob): lê o texto pra mostrar o motivo.
      let msg = 'Não foi possível gerar o áudio';
      try { const t = await e?.response?.data?.text?.(); if (t) msg = JSON.parse(t)?.message || msg; } catch { /* mantém */ }
      showError(msg);
    } finally {
      setGerando(false);
    }
  };

  const salvar = async () => {
    setSalvando(true);
    try {
      const r = await api.put('/disparos/audio-teste/config', cfg);
      setCfg(normalizarAudioConfig(r.data?.config || cfg));
      showSuccess('Configuração salva');
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao salvar');
    } finally {
      setSalvando(false);
    }
  };

  const enviar = async () => {
    setEnviando(true);
    try {
      await api.post('/disparos/audio-teste/enviar', { config: cfg, telefone }, { timeout: 120000 });
      showSuccess('Áudio de teste enviado — confira o WhatsApp desse número');
    } catch (e: any) {
      showError(e?.response?.data?.message || 'O áudio não saiu');
    } finally {
      setEnviando(false);
    }
  };

  if (carregando) {
    return <div className="py-12 flex justify-center text-muted-foreground"><Loader2 size={18} className="animate-spin" /></div>;
  }
  const semChave = motores && !motores[cfg.motor];

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-2xl overflow-hidden">
        <div className="border-b border-border px-5 py-4 flex items-center gap-2">
          <Mic size={16} className="text-primary" />
          <h2 className="text-base font-bold">Lembrete em áudio (teste)</h2>
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400 ml-auto">Teste · não envia sozinho</span>
        </div>
        <div className="p-5 space-y-4 text-[12px]">
          <p className="text-muted-foreground">
            O texto vira uma mensagem de voz. Escolha o motor, a voz, o sotaque e a velocidade, clique em <b>Ouvir</b> e ajuste até
            ficar do seu jeito. Depois mande o teste pro seu WhatsApp. Este card ainda não envia pra pacientes.
          </p>

          <div className="p-3 rounded-xl bg-muted/30 border border-border">
            <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1"><Variable size={11} /> Variáveis</div>
            <div className="flex gap-3 flex-wrap">
              {AUDIO_TESTE_VARIAVEIS.map((v) => (
                <span key={v.key} className="text-muted-foreground">
                  <code className="font-mono text-primary bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded">{`{${v.key}}`}</code> {v.desc}
                </span>
              ))}
            </div>
          </div>
          <textarea value={cfg.texto} onChange={(e) => mudar({ texto: e.target.value })} rows={4} maxLength={AUDIO_TEXTO_MAX} disabled={!podeEditar}
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg resize-y" />
          <div className="text-[10px] text-muted-foreground -mt-3">{cfg.texto.length}/{AUDIO_TEXTO_MAX} · escreva como se fosse falar (emoji e asterisco são ignorados na voz)</div>

          <div className="grid sm:grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="font-semibold">Motor de voz</span>
              <select value={cfg.motor} onChange={(e) => trocarMotor(e.target.value as AudioMotor)} disabled={!podeEditar}
                className="w-full px-2 py-2 bg-background border border-border rounded-lg">
                {AUDIO_MOTORES.map((m) => (
                  <option key={m} value={m}>{AUDIO_MOTOR_LABEL[m]}{motores && !motores[m] ? ' — sem chave' : ''}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="font-semibold">Voz</span>
              <select value={cfg.voz} onChange={(e) => mudar({ voz: e.target.value })} disabled={!podeEditar}
                className="w-full px-2 py-2 bg-background border border-border rounded-lg">
                {AUDIO_VOZES[cfg.motor].map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="font-semibold">Sotaque</span>
              <select value={cfg.sotaque} onChange={(e) => mudar({ sotaque: e.target.value as any })} disabled={!podeEditar}
                className="w-full px-2 py-2 bg-background border border-border rounded-lg">
                {AUDIO_SOTAQUES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="font-semibold">Velocidade · {cfg.velocidade.toFixed(2).replace('.', ',')}x</span>
              <input type="range" min={AUDIO_VELOCIDADE_MIN} max={AUDIO_VELOCIDADE_MAX} step={0.05} value={cfg.velocidade}
                onChange={(e) => mudar({ velocidade: Number(e.target.value) })} disabled={!podeEditar} className="w-full" />
              <div className="flex justify-between text-[10px] text-muted-foreground"><span>mais devagar</span><span>normal</span><span>mais rápido</span></div>
            </label>
          </div>
          {semChave && (
            <div className="text-amber-700 dark:text-amber-400 font-semibold">
              Este motor não tem chave configurada — cadastre em Configurações › Inteligência Artificial, ou escolha o outro motor.
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">
            O sotaque e o ritmo são pedidos à voz por instrução — o resultado varia um pouco entre vozes e motores. Pra soar mais natural,
            use a <b>voz do ChatGPT</b> com <b>Marin</b> ou <b>Cedar</b>. A velocidade só é exata no leitor de texto; nos outros vai como instrução.
          </p>

          <div className="flex items-center gap-3 flex-wrap">
            <button type="button" onClick={ouvir} disabled={gerando || !cfg.texto.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 font-bold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50">
              {gerando ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Ouvir
            </button>
            {audioUrl && <audio ref={player} src={audioUrl} controls className="h-9" />}
            {podeEditar && (
              <button type="button" onClick={salvar} disabled={salvando}
                className="ml-auto inline-flex items-center gap-1.5 px-4 py-2 font-semibold border border-border rounded-lg hover:bg-accent disabled:opacity-50">
                {salvando ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Salvar
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="bg-card border border-border rounded-2xl p-5 space-y-2 text-[12px]">
        <div className="font-bold text-sm">Mandar o áudio de teste no WhatsApp</div>
        <div className="flex gap-2 flex-wrap items-center">
          <input value={telefone} onChange={(e) => setTelefone(e.target.value)} placeholder="DDD + número (ex.: 82999998888)"
            className="w-64 px-3 py-2 bg-background border border-border rounded-lg" />
          <button type="button" onClick={enviar} disabled={enviando || telefone.replace(/\D/g, '').length < 10}
            className="inline-flex items-center gap-1.5 px-3 py-2 font-semibold border border-border rounded-lg hover:bg-accent disabled:opacity-50">
            {enviando ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Enviar teste
          </button>
        </div>
        <p className="text-muted-foreground">Sai pelo chip da Clínica como mensagem de voz, com os dados de exemplo (paciente “Felipe”, 22/06 às 15:00).</p>
      </div>
    </div>
  );
}
