/**
 * F11 do laboratório — textos do LABORATÓRIO no /cadastrar quando o cadastro do
 * laboratório está liberado (convite válido ou cadastro aberto): faixa, lateral,
 * cabeçalho do cartão, formulário, avisos e erros.
 *
 * Só texto. A clínica não usa nada daqui, e a lista de espera de hoje continua
 * com os textos dela no CadastroPage.tsx. Este arquivo só tem consts LAB_*: fica
 * sob as travas de scripts/ci/check-pick-literals.mjs, e nenhum texto fora delas
 * pode entrar aqui (chave de objeto vai sem aspas).
 */

/** Como o cadastro do laboratório está liberado nesta visita. */
export type ModoLiberado = 'CONVITE' | 'ABERTO';

/** Lateral, faixa e cabeçalho do cartão. */
export const LAB_CADASTRO_TOPO = Object.freeze({
  selo: Object.freeze<Record<ModoLiberado, string>>({
    CONVITE: 'Convite · acesso antecipado',
    ABERTO: 'Cadastro aberto · laboratório de prótese',
  }),
  tituloLateral: 'Seu laboratório online,',
  tituloLateralDestaque: 'a partir de hoje.',
  descricaoLateral:
    'Dentistas clientes, trabalhos, WhatsApp e cobrança — o mesmo sistema das clínicas, feito para o laboratório de prótese.',
  titulo: 'Laboratório de prótese',
  subtitulo: Object.freeze<Record<ModoLiberado, string>>({
    CONVITE: 'Você recebeu um convite. Crie a conta do seu laboratório e comece a usar agora.',
    ABERTO: 'Crie a conta do seu laboratório. Leva poucos minutos.',
  }),
  conferindo: 'Conferindo o convite...',
  conviteRecusado:
    'Este link de convite não está valendo agora: ele pode ter sido usado, vencido ou cancelado. Deixe seu contato abaixo que falamos com você.',
  conviteErro: 'Não foi possível conferir o convite agora. Recarregue a página em instantes.',
});

/** Formulário de cadastro do laboratório. */
export const LAB_CADASTRO_FORM = Object.freeze({
  secaoLaboratorio: 'Seu laboratório',
  nome: 'Nome do laboratório *',
  nomeExemplo: 'Laboratório de Prótese Sorriso',
  documento: 'CNPJ ou CPF *',
  documentoExemplo: '00.000.000/0000-00',
  documentoDica: 'O CNPJ aceita letras nas 12 primeiras posições (CNPJ alfanumérico).',
  whatsapp: 'WhatsApp *',
  whatsappExemplo: '(82) 99999-9999',
  secaoRt: 'Responsável técnico (opcional)',
  croLab: 'Inscrição do laboratório no CRO',
  rtNome: 'Nome do responsável técnico',
  rtCro: 'CRO do responsável técnico',
  rtDica: 'Aparecem no rodapé dos documentos do laboratório.',
  secaoAcesso: 'Seu acesso',
  responsavel: 'Nome do responsável *',
  responsavelExemplo: 'Fulano de Tal',
  email: 'E-mail *',
  emailExemplo: 'seu@email.com',
  emailDoConvite: 'Veio do convite. Pode trocar se preferir.',
  senha: 'Senha * (mínimo 8 caracteres)',
  senhaExemplo: '••••••••',
  aceiteAntes: 'Aceito os',
  aceiteTermos: 'termos de uso',
  aceiteMeio: 'e a',
  aceitePrivacidade: 'política de privacidade',
  aceiteFim: '.',
  site: 'Site',
  botao: 'Criar a conta do laboratório',
  criando: 'Criando a conta do laboratório...',
  rodape: 'Depois do cadastro você já entra no sistema',
});

/** Erros e avisos do envio. */
export const LAB_CADASTRO_ERROS = Object.freeze({
  aceite: 'Aceite os termos para continuar',
  documento: 'Informe o CNPJ ou o CPF do laboratório',
  whatsapp: 'Informe o WhatsApp com DDD',
  senhaCurta: 'A senha precisa ter pelo menos 8 caracteres',
  conviteRecusado: 'Este convite não está mais valendo. Confira o link ou peça um novo.',
  cadastroFechado: 'O cadastro de laboratório não está aberto agora. Deixe seu contato na lista de espera.',
  tetoDiario: 'Muitos cadastros hoje. Tente de novo amanhã.',
  muitasTentativas: 'Muitas tentativas. Espere um minuto e tente de novo.',
  generico: 'Não foi possível concluir o cadastro agora. Tente de novo.',
  contaCriadaSemEntrar: 'Conta criada. Entre com o seu e-mail e a sua senha.',
});

/** Aviso depois do cadastro e do login. */
export const LAB_CADASTRO_BOAS_VINDAS = (nome: string) =>
  `Bem-vindo(a) ao ${nome}! A conta do laboratório está pronta.`;
