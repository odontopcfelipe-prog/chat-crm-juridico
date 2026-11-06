/**
 * Laboratório de prótese — mensagens da campanha manual (API e motor de envio).
 *
 * A campanha é a mesma da clínica: o público são os clientes do laboratório (dentistas e
 * clínicas), a mensagem sai pelo WhatsApp da própria conta e só depois do "Iniciar".
 * Arquivo só com consts LAB_* (scripts/ci/check-pick-literals.mjs).
 */
export const LAB_CAMPANHAS_ERROS = Object.freeze({
  semChipTeste: 'Este setor não tem chip de WhatsApp conectado neste laboratório',
  semChipIniciar: 'Este setor não tem chip de WhatsApp conectado neste laboratório — conecte antes de iniciar',
  /** `{n}` = quantos clientes recebem; `{max}` = o máximo por campanha. */
  acimaDoLimite: 'São {n} clientes — o máximo por campanha é {max}. Refine os filtros.',
});

export const LAB_CAMPANHAS_MOTIVOS = Object.freeze({
  clienteArquivado: 'cliente arquivado/removido',
  semChipAtendimento: 'Sem chip do Atendimento conectado — conecte e clique em Retomar',
  semChipComercial: 'Sem chip Comercial conectado — conecte e clique em Retomar',
  semChipFinanceiro: 'Sem chip Financeiro conectado — conecte e clique em Retomar',
  contaSuspensa: 'Conta suspensa: o envio parou. Quando a conta voltar a ficar ativa, clique em Retomar',
});

/** Nome que entra em {clinica} quando a conta não tem nome. */
export const LAB_CAMPANHAS_NOME_PADRAO = 'o laboratório';

/** Nome que entra em {nome} e {nome_completo} na mensagem de teste. */
export const LAB_CAMPANHAS_CONTATO_TESTE = 'Contato de teste';
