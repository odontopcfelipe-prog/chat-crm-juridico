/**
 * Textos do aviso de WhatsApp na tela (topo de toda página e barra de envio do chat).
 * Vocabulário neutro ("contato", "mensagens"): vale para a clínica e para o laboratório.
 * O nome da função do chip vem de fora (pickBt no componente).
 */
import type { SituacaoDoChip } from '@crm/shared';

/** Nome da função do chip na clínica. */
export const ROTULO_FUNCAO_CHIP: Readonly<Record<string, string>> = {
  CLINICA: 'Clínica',
  COMERCIAL: 'Comercial',
  FINANCEIRO: 'Financeiro',
};

/** (82) 9927-3423 a partir de 558299273423. Vazio se não souber. */
export function numeroLegivel(numero: string | null | undefined): string {
  let d = String(numero || '').replace(/\D/g, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return '';
  const resto = d.slice(2);
  return `(${d.slice(0, 2)}) ${resto.slice(0, resto.length - 4)}-${resto.slice(-4)}`;
}

/** "Clínica (82) 9927-3423" (vai depois de "WhatsApp", sem artigo). */
export function nomeDoChipNaTela(chip: SituacaoDoChip, rotulos: Readonly<Record<string, string>>): string {
  const funcao = (chip.purpose && rotulos[chip.purpose]) || '';
  const numero = numeroLegivel(chip.numero);
  return [funcao, numero].filter(Boolean).join(' ') || chip.instanceName;
}

function hora(t: number | null): string {
  if (!t) return '';
  return new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Maceio' });
}

export type TomDoAviso = 'vermelho' | 'amarelo';

export interface AvisoDoTopo {
  titulo: string;
  detalhe: string;
  tom: TomDoAviso;
  /** Mostra o botão que leva à tela de conexão do WhatsApp. */
  reconectar: boolean;
}

/** Aviso no topo da página para um chip com problema (null = chip bem). */
export function avisoDoTopo(chip: SituacaoDoChip, nome: string): AvisoDoTopo | null {
  switch (chip.situacao) {
    case 'desconectado':
      return {
        titulo: `WhatsApp ${nome} desconectado`,
        detalhe: 'As mensagens não chegam ao sistema e os envios por ele falham.',
        tom: 'vermelho',
        reconectar: true,
      };
    case 'reconectando':
      return {
        titulo: `WhatsApp ${nome} sem conexão`,
        detalhe: 'Tentando reconectar. As mensagens podem atrasar.',
        tom: 'amarelo',
        reconectar: true,
      };
    case 'instavel':
      return {
        titulo: `Conexão baixa no WhatsApp ${nome}`,
        detalhe: 'O chip está caindo e voltando. Confira se o celular dele está com internet e com o WhatsApp aberto.',
        tom: 'amarelo',
        reconectar: false,
      };
    case 'sem_receber':
      return {
        titulo: `WhatsApp ${nome} sem receber mensagens`,
        detalhe: `Nada chega${chip.desde ? ` desde as ${hora(chip.desde)}` : ''}. Confira no celular do chip se as mensagens estão chegando lá.`,
        tom: 'amarelo',
        reconectar: false,
      };
    default:
      return null;
  }
}

export const SEM_INTERNET_TOPO: AvisoDoTopo = {
  titulo: 'Sem conexão com a internet',
  detalhe: 'Confira a internet deste computador. As mensagens só saem quando a conexão voltar.',
  tom: 'vermelho',
  reconectar: false,
};

/** Aviso curto acima da caixa de mensagem, para o chip por onde a conversa envia. */
export function avisoNaConversa(chip: SituacaoDoChip, nome: string): { texto: string; tom: TomDoAviso } | null {
  switch (chip.situacao) {
    case 'desconectado':
      return { texto: `O WhatsApp ${nome} está desconectado: a mensagem não vai sair agora.`, tom: 'vermelho' };
    case 'reconectando':
      return { texto: `O WhatsApp ${nome} está sem conexão, tentando reconectar: a mensagem pode atrasar.`, tom: 'amarelo' };
    case 'instavel':
      return { texto: `Conexão baixa no WhatsApp ${nome}: a mensagem pode atrasar.`, tom: 'amarelo' };
    case 'sem_receber':
      return {
        texto: `O WhatsApp ${nome} não recebe mensagens${chip.desde ? ` desde as ${hora(chip.desde)}` : ''}: a resposta do contato pode não aparecer aqui.`,
        tom: 'amarelo',
      };
    default:
      return null;
  }
}

