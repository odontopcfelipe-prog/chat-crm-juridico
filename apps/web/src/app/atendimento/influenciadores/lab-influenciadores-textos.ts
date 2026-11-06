/**
 * Paridade do laboratório — textos do LABORATÓRIO da tela Influenciadores (cadastro,
 * templates, agendamentos de WhatsApp e histórico).
 *
 * Só texto. A clínica não usa nada daqui: a tela escolhe pelo tipo de negócio da sessão
 * (`lab ? LAB_X.y : 'texto de hoje da clínica'`). Este arquivo só tem consts LAB_*:
 * fica sob as travas de scripts/ci/check-pick-literals.mjs.
 *
 * Envio agendado: no laboratório o agendamento nasce pausado e sai pelo WhatsApp da
 * própria conta (Comercial, senão Atendimento); a conta liga quando quiser.
 */
export const LAB_INFLUENCIADORES = Object.freeze({
  cadastrado: (nome: string) => `Influenciador cadastrado e vinculado ao cliente "${nome}" (afiliado)`,
  verFicha: 'Ver ficha do cliente',
  avisoTitulo: 'Influenciador também vira cliente do laboratório',
  avisoCriamos: 'Ao cadastrar, criamos automaticamente um',
  avisoCliente: 'Cliente',
  avisoComMesmo: 'com o mesmo nome/telefone/email, marcado como',
  avisoAfiliado: 'Afiliado ativo',
  avisoResto: '(3% por indicação fechada). O cupom configurado abaixo vira o',
  avisoCodigo: 'código de afiliado',
  avisoJaExiste: 'Se já existe cliente com o mesmo telefone, ele é vinculado (não duplica).',
  previewHandle: 'anaprotese',
  previewNicho: 'prótese',
  handleExemplo: 'ex: anaprotese',
  nichoExemplo: 'ex: prótese, odontologia, lifestyle, beleza',
  cupomDica: 'Útil para rastrear conversões. Único por laboratório.',
  agendamentoIntro:
    'Campanhas de envio automático pelo WhatsApp do laboratório. O agendamento nasce pausado: ative quando estiver pronto.',
});
