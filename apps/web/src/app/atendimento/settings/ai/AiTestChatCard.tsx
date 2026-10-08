'use client';

import { useEffect, useRef, useState } from 'react';
import { MessageCircle, Send, RotateCcw, RefreshCw } from 'lucide-react';
import api from '@/lib/api';
import { OPENAI_MODELS, ANTHROPIC_MODELS } from './ai-models';

type Msg = { from: 'patient' | 'ai'; text: string; model?: string };
type Meta = {
  skill: string | null;
  model: string;
  tools: string[];
  handoff: boolean;
  scheduling: string | null;
  style: string | null;
  // Perfil da IA do chip testado (Ajustes › IA › gaveta do chip) — vem em data.profile.
  assistantName: string | null;
  replyLength: string | null;
  effectiveStyle: string | null;
};

const CHIPS = [
  { id: 'COMERCIAL', label: 'Comercial (lead novo)' },
  { id: 'CLINICA', label: 'Clínica' },
  { id: 'FINANCEIRO', label: 'Financeiro' },
] as const;
type ChipId = (typeof CHIPS)[number]['id'];

// Rótulo do tamanho das respostas (perfil do chip) e do estilo que valeu nesta resposta.
const LENGTH_LABEL: Record<string, string> = {
  auto: 'automático',
  curta: 'curtas',
  media: 'médias',
  longa: 'longas',
  curto: 'curtas',
  medio: 'médias',
  longo: 'longas',
  equilibrado: 'médias',
  normal: 'médias',
};
const lengthLabel = (v: string | null) => (v ? LENGTH_LABEL[v] || v : '');

/**
 * Chat de teste da Sophia. Usa o mesmo cérebro do WhatsApp (skills do chip, guia
 * de conversa, valores e horários reais da agenda), mas NADA é enviado nem gravado:
 * agendamento e mudança de etapa são só simulados.
 */
/** chipNames: nome da assistente de cada chip (perfil salvo) — usado antes da 1ª resposta. */
export function AiTestChatCard({ chipNames }: { chipNames?: Partial<Record<string, string>> } = {}) {
  const [chip, setChip] = useState<ChipId>('COMERCIAL');
  const [isClient, setIsClient] = useState(false);
  // '' = usa o modelo configurado na skill (o mesmo do WhatsApp)
  const [model, setModel] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [msgs, busy]);

  const reset = () => {
    setMsgs([]);
    setMeta(null);
    setError(null);
  };

  const send = () => {
    // Cada linha (Shift+Enter) vira uma mensagem separada do paciente — simula
    // quem manda várias mensagens curtas em sequência.
    const lines = input.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length || busy) return;
    setInput('');
    ask([...msgs, ...lines.map((text) => ({ from: 'patient' as const, text }))]);
  };

  // Refaz a ÚLTIMA resposta da Sophia com o modelo selecionado agora — pra comparar
  // IAs na mesma conversa.
  const redo = () => {
    if (busy) return;
    let end = msgs.length;
    while (end > 0 && msgs[end - 1].from === 'ai') end--;
    if (end === 0 || end === msgs.length) return;
    ask(msgs.slice(0, end));
  };

  const ask = async (history: Msg[]) => {
    setMsgs(history);
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post(
        '/settings/ai-test-chat',
        { purpose: chip, isClient, model: model || undefined, history: history.map(({ from, text }) => ({ from, text })) },
        { timeout: 100_000 },
      );
      const bubbles: string[] = Array.isArray(data?.bubbles) ? data.bubbles : [];
      setMsgs([...history, ...bubbles.map((b) => ({ from: 'ai' as const, text: b, model: data?.model || '' }))]);
      setMeta({
        skill: data?.skill || null,
        model: data?.model || '',
        tools: data?.tools || [],
        handoff: !!data?.handoff,
        style: data?.patientStyle || null,
        assistantName: data?.profile?.assistantName || null,
        replyLength: data?.profile?.replyLength || null,
        effectiveStyle: data?.profile?.effectiveStyle || null,
        scheduling: data?.scheduling_action?.action
          ? `${data.scheduling_action.action}${data.scheduling_action.date ? ` ${data.scheduling_action.date} ${data.scheduling_action.time || ''}` : ''}`
          : null,
      });
    } catch (e: any) {
      setError(e?.response?.data?.message || 'A IA não respondeu. Tente de novo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
      <div className="p-4 border-b border-border flex flex-wrap items-center justify-between gap-3 bg-primary/5">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <MessageCircle size={16} />
          </div>
          <div>
            <h4 className="text-sm font-bold text-foreground">Testar a IA</h4>
            <p className="text-[11px] text-muted-foreground mt-0.5 max-w-lg">
              Converse como se fosse um paciente. É a mesma IA do WhatsApp, mas nada é enviado nem gravado.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={chip}
            onChange={(e) => { setChip(e.target.value as ChipId); reset(); }}
            className="text-xs rounded-lg border border-border bg-background px-2 py-1.5 text-foreground"
          >
            {CHIPS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            title="IA usada SÓ neste teste. O WhatsApp continua com a IA configurada na skill."
            className="text-xs rounded-lg border border-border bg-background px-2 py-1.5 text-foreground"
          >
            <option value="">IA: a da skill (igual ao WhatsApp)</option>
            <optgroup label="OpenAI">
              {OPENAI_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </optgroup>
            <optgroup label="Anthropic (precisa da chave Anthropic)">
              {ANTHROPIC_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </optgroup>
          </select>
          <label className="text-xs text-muted-foreground flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={isClient} onChange={(e) => { setIsClient(e.target.checked); reset(); }} />
            Já é paciente
          </label>
          <button
            type="button"
            onClick={reset}
            className="text-xs font-semibold text-muted-foreground hover:text-foreground flex items-center gap-1 px-2 py-1.5"
          >
            <RotateCcw size={13} /> Recomeçar
          </button>
        </div>
      </div>

      <div className="h-[380px] overflow-y-auto px-4 py-4 space-y-2 bg-muted/20">
        {msgs.length === 0 && !busy && (
          <p className="text-center text-xs text-muted-foreground mt-24">
            Escreva como um paciente escreveria. Ex.: &quot;Boa tarde, quanto fica a limpeza?&quot;<br />Shift+Enter: cada linha vira uma mensagem separada do paciente.
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.from === 'patient' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm shadow-sm ${
                m.from === 'patient'
                  ? 'bg-primary text-primary-foreground rounded-br-md'
                  : 'bg-card border border-border text-foreground rounded-bl-md'
              }`}
            >
              {m.text}
              {m.from === 'ai' && m.model && (i === msgs.length - 1 || msgs[i + 1]?.from !== 'ai') && (
                <div className="mt-1 text-[10px] text-muted-foreground">{m.model}</div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-md bg-card border border-border px-3.5 py-2 text-xs text-muted-foreground">
              {meta?.assistantName || chipNames?.[chip] || 'Sophia'} está digitando…
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {meta && (
        <div className="px-4 py-2 border-t border-border text-[11px] text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
          <span>Skill: <b className="text-foreground">{meta.skill || 'nenhuma'}</b></span>
          <span>Modelo: <b className="text-foreground">{meta.model}</b></span>
          {(meta.assistantName || meta.replyLength) && (
            <span>
              {meta.assistantName && <>Assistente: <b className="text-foreground">{meta.assistantName}</b></>}
              {meta.assistantName && meta.replyLength && ' · '}
              {meta.replyLength && (
                <>
                  Respostas: <b className="text-foreground">{lengthLabel(meta.replyLength)}</b>
                  {meta.replyLength === 'auto' && meta.effectiveStyle && meta.effectiveStyle !== 'auto' && (
                    <> (agora: {lengthLabel(meta.effectiveStyle)})</>
                  )}
                </>
              )}
            </span>
          )}
          {meta.tools.length > 0 && <span>Ferramentas: {meta.tools.join(', ')}</span>}
          {meta.scheduling && <span>Agendaria (simulado): {meta.scheduling}</span>}
          {meta.style && (
            <span>
              Paciente escreve: <b className="text-foreground">{meta.style === 'curto' ? 'curto e separado' : meta.style === 'longo' ? 'textos grandes' : 'equilibrado'}</b>
            </span>
          )}
          {meta.handoff && <span className="text-amber-600">Passaria para um humano</span>}
          <button
            type="button"
            onClick={redo}
            disabled={busy}
            className="ml-auto font-semibold text-primary hover:underline disabled:opacity-40 flex items-center gap-1"
          >
            <RefreshCw size={11} /> Responder de novo com a IA selecionada
          </button>
        </div>
      )}
      {error && <p className="px-4 pt-2 text-xs text-red-500">{error}</p>}

      <div className="p-3 border-t border-border flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          rows={Math.min(4, input.split('\n').length)}
          placeholder="Mensagem do paciente… (Shift+Enter = outra mensagem)"
          className="flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60"
        />
        <button
          type="button"
          onClick={send}
          disabled={busy || !input.trim()}
          aria-label="Enviar"
          className="px-3 rounded-xl bg-primary text-primary-foreground disabled:opacity-40 flex items-center justify-center"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}
