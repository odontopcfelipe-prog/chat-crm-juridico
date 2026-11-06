/**
 * Paridade do laboratório — textos do "Meu jogo" (pontos, metas e missões do protético)
 * e da visão do administrador (Modo jogo). Só texto: a clínica não usa nada daqui, quem
 * usa escolhe pelo tipo da conta (`lab ? LAB_X.y : 'texto de hoje da clínica'`). Este
 * arquivo só tem consts LAB_* (scripts/ci/check-pick-literals.mjs).
 *
 * Nada em reais sai do "Meu jogo": o protético vê pontos, nível, metas em % e missões.
 */
import type { MissionsConfig } from './game-rules';

/** Origem dos pontos do mês (mesmas chaves da clínica; "atendimento confirmado" não existe no laboratório). */
export const LAB_JOGO_FONTES = Object.freeze({
  procedimentos: Object.freeze({ emoji: '🦷', label: 'Serviços executados' }),
  avaliacoes: Object.freeze({ emoji: '📋', label: 'Orçamentos montados' }),
  conversoes: Object.freeze({ emoji: '🤝', label: 'Orçamentos que viraram trabalho' }),
  missoes: Object.freeze({ emoji: '🎯', label: 'Missões da semana cumpridas' }),
});

/** Rótulo de cada tipo de meta que o protético vê (só os que existem no laboratório). */
export const LAB_JOGO_METAS = Object.freeze({
  SALES_VALUE: 'Produção do mês',
  NEW_PATIENTS: 'Clientes novos',
  CONVERSIONS: 'Orçamentos que viraram trabalho',
  padrao: 'Meta do laboratório',
});

/** Selos do mês. */
export const LAB_JOGO_CONQUISTAS = Object.freeze({
  primeiro: 'Primeiro serviço do mês',
  dez: '10 serviços',
  cinquenta: '50 serviços',
  conversao: 'Orçamento que virou trabalho',
  meta: 'Meta batida',
  ouro: 'Nível Ouro',
});

/**
 * Missões sugeridas enquanto a conta não definir as dela: só a de serviços executados
 * (não há falta de consulta para contar). A recompensa em texto é só da visão do administrador.
 */
export const LAB_DEFAULT_MISSIONS: MissionsConfig = {
  enabled: true,
  missions: [{ id: 'proc', titulo: 'Execute 5 serviços', metrica: 'procedimentos', alvo: 5, recompensa: '+R$ 100' }],
};

/** Modo jogo do administrador (visão da equipe): o que a regra do protético diz quando é por serviço. */
export const LAB_JOGO_ADMIN = Object.freeze({
  faixaPorServico: 'Comissão por serviço',
});

/** Comissão, regra de comissão e meta: id informado que não é da conta do laboratório. */
export const LAB_COMISSAO_IDS = Object.freeze({
  profissional: 'Protético não encontrado neste laboratório.',
  servico: 'Serviço não encontrado neste laboratório.',
  itemDeTrabalho: 'Item de trabalho não encontrado neste laboratório.',
  orcamento: 'Orçamento não encontrado neste laboratório.',
});
