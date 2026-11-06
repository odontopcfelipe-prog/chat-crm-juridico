/**
 * F4 do laboratório — textos do LABORATÓRIO da casca do /atendimento: a tela de
 * "sem acesso", o Início do laboratório (LabInicio) e os nomes dos atalhos dele.
 * F5 — também os nomes do menu (barra lateral e abas do celular) e o "Localizar"
 * do topo.
 * F6 — também o item do menu e os atalhos do painel de orçamentos (Orçamentos de
 * trabalho e Propostas).
 * F7 — também os atalhos da Agenda e da Central de Disparos no Início, o quadro das
 * próximas visitas, a busca da agenda no topo, o subtítulo da Agenda no Ctrl+K e o
 * botão da ficha que marca a coleta.
 *
 * Só texto. A clínica não usa nada daqui: quem usa escolhe pelo tipo de negócio
 * da sessão (`lab ? LAB_X.y : 'texto de hoje da clínica'`). Este arquivo só tem
 * consts LAB_*: fica sob as travas de scripts/ci/check-pick-literals.mjs, e
 * nenhum texto fora delas pode entrar aqui.
 */

/** Tela fora da lista de rotas do laboratório (ou sem permissão). */
export const LAB_TELA_FECHADA = Object.freeze({
  titulo: 'Sem acesso a esta tela',
  texto: 'Esta tela ainda não faz parte do laboratório. Se precisar, fale com o administrador.',
});

/** Início do laboratório: saudação, subtítulo, lista vazia e o "ver como" do admin. */
export const LAB_INICIO = Object.freeze({
  bomDia: 'Bom dia',
  boaTarde: 'Boa tarde',
  boaNoite: 'Boa noite',
  subtitulo: 'Seus atalhos no laboratório.',
  vazio: 'Ainda não há atalhos para o seu setor. Eles chegam com as próximas telas do laboratório.',
  verComo: 'Ver como',
});

/** Atalhos do Início do laboratório (um por tela liberada para ele). */
export const LAB_BALOES = Object.freeze({
  whatsapp: Object.freeze({ label: 'WhatsApp', desc: 'Converse com os clientes.' }),
  caixa: Object.freeze({ label: 'Caixa', desc: 'Entradas, saídas e fechamento do dia.' }),
  configuracoes: Object.freeze({ label: 'Configurações', desc: 'Ajustes do laboratório.' }),
  ponto: Object.freeze({ label: 'Meu ponto', desc: 'Registre entrada e saída e veja suas horas.' }),
  pontoEquipe: Object.freeze({ label: 'Ponto da equipe', desc: 'Horas da equipe, ajustes e relatório da contabilidade.' }),
  dentistas: Object.freeze({ label: 'Dentistas', desc: 'Cadastro e ficha dos clientes.' }),
  vendaRapida: Object.freeze({ label: 'Venda rápida', desc: 'Registre uma venda de balcão em segundos.' }),
  financeiro: Object.freeze({ label: 'Financeiro', desc: 'Entradas, clientes e log.' }),
  cobrancas: Object.freeze({ label: 'Cobranças', desc: 'Boletos, parcelas e atrasos.' }),
  equipe: Object.freeze({ label: 'Equipe', desc: 'Cadastro da equipe e dos protéticos.' }),
  orcamentos: Object.freeze({ label: 'Orçamentos de trabalho', desc: 'Monte, envie e acompanhe os orçamentos.' }),
  propostas: Object.freeze({ label: 'Propostas', desc: 'Orçamentos enviados aguardando o cliente.' }),
  agenda: Object.freeze({ label: 'Agenda', desc: 'Coletas, provas e entregas nos consultórios.' }),
  avisos: Object.freeze({ label: 'Central de Disparos', desc: 'Avisos automáticos para os clientes e a equipe.' }),
  passosCad: Object.freeze({ label: 'Passos CAD', desc: 'Desenhe coroas unitárias sobre o escaneamento.' }),
  funil: Object.freeze({ label: 'Funil comercial', desc: 'Acompanhe os dentistas e consultórios em captação.' }),
  relatorios: Object.freeze({ label: 'Relatórios', desc: 'Números do laboratório no período.' }),
  progresso: Object.freeze({ label: 'Progresso', desc: 'Acompanhe cada trabalho depois do orçamento fechado.' }),
  comissoes: Object.freeze({ label: 'Comissões', desc: 'Comissões e Modo jogo da equipe.' }),
  metas: Object.freeze({ label: 'Metas', desc: 'Metas e projeção do laboratório.' }),
  pontuacao: Object.freeze({ label: 'Pontuação', desc: 'Seus pontos, nível, metas e missões do mês.' }),
  afiliados: Object.freeze({ label: 'Afiliados', desc: 'Quem indica clientes para o laboratório.' }),
});

/** Nomes do menu: item da lista na barra lateral, nome do grupo dela e aba do celular. */
export const LAB_MENU = Object.freeze({
  listaDentistas: 'Dentistas',
  grupoClientes: 'Clientes',
  abaDentistas: 'Dentistas',
  orcamentos: 'Orçamentos de trabalho',
  passosCad: 'Passos CAD',
  grupoProducao: 'Produção',
  funil: 'Funil comercial',
  grupoComercial: 'Comercial',
});

/** "Localizar" do topo, pelo tipo de busca da seção (o mesmo de resolveSearchContext). */
export const LAB_LOCALIZAR: Readonly<Record<'patient' | 'financial' | 'agenda' | 'contact', string>> = Object.freeze({
  patient: 'Localizar dentista',
  financial: 'Localizar no financeiro',
  agenda: 'Localizar na agenda',
  contact: 'Localizar contato',
});

/** Quadro do Início com as próximas visitas da agenda (7 dias). */
export const LAB_PROXIMAS = Object.freeze({
  titulo: 'Próximas coletas, provas e entregas',
  vazio: 'Nada marcado para os próximos 7 dias.',
  abrir: 'Abrir a agenda',
  semCliente: 'Sem cliente',
});

/** Busca do topo na agenda (mesmo formato do CONFIG do ContextualSearchModal). */
export const LAB_BUSCA_AGENDA = Object.freeze({
  title: 'Localizar na agenda',
  placeholder: 'Buscar por cliente ou evento…',
  hint: 'Digite o nome do cliente ou do evento',
});

/** Subtítulo de um atalho do Ctrl+K pelo id do item (o que não está aqui fica igual). */
export const LAB_ATALHOS_SUBLABEL: Readonly<Partial<Record<string, string>>> = Object.freeze({
  'nav-agenda': 'Coletas, provas e entregas',
  'nav-crm': 'Dentistas e consultórios em captação',
});

/** Nome de um atalho do Ctrl+K pelo id do item (o que não está aqui fica igual). */
export const LAB_ATALHOS_LABEL: Readonly<Partial<Record<string, string>>> = Object.freeze({
  'nav-crm': 'Funil comercial',
});

/** Botão da ficha do cliente que abre a agenda com uma coleta nova. */
export const LAB_FICHA_AGENDA = Object.freeze({
  agendarColeta: 'Agendar coleta',
  dica: 'Marcar uma coleta para este cliente na agenda',
});
