'use client';

// Aviso na barra de envio do chat (nov/2026, pedido do dono): quando o chip por onde
// ESTA conversa responde está desconectado, sem conexão, com conexão baixa ou sem receber
// mensagens, uma linha acima da caixa de mensagem diz isso antes de a pessoa digitar. O
// chip segue a mesma regra do envio (chipDaConversa: Financeiro → Financeiro; cliente →
// Clínica; lead → Comercial). Sem internet neste computador, o chat já mostra a faixa
// vermelha dele (conexão com o sistema): aqui não repete.

import { AlertTriangle } from 'lucide-react';
import { LAB_PURPOSE_LABEL, chipDaConversa, pickBt } from '@crm/shared';
import { useBusinessType } from '@/lib/useBusinessType';
import { useSituacaoChips } from '@/lib/useSituacaoChips';
import { ROTULO_FUNCAO_CHIP, avisoNaConversa, nomeDoChipNaTela, type TomDoAviso } from './aviso-whatsapp-textos';

const COR: Record<TomDoAviso, string> = {
  vermelho: 'bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-300',
  amarelo: 'bg-amber-500/10 border-amber-500/30 text-amber-800 dark:text-amber-300',
};

export function AvisoChipNaConversa({ conversa }: { conversa: { inboxPurpose?: string | null; isClient?: boolean } }) {
  const bt = useBusinessType();
  const { chips, online } = useSituacaoChips();
  const rotulos: Readonly<Record<string, string>> = pickBt(bt, ROTULO_FUNCAO_CHIP, LAB_PURPOSE_LABEL);

  if (!online) return null;
  const chip = chipDaConversa(chips, conversa);
  const aviso = chip ? avisoNaConversa(chip, nomeDoChipNaTela(chip, rotulos)) : null;
  if (!aviso) return null;

  return (
    <div
      role="status"
      className={`max-w-4xl mx-auto mb-1.5 flex items-center gap-2 px-3 py-2 rounded-xl border text-[12px] font-medium ${COR[aviso.tom]}`}
    >
      <AlertTriangle size={14} className="shrink-0" />
      <span>{aviso.texto}</span>
    </div>
  );
}
