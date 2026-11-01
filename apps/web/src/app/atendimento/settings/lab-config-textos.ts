/**
 * F4 do laboratório — rótulos do menu de Configurações na conta de laboratório.
 * F6 — também os textos da tela de modelos de orçamento (LAB_MODELOS).
 * F7 — a Central de Disparos (seção Avisos automáticos).
 *
 * Só texto. O layout de Configurações usa estes rótulos quando a conta é de
 * laboratório e cai no rótulo de sempre quando não há entrada aqui (a clínica
 * continua vendo exatamente o menu de hoje).
 */

/** Rótulo do item pelo href. */
export const LAB_CONFIG_POR_ROTA: Readonly<Record<string, string>> = Object.freeze({
  '/atendimento/settings/identidade': 'Identidade do laboratório',
  '/atendimento/settings/procedures': 'Tabela de serviços',
  '/atendimento/settings/patient-tags': 'Etiquetas de clientes',
  '/atendimento/settings/quote-templates': 'Modelos de orçamento',
  '/atendimento/settings/disparos': 'Central de Disparos',
});

/** Título da seção pelo título que a clínica vê. */
export const LAB_CONFIG_POR_SECAO: Readonly<Record<string, string>> = Object.freeze({
  'Clínica': 'Laboratório',
  'Inteligência Artificial': 'Avisos automáticos',
});

/** Tela de modelos de orçamento (cestas prontas de serviços). */
export const LAB_MODELOS = Object.freeze({
  titulo: 'Modelos de orçamento',
  descricao: 'Cestas prontas de serviços por grupo. No orçamento de trabalho, "Usar modelo" puxa todos os serviços de uma vez.',
  servicos: 'serviço(s)',
  exemploNome: 'Ex.: Coroa de zircônia unitária',
  grupo: 'Grupo (etiqueta)',
  exemploGrupo: 'Ex.: Cerâmica, Sobre implante, Removível',
  ativo: 'Modelo ativo (a equipe pode usar)',
  listaServicos: 'Serviços',
  semServicos: 'Nenhum serviço. Adicione pelo menos 1 pra o modelo ser útil.',
  selecione: 'Selecione o serviço',
  precoDaTabela: 'Deixe vazio pra usar o preço da tabela de serviços',
});
