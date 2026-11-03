/**
 * F11 do laboratório — textos do cadastro de laboratório pelo /cadastrar e dos
 * convites do SUPER_ADMIN. Só const LAB_ (regras de scripts/ci/check-pick-literals.mjs):
 * qualquer outra string aqui contaria como texto de clínica. Os services e os
 * controllers importam daqui e nunca declaram const LAB_.
 */

export const LAB_CADASTRO_MSG = Object.freeze({
  nomeLab: 'Informe o nome do laboratório',
  nomeResponsavel: 'Informe o seu nome',
  email: 'Informe um e-mail válido',
  senha: 'A senha precisa ter pelo menos 8 caracteres',
  documento: 'Informe o CNPJ ou o CPF do laboratório',
  whatsapp: 'Informe um WhatsApp com DDD',
  convite: 'Código do convite inválido',
  fechado: 'O cadastro de laboratório de prótese ainda não está aberto. Entre na lista de espera.',
  conviteInvalido: 'Convite inválido, vencido ou já usado. Peça um novo convite.',
  teto: 'Muitos cadastros de laboratório hoje. Tente de novo amanhã ou entre na lista de espera.',
});

export const LAB_CONVITE_MSG = Object.freeze({
  aberto: 'Informe aberto: true ou false',
  inscricaoInvalida: 'Inscrição da lista de espera inválida',
  inscricaoNaoEncontrada: 'Inscrição da lista de espera não encontrada',
  inscricaoJaVirouConta: 'Esta inscrição já usou um convite: a conta do laboratório já existe.',
  emailInvalido: 'E-mail inválido',
  validade: 'Validade do convite: de 1 a 60 dias',
  conviteNaoEncontrado: 'Convite não encontrado',
  conviteJaUsado: 'Este convite já foi usado: a conta do laboratório já existe.',
  semMensalidade:
    'Antes de abrir o cadastro, configure a conta Asaas da mensalidade dos laboratórios em Configurações da Plataforma.',
});
