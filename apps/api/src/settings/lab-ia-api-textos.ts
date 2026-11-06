/**
 * Textos da IA do laboratório na API: recusa por assinatura, correção de texto e
 * transcrição. Regras do arquivo (scripts/ci/check-pick-literals.mjs): só consts LAB_.
 */

/** Conta fora de ACTIVE: a IA, a transcrição e a correção usam a chave compartilhada. */
export const LAB_IA_API = Object.freeze({
  codigoSemAssinatura: 'LAB_IA_SEM_ASSINATURA',
  semAssinatura: 'A IA libera com a assinatura do laboratório. Assine em Assinatura para usar.',
  chipDesligado: 'A IA deste canal está desligada. Ligue em Ajustes de IA para usar nesta conversa.',
  conversaNaoEncontrada: 'Conversa não encontrada neste laboratório.',
  limiteTeste: 'Limite de 30 testes da IA por hora atingido neste laboratório. Tente de novo mais tarde.',
  limiteCorrecao: 'Limite de 120 correções de texto por hora atingido neste laboratório. Tente de novo mais tarde.',
  limiteTranscricao: 'Limite de 120 transcrições de áudio por hora atingido neste laboratório. Tente de novo mais tarde.',
  textoLongoParaCorrigir: 'A correção aceita texto de até 4.000 caracteres.',
});

/** Correção de texto: só o que muda em relação às ações neutras. */
export const LAB_IA_CORRECAO = Object.freeze({
  profissional:
    'Reescreva o texto a seguir de forma profissional, adequada para a comunicação de um laboratório de prótese com dentistas e consultórios. Retorne apenas o texto reescrito, sem nenhuma explicação.',
});

export const LAB_IA_TRANSCRICAO =
  'Transcrição de mensagem de voz do WhatsApp em português brasileiro. Um dentista ou consultório conversa com um laboratório de prótese dentária sobre trabalhos, materiais, cores e prazos.';
