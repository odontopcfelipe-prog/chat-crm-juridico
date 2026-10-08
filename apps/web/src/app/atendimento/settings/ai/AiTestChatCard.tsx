'use client';

import { useEffect, useRef, useState } from 'react';
import { MessageCircle, Send, RotateCcw } from 'lucide-react';
import api from '@/lib/api';

type Msg = { from: 'patient' | 'ai'; text: string };
type Meta = { skill: string | null; model: string; tools: string[]; handoff: boolean; scheduling: string | null };

const CHIPS = [
  { id: 'COMERCIAL', label: 'Comercial (lead novo)' },
  { id: 'CLINICA', label: 'Clínica' },
] as const;

/**
 * Chat de teste da Sophia. Usa o mesmo cérebro do WhatsApp (skills do chip, guia
 * de conversa, valores e horários reais da agenda), mas NADA é enviado nem gravado:
 * agendamento e mudança de etapa são só simulados.
 */
export function AiTestChatCard() {
  const [chip, setChip] = useState<'COMERCIAL' | 'CLINICA'>('COMERCIAL');
  const [isClient, setIsClient] = useState(false);
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

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const history: Msg[] = [...msgs, { from: 'patient', text }];
    setMsgs(history);
    setInput('');
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post(
        '/settings/ai-test-chat',
        { purpose: chip, isClient, history },
        { timeout: 100_000 },
      );
      const bubbles: string[] = Array.isArray(data?.bubbles) ? data.bubbles : [];
      setMsgs([...history, ...bubbles.map((b) => ({ from: 'ai' as const, text: b }))]);
      setMeta({
        skill: data?.skill || null,
        model: data?.model || '',
        tools: data?.tools || [],
        handoff: !!data?.handoff,
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
            <h4 className="text-sm font-bold text-foreground">Testar a Sophia</h4>
            <p className="text-[11px] text-muted-foreground mt-0.5 max-w-lg">
              Converse como se fosse um paciente. É a mesma IA do WhatsApp, mas nada é enviado nem gravado.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={chip}
            onChange={(e) => { setChip(e.target.value as any); reset(); }}
            className="text-xs rounded-lg border border-border bg-background px-2 py-1.5 text-foreground"
          >
            {CHIPS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
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
            Escreva como um paciente escreveria. Ex.: &quot;Boa tarde, quanto fica a limpeza?&quot;
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
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-md bg-card border border-border px-3.5 py-2 text-xs text-muted-foreground">
              Sophia está digitando…
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {meta && (
        <div className="px-4 py-2 border-t border-border text-[11px] text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
          <span>Skill: <b className="text-foreground">{meta.skill || 'nenhuma'}</b></span>
          <span>Modelo: <b className="text-foreground">{meta.model}</b></span>
          {meta.tools.length > 0 && <span>Ferramentas: {meta.tools.join(', ')}</span>}
          {meta.scheduling && <span>Agendaria (simulado): {meta.scheduling}</span>}
          {meta.handoff && <span className="text-amber-600">Passaria para um humano</span>}
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
          rows={1}
          placeholder="Mensagem do paciente…"
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
