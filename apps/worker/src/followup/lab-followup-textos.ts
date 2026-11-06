/**
 * Laboratório de prótese — motivos que o worker grava quando a sequência de mensagens
 * (texto fixo) ou o comunicado do laboratório não envia. Arquivo só com consts LAB_*
 * (scripts/ci/check-pick-literals.mjs).
 */
export const LAB_FOLLOWUP_MOTIVOS = Object.freeze({
  sequenciaDesligada: 'Laboratório: sequência desligada ou de outra conta',
  semTextoFixo: 'Laboratório: passo sem texto fixo (a geração por IA não existe no laboratório)',
  naoRecebe: 'Laboratório: o contato pediu para não receber mensagens ou não tem WhatsApp',
  disparoDeOutraConta: 'Laboratório: comunicado só para contatos da própria conta',
  disparoSoComunicado: 'Laboratório: o disparo em massa é só o comunicado com texto fixo',
  contaSuspensa: 'Laboratório: conta suspensa, nada é enviado',
});

/** Nome que entra no lugar de {{nome}} quando o cadastro não tem nome. */
export const LAB_FOLLOWUP_NOME_PADRAO = 'cliente';
