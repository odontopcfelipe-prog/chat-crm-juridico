/**
 * F8 do laboratório — textos do LABORATÓRIO da ficha do caso (LabFichaDoCaso.tsx): no
 * orçamento de trabalho (aba Orçamento), no trabalho aprovado (aba Trabalhos) e na
 * venda rápida.
 *
 * Só texto. A clínica não usa nada daqui: os componentes da ficha do caso só montam no
 * laboratório. Este arquivo só tem a const LAB_CASO: fica sob as travas de
 * scripts/ci/check-pick-literals.mjs, e nenhum texto fora dela pode entrar aqui.
 *
 * "Paciente do caso" é o paciente do dentista, dono do caso protético. Ele fica só no
 * sistema: não sai no PDF, na cobrança nem no WhatsApp.
 */

export const LAB_CASO = Object.freeze({
  titulo: 'Ficha do caso',
  privacidade: 'O paciente do caso fica só no sistema: não sai no PDF, na cobrança nem no WhatsApp.',
  carregando: 'Carregando a ficha do caso...',
  campos: Object.freeze({
    pacienteDoCaso: 'Paciente do caso',
    pacienteDoCasoExemplo: 'Nome ou iniciais do paciente do caso',
    dentista: 'Dentista solicitante',
    dentistaExemplo: 'Quem pediu o trabalho',
    cor: 'Cor',
    corExemplo: 'Ex.: A2, BL2',
    corPedida: 'Algum serviço deste trabalho pede cor.',
    material: 'Material',
    materialExemplo: 'Ex.: zircônia, dissilicato, PMMA',
    materialSugerido: (m: string) => `Material padrão dos serviços: ${m}`,
    entrega: 'Entrega prometida',
    sugestao: (data: string, n: number) => `Sugestão: ${data} (maior prazo dos serviços: ${n} ${n === 1 ? 'dia' : 'dias'})`,
    usarSugestao: 'Usar',
    recebido: 'Recebido em',
    hoje: 'Hoje',
    link: 'Link do escaneamento',
    linkExemplo: 'https://',
    abrirLink: 'Abrir',
    instrucoes: 'Instruções',
    instrucoesExemplo: 'Ex.: término em chanfro, contato proximal justo',
  }),
  salvar: 'Salvar ficha do caso',
  salvando: 'Salvando...',
  salvo: 'Ficha do caso salva',
  editar: 'Editar ficha do caso',
  fechar: 'Fechar',
  vazio: 'Ficha do caso ainda não preenchida.',
  herdado: 'Ficha do caso vinda do orçamento de origem. Ao salvar, ela fica gravada neste orçamento.',
  venda: Object.freeze({
    abrir: '+ Ficha do caso (opcional)',
    recolher: 'Recolher ficha do caso',
  }),
  resumo: Object.freeze({
    pacienteDoCaso: (n: string) => `Paciente do caso: ${n}`,
    dentista: (n: string) => `Dentista: ${n}`,
    cor: (c: string) => `Cor ${c}`,
    material: (m: string) => `Material: ${m}`,
    entrega: (d: string) => `Entrega ${d}`,
    faltam: (n: number) => `faltam ${n} ${n === 1 ? 'dia' : 'dias'}`,
    entregaHoje: 'entrega hoje',
    atrasada: (n: number) => `atrasada ${n} ${n === 1 ? 'dia' : 'dias'}`,
    recebido: (d: string) => `Recebido em ${d}`,
    aguardando: 'Aguardando o material do dentista',
    comProva: 'Com prova',
    escaneamento: 'Escaneamento',
  }),
  erros: Object.freeze({
    carregar: 'Não foi possível carregar a ficha do caso',
    salvar: 'Não foi possível salvar a ficha do caso',
    link: 'Use um link que comece com http:// ou https://',
    data: 'Data inválida',
    entregaFora: 'Entrega prometida fora do intervalo aceito (de 2020 até 3 anos à frente).',
    recebidoFora: 'Data de recebimento fora do intervalo aceito (de 2020 até hoje).',
    vendaSemFicha: 'A venda foi registrada, mas a ficha do caso não foi salva. Complete na aba Trabalhos do cliente.',
  }),
});
