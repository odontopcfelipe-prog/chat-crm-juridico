/**
 * F4 do laboratório — textos do LABORATÓRIO da casca do /atendimento: a tela de
 * "sem acesso", o Início do laboratório (LabInicio) e os nomes dos atalhos dele.
 * F5 — também os nomes do menu (barra lateral e abas do celular) e o "Localizar"
 * do topo.
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
});

/** Nomes do menu: item da lista na barra lateral, nome do grupo dela e aba do celular. */
export const LAB_MENU = Object.freeze({
  listaDentistas: 'Dentistas',
  grupoClientes: 'Clientes',
  abaDentistas: 'Dentistas',
});

/** "Localizar" do topo, pelo tipo de busca da seção (o mesmo de resolveSearchContext). */
export const LAB_LOCALIZAR: Readonly<Record<'patient' | 'financial' | 'agenda' | 'contact', string>> = Object.freeze({
  patient: 'Localizar dentista',
  financial: 'Localizar no financeiro',
  agenda: 'Localizar na agenda',
  contact: 'Localizar contato',
});
