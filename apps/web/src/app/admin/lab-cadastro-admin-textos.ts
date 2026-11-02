/**
 * F11 do laboratório — textos das telas do SUPER_ADMIN para o cadastro de laboratório:
 * os convites (em /admin/lista-espera) e a chave "Cadastro aberto ao público"
 * (em /admin/tenants, logo abaixo da "Criação de laboratório" da F3).
 *
 * Só texto. Os componentes (ConvitesLaboratorio.tsx, CadastroAbertoLaboratorio.tsx e as
 * duas páginas) importam daqui e não declaram const LAB_*. Este arquivo só tem consts
 * LAB_*: fica sob as travas de scripts/ci/check-pick-literals.mjs, e nenhum texto fora
 * delas pode entrar aqui.
 *
 * O código do convite nunca entra em texto daqui: só o link, e só no passo 2 do modal.
 */

/** Convites de cadastro de laboratório (lista de espera e seção "Convites"). */
export const LAB_CONVITES_ADMIN = Object.freeze({
  subtitulo:
    'Quem escolheu "Laboratório de prótese" no /cadastrar. Para liberar o cadastro de um laboratório, mande um convite: o link vale para uma conta só.',

  /** Ações de cada inscrição da lista de espera. */
  inscricao: Object.freeze({
    convidar: 'Convidar',
    convidarDeNovo: 'Convidar de novo',
    seloConvidado: (d: string) => `Convidado · vale até ${d}`,
    seloContaCriada: 'Conta criada',
    verConta: 'Ver conta',
    removerComConvite: (n: string) =>
      `Remover "${n}" da lista de espera?\n\nO convite já mandado continua valendo até vencer ou ser revogado na lista de convites.`,
  }),

  /** Modal: passo 1 (formulário) e passo 2 (link mostrado uma vez). */
  modal: Object.freeze({
    tituloInscricao: (n: string) => `Convidar ${n}`,
    tituloAvulso: 'Novo convite',
    nome: 'Nome do laboratório (opcional)',
    exemploNome: 'Ex.: Laboratório de Prótese Sorriso',
    email: 'E-mail (opcional)',
    exemploEmail: 'contato@laboratorio.com.br',
    ajuda:
      'Os dois só chegam preenchidos no cadastro; o laboratório pode trocar. O convite vale por 14 dias e para uma conta só.',
    substitui: 'Este laboratório já tem um convite válido. O novo substitui o anterior, que para de funcionar.',
    mestraDesligada:
      'A "Criação de laboratório" está desligada: o convite só funciona depois que ela for ligada em Admin SaaS → Tenants.',
    cancelar: 'Cancelar',
    criar: 'Criar convite',
    inscricaoSumiu: 'Inscrição não encontrada — ela pode ter sido removida da lista.',
    erroCriar: 'Não foi possível criar o convite',
    criadoTitulo: 'Convite criado',
    copieAgora:
      'Copie o link agora: ele aparece só esta vez. Depois de fechar não dá para ver de novo — se perder, revogue e crie outro.',
    linkRotulo: 'Link do convite',
    copiar: 'Copiar link',
    copiado: 'Link copiado',
    copiaFalhou: 'Não foi possível copiar: selecione o link e copie',
    whatsapp: 'Mandar no WhatsApp',
    textoWhatsapp: (nome: string | null, link: string) =>
      `Olá! Segue o link para criar a conta ${nome ? 'do ' + nome : 'do laboratório'} no sistema. Ele vale por 14 dias e para uma conta só: ${link}`,
    fecharSemCopiar: 'Fechar sem copiar o link?\n\nEle não aparece de novo. Se precisar, revogue este convite e crie outro.',
    fechar: 'Fechar',
  }),

  /** Seção "Convites" (sempre visível, abaixo da lista de espera). */
  secao: Object.freeze({
    titulo: 'Convites',
    contagem: (n: number) => `${n} convite(s)`,
    novo: 'Novo convite',
    vazio: 'Nenhum convite criado ainda.',
    erro: 'Não foi possível carregar os convites.',
    tentar: 'Tentar de novo',
    avisoMestra: 'Criação de laboratório desligada: nenhum convite funciona até ela ser ligada (Admin SaaS → Tenants).',
    avisoAberto: 'Cadastro aberto ao público ligado: qualquer pessoa cria laboratório pelo /cadastrar, mesmo sem convite.',
    avulso: 'Convite avulso',
    criadoEm: (d: string, quem: string | null) => (quem ? `Criado em ${d} por ${quem}` : `Criado em ${d}`),
    situacao: Object.freeze({
      valido: (d: string) => `Válido até ${d}`,
      usado: (d: string) => `Usado em ${d}`,
      vencido: (d: string) => `Vencido em ${d}`,
      revogado: (d: string) => `Revogado em ${d}`,
    }),
    revogar: Object.freeze({
      revogar: 'Revogar',
      confirmaRevogar: (n: string) =>
        `Revogar o convite de "${n}"?\n\nO link para de funcionar na hora. Laboratório que já criou a conta não é afetado.`,
      revogado: 'Convite revogado',
      erroRevogar: 'Não foi possível revogar o convite',
    }),
  }),
});

/** Chave "Cadastro aberto ao público" (LAB_SIGNUP_ENABLED) no /admin/tenants. */
export const LAB_CADASTRO_ABERTO_ADMIN = Object.freeze({
  rotulo: 'Cadastro aberto ao público (laboratório)',
  carregando: 'carregando…',
  naoLeu: 'não foi possível ler',
  ligado: 'ligado',
  desligado: 'desligado',
  descDesligado: 'Sem convite, o /cadastrar do laboratório mostra a lista de espera.',
  avisoPrecos: 'Preços e planos do laboratório ainda não estão definidos: deixe desligado até essa decisão.',
  descLigado: 'Qualquer pessoa que escolher "Laboratório de prótese" no /cadastrar cria a conta, sem convite.',
  semEfeito: 'Ligado, mas sem efeito: a "Criação de laboratório" está desligada.',
  vale: 'Vale em até 1 minuto',
  separador: ' · ',
  alterado: (d: string) => `Alterado em ${d}`,
  ligar: 'Ligar',
  desligar: 'Desligar',
  ligarTravado: 'Ligue antes a "Criação de laboratório"',
  tentar: 'Tentar de novo',
  confirmaLigar:
    'Abrir o cadastro de laboratório ao público?\n\n' +
    'Preços e planos do laboratório ainda não estão definidos. Com a chave ligada, qualquer pessoa que escolher ' +
    '"Laboratório de prótese" no /cadastrar cria a conta na hora, sem convite, no plano Custom e sem cobrança.\n\n' +
    'As clínicas não mudam.',
  confirmaDesligar:
    'Fechar o cadastro aberto de laboratório?\n\n' +
    'O /cadastrar do laboratório volta para a lista de espera. Os convites válidos continuam funcionando e os ' +
    'laboratórios já criados continuam como estão.',
  avisoAoLigarMestra:
    'Atenção: o "Cadastro aberto ao público" está ligado. Com as duas chaves ligadas, qualquer pessoa cria ' +
    'laboratório pelo /cadastrar, sem convite. Continuar?',
  toastLigado: 'Cadastro aberto ligado',
  toastDesligado: 'Cadastro aberto desligado',
  toastErro: 'Não foi possível mudar o cadastro aberto',
});
