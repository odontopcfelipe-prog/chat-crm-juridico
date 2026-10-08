'use client';

import { useEffect, useState } from 'react';
import { UserRound, CheckCircle2 } from 'lucide-react';
import api from '@/lib/api';
import {
  AI_REPLY_LENGTHS,
  apiErrorMessage,
  normalizeAiChipProfile,
  REPLY_LENGTH_LABELS,
  type AiChipProfile,
  type AiChipPurpose,
  type AiReplyLength,
} from './clinic-hours';

const CHIP_LABEL: Record<AiChipPurpose, string> = {
  COMERCIAL: 'Comercial',
  CLINICA: 'Clínica',
  FINANCEIRO: 'Financeiro',
};

const INSTRUCTIONS_PLACEHOLDER: Record<AiChipPurpose, string> = {
  COMERCIAL: 'Ex.: Sempre convide para a consulta de avaliação e ofereça os horários livres.',
  CLINICA: 'Ex.: Para quem já está em tratamento, confirme a próxima consulta e lembre dos cuidados.',
  FINANCEIRO: 'Ex.: No financeiro, seja objetiva e sempre mande o link do boleto.',
};

const REPLY_LENGTH_HELP: Record<AiReplyLength, string> = {
  auto: 'Espelha o paciente: se ele manda mensagens curtas, ela responde curto; se ele escreve textão, ela explica mais.',
  curta: 'Sempre direto ao ponto: uma ou duas frases por mensagem.',
  media: 'Equilibrado: explica o necessário, sem se alongar.',
  longa: 'Respostas mais completas e explicadas, boas pra dúvidas sobre tratamento.',
};

type Props = {
  purpose: AiChipPurpose;
  /** Perfil salvo deste chip (GET /settings/ai-profile → chips[purpose]). null = não carregou. */
  profile: (AiChipProfile & { enabled?: boolean }) | null | undefined;
  /** Tempo de resposta padrão da clínica (segundos), usado quando o chip não define o próprio. */
  defaultCooldown: number;
  onSaved?: () => void;
};

/**
 * Perfil da IA de UM chip desta clínica: nome da assistente, assinatura, tamanho
 * das respostas, tempo de resposta e instruções extras. Fica no topo da gaveta do chip.
 */
export function AiChipProfileEditor({ purpose, profile, defaultCooldown, onSaved }: Props) {
  const [p, setP] = useState<AiChipProfile>(() => normalizeAiChipProfile(profile));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Recarregou do servidor (ex.: depois de salvar) → a tela volta pro que está gravado.
  const profileKey = JSON.stringify(profile ? normalizeAiChipProfile(profile) : null);
  useEffect(() => {
    setP(normalizeAiChipProfile(profile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileKey]);

  if (!profile) {
    return (
      <div className="px-4 py-3 border-b border-border/60 text-[11px] text-muted-foreground italic">
        Não consegui carregar o perfil da IA deste chip. Recarregue a página.
      </div>
    );
  }

  const label = CHIP_LABEL[purpose];
  const name = p.assistantName.replace(/\s+/g, ' ').trim() || 'Sophia';
  const ownDelay = p.responseDelaySec !== null;
  const dirty = JSON.stringify(normalizeAiChipProfile(p)) !== profileKey;
  const set = (patch: Partial<AiChipProfile>) => setP((s) => ({ ...s, ...patch }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { data } = await api.put(`/settings/ai-profile/chip/${purpose}`, normalizeAiChipProfile(p));
      setP(normalizeAiChipProfile(data));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      onSaved?.();
    } catch (e) {
      setError(apiErrorMessage(e, 'Não consegui salvar.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="px-4 py-4 border-b border-border/60 bg-card/60 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <UserRound size={14} />
          </div>
          <div>
            <h5 className="text-sm font-bold text-foreground">Perfil da IA neste chip</h5>
            <p className="text-[11px] text-muted-foreground">Só vale para o chip {label} desta clínica.</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Nome + assinatura */}
        <div className="space-y-3">
          <label className="flex flex-col gap-1 max-w-sm">
            <span className="text-[11px] font-semibold text-muted-foreground">Nome da assistente</span>
            <input
              value={p.assistantName}
              onChange={(e) => set({ assistantName: e.target.value })}
              maxLength={40}
              placeholder="Sophia"
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/60"
            />
          </label>

          <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
            <button
              type="button"
              role="switch"
              aria-checked={p.signature}
              onClick={() => set({ signature: !p.signature })}
              className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${p.signature ? 'bg-primary' : 'bg-muted-foreground/30'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${p.signature ? 'translate-x-5' : ''}`} />
            </button>
            <span className="text-xs font-semibold text-foreground">Assinar as mensagens</span>
          </label>
          <div>
            <p className="text-[11px] text-muted-foreground mb-1">O paciente vê assim no WhatsApp:</p>
            <div className="inline-block max-w-full rounded-2xl rounded-tl-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-sm text-foreground break-words">
              {p.signature && <b>{name}:</b>} Bom dia! Como posso te ajudar?
            </div>
          </div>
        </div>

        {/* Tamanho + tempo de resposta */}
        <div className="space-y-4">
          <div className="space-y-1.5">
            <span className="text-[11px] font-semibold text-muted-foreground block">Tamanho das respostas</span>
            <div className="inline-flex flex-wrap rounded-xl border border-border p-0.5 text-xs font-semibold">
              {AI_REPLY_LENGTHS.map((len) => (
                <button
                  key={len}
                  type="button"
                  onClick={() => set({ replyLength: len })}
                  className={`px-3 py-1.5 rounded-lg transition-colors ${p.replyLength === len ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {len === 'auto' ? 'Automático (espelha o paciente)' : REPLY_LENGTH_LABELS[len]}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">{REPLY_LENGTH_HELP[p.replyLength]}</p>
          </div>

          <div className="space-y-1.5">
            <span className="text-[11px] font-semibold text-muted-foreground block">Tempo de resposta</span>
            <div className="inline-flex flex-wrap rounded-xl border border-border p-0.5 text-xs font-semibold">
              <button
                type="button"
                onClick={() => set({ responseDelaySec: null })}
                className={`px-3 py-1.5 rounded-lg transition-colors ${!ownDelay ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                Usar o padrão ({defaultCooldown}s)
              </button>
              <button
                type="button"
                onClick={() => { if (!ownDelay) set({ responseDelaySec: defaultCooldown }); }}
                className={`px-3 py-1.5 rounded-lg transition-colors ${ownDelay ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                Tempo só deste chip
              </button>
            </div>
            {ownDelay && (
              <div className="space-y-1 max-w-sm">
                <div className="text-xs font-semibold text-foreground">
                  {p.responseDelaySec === 0 ? 'Responde na hora' : `Espera ${p.responseDelaySec}s`}
                </div>
                <input
                  type="range" min={0} max={60} step={1}
                  value={p.responseDelaySec ?? 0}
                  onChange={(e) => set({ responseDelaySec: Number(e.target.value) })}
                  aria-label="Tempo de resposta deste chip, em segundos"
                  className="w-full accent-primary"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>0s</span><span>60s</span>
                </div>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              Quanto tempo a IA espera o paciente terminar de escrever antes de responder. Assim ela lê tudo de uma vez
              em vez de responder cada mensagem.
            </p>
          </div>
        </div>
      </div>

      {/* Instruções deste chip */}
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold text-muted-foreground">Instruções deste chip</span>
        <textarea
          value={p.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
          rows={3}
          maxLength={2000}
          placeholder={INSTRUCTIONS_PLACEHOLDER[purpose]}
          className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary/60 resize-y"
        />
        <span className="text-[10px] text-muted-foreground self-end">{p.instructions.length}/2000</span>
      </label>

      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {dirty && !saving && !saved && (
          <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">Alterações não salvas</span>
        )}
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
        >
          {saved ? <><CheckCircle2 size={15} /> Salvo</> : saving ? 'Salvando...' : 'Salvar perfil'}
        </button>
      </div>
    </div>
  );
}
