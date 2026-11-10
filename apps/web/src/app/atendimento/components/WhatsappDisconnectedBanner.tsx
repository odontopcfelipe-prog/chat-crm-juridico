'use client';

// Aviso GLOBAL de WhatsApp com problema, no topo de todas as telas do /atendimento
// (Início, chat, tudo do adm). Nov/2026 — além de "desconectado", mostra "sem conexão"
// (reconectando), "conexão baixa" (chip caindo e voltando) e "sem receber mensagens",
// que vêm da vigia do worker, e "sem conexão com a internet" deste computador.
// Fonte: GET /whatsapp/situacao-chips (todo logado da conta lê), a cada 60 s, pelo
// useSituacaoChips (a mesma consulta do aviso na barra de envio do chat). Some sozinho
// quando normaliza. Servidor sem resposta não vira alarme.

import { AlertTriangle, WifiOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { LAB_PURPOSE_LABEL, pickBt } from '@crm/shared';
import { useBusinessType } from '@/lib/useBusinessType';
import { useSituacaoChips } from '@/lib/useSituacaoChips';
import {
  ROTULO_FUNCAO_CHIP,
  SEM_INTERNET_TOPO,
  avisoDoTopo,
  nomeDoChipNaTela,
  type AvisoDoTopo,
} from './aviso-whatsapp-textos';

const COR: Record<AvisoDoTopo['tom'], string> = {
  vermelho: 'bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400',
  amarelo: 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400',
};

const BOTAO: Record<AvisoDoTopo['tom'], string> = {
  vermelho: 'bg-red-500/15 hover:bg-red-500/25',
  amarelo: 'bg-amber-500/15 hover:bg-amber-500/25',
};

export function WhatsappDisconnectedBanner() {
  const router = useRouter();
  const bt = useBusinessType();
  const { chips, online } = useSituacaoChips();
  const rotulos: Readonly<Record<string, string>> = pickBt(bt, ROTULO_FUNCAO_CHIP, LAB_PURPOSE_LABEL);

  const avisos: Array<{ chave: string; aviso: AvisoDoTopo }> = [];
  if (!online) avisos.push({ chave: 'internet', aviso: SEM_INTERNET_TOPO });
  else {
    for (const chip of chips) {
      const aviso = avisoDoTopo(chip, nomeDoChipNaTela(chip, rotulos));
      if (aviso) avisos.push({ chave: chip.instanceName, aviso });
    }
  }
  if (avisos.length === 0) return null;

  return (
    <div className="shrink-0" role="status" aria-live="polite">
      {avisos.map(({ chave, aviso }) => (
        <div key={chave} className={`border-b px-4 py-2 flex items-center gap-2 text-sm ${COR[aviso.tom]}`}>
          {online ? (
            <AlertTriangle size={16} className={`shrink-0 ${aviso.tom === 'vermelho' ? 'animate-pulse' : ''}`} />
          ) : (
            <WifiOff size={16} className="shrink-0" />
          )}
          <span className="font-semibold shrink-0">{aviso.titulo}.</span>
          <span className="hidden sm:inline opacity-80 truncate">{aviso.detalhe}</span>
          {aviso.reconectar && (
            <button
              type="button"
              onClick={() => router.push('/atendimento/settings/whatsapp')}
              className={`ml-auto shrink-0 text-xs font-bold px-2.5 py-1 rounded-lg transition-colors ${BOTAO[aviso.tom]}`}
            >
              Reconectar
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
