/**
 * Paridade do laboratório — textos do LABORATÓRIO nas telas de comissão, regras de
 * comissão, metas, Modo jogo (visão do administrador) e Pontuação do protético.
 * Só texto: a clínica não usa nada daqui, quem usa escolhe pelo tipo de negócio da
 * sessão (`lab ? LAB_X.y : 'texto de hoje da clínica'`). Este arquivo só tem consts
 * LAB_* (scripts/ci/check-pick-literals.mjs).
 *
 * O protético vê pontos, nível e metas; valores em reais de comissão só aparecem para
 * quem administra (Comissões, Modo jogo e Regras de comissão).
 */

/** Tela Comissões (administrador e financeiro). */
export const LAB_COMISSOES = Object.freeze({
  subtitulo:
    'Comissões geradas pela execução de serviços. Fluxo: DEVIDA → DISPONIVEL (cliente paga) → PAGA (laboratório liquida).',
});

/** Regras de comissão (Configurações). */
export const LAB_COMISSAO_REGRAS = Object.freeze({
  subtitulo:
    'Define como cada profissional ganha comissão por serviço executado. Prioridade: regra por serviço > por grupo > sem escopo (geral).',
  servicoEspecifico: 'Serviço específico',
  grupo: 'Grupo: ',
  quandoClientePaga: 'Quando o cliente paga',
  naExecucao: 'Na execução',
  escopoGrupo: 'Por grupo',
  escopoServico: 'Serviço',
  grupoDoServico: 'Grupo do serviço',
  grupoExemplo: 'PROTESE, ESTETICA...',
  servico: 'Serviço específico',
  quandoLibera: 'Quando libera comissão',
  opcaoClientePaga: 'Quando o cliente paga (recomendado)',
  opcaoExecucao: 'Na execução do serviço',
  dicaClientePaga: 'Alinha o incentivo do profissional à saúde financeira do laboratório.',
  dicaExecucao: 'Comissão gerada imediatamente — use quando houver confiança total no recebimento.',
});

/** Metas. */
export const LAB_METAS = Object.freeze({
  subtitulo: 'Metas com projeção "no ritmo atual" — vendas, novos clientes e conversão de orçamento.',
  novosClientes: 'Novos clientes',
  conversao: 'Conversão de orçamento (%)',
  doLaboratorio: 'Laboratório · ',
  escopoLaboratorio: 'Laboratório (todos)',
});

/** Modo jogo do administrador. */
export const LAB_MODO_JOGO = Object.freeze({
  semEquipe: 'Nenhum protético cadastrado neste laboratório ainda. Cadastre a equipe e crie as regras em',
  prodAguardando: 'Serviços feitos, aguardando o cliente pagar.',
  clientePagou: 'Cliente já pagou — é do profissional.',
  liquidado: 'Já liquidado pelo laboratório.',
  missoesRodape:
    'Progresso real (serviços executados na semana). A recompensa é um bônus — o pagamento fica a critério do laboratório.',
});

/** Pontuação do protético (Meu jogo). */
export const LAB_MEU_JOGO = Object.freeze({
  semMetas: 'Nenhuma meta sua neste mês ainda. Quando o laboratório lançar, ela aparece aqui.',
});
