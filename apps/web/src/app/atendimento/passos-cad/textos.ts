/**
 * Passos CAD — textos e listas da tela. Só o laboratório monta esta tela.
 */
import { PARAMETROS_PADRAO, type Ajuste, type Parametros } from './motor/coroa';
import type { ModoPincel } from './motor/escultura';

export const TEXTOS = Object.freeze({
  titulo: 'Passos CAD',
  subtitulo: 'Desenho de coroa unitária',
  telaFechada: 'Esta tela é do laboratório.',
  nomeCasoExemplo: 'OS 1024',
  nomePadraoCaso: 'caso',
  antagonistaAjuda: 'Exporte as duas arcadas já em oclusão, nas mesmas coordenadas.',
  escolherArquivo: 'Escolher STL, OBJ ou PLY',
  material: 'Material',
  fichaProjeto: 'Projeto',
  fichaNovo: 'Novo',
  fichaNovoPergunta: 'Começar um caso novo apaga o que está aberto aqui.',
  fichaApagar: 'Apagar e começar',
  fichaCancelar: 'Cancelar',
  fichaTrocaPergunta: 'Já existe uma coroa desenhada neste caso. Trocar agora apaga a coroa e o que foi esculpido.',
  fichaTrocaSim: 'Apagar e trocar',
  gerarApaga: 'Gerar de novo apaga o que foi esculpido.',
  fichaData: 'Data',
  fichaNumero: 'Nº do caso',
  fichaCliente: 'Cliente',
  fichaClienteEx: 'Escolha na lista ou digite',
  clienteAbrirLista: 'Ver os dentistas do cadastro',
  clienteDoCadastro: 'Do cadastro',
  clienteOutros: 'Outros nomes já usados',
  clienteBuscando: 'Buscando no cadastro...',
  clienteFalhou: 'Não deu para abrir o cadastro agora. Digite o nome.',
  clienteVazio: 'Nenhum dentista no cadastro. Digite o nome.',
  clienteSemAchado: 'Nenhum nome parecido. Pode seguir com o que digitou.',
  clienteMais: 'Continue digitando para achar outros nomes.',
  fichaPaciente: 'Paciente do caso',
  fichaTecnico: 'Técnico',
  fichaNotas: 'Observações',
  fichaNotasEx: 'Escreva as observações aqui...',
  fichaOpcoes: 'Opções',
  fichaTrabalho: 'Definição do trabalho',
  fichaEscolhaDente: 'Clique no dente que vai receber a coroa',
  fichaDenteSel: 'Dente',
  fichaCoroa: 'Coroa unitária',
  fichaCor: 'Cor do dente',
  fichaAcoes: 'Ações',
  acaoArco: 'Abrir arcada',
  acaoArcoAjuda: 'Com o preparo: STL, OBJ ou PLY',
  acaoAnt: 'Abrir antagonista',
  acaoAntAjuda: 'Opcional',
  acaoDesenhar: 'Desenhar coroa',
  faltaArco: 'Falta abrir a arcada.',
  faltaDente: 'Falta escolher o dente.',
  limpandoCaso: 'Limpando o caso…',
  resumoCaso: 'Resumo do caso',
  clicarPreparo: 'Gire o modelo e clique no topo do dente preparado.',
  margemInstrucao: 'Confira a linha vermelha. Onde ela sair do término, clique no ponto certo: a linha passa a passar por ali.',
  legendaEixos: 'Linha verde: mesial. Linha azul: vestibular.',
  desfazerPonto: 'Desfazer ponto',
  limparPontos: 'Limpar pontos',
  clicarDeNovo: 'Escolher outro ponto no preparo',
  bibliotecaGuardada: 'Biblioteca',
  bibliotecaAjuda: 'As bibliotecas ficam neste navegador, só nesta conta. Não vão para o servidor.',
  nenhumaGuardada: 'Nenhuma ainda: escolha a pasta abaixo',
  escolha: 'Escolha',
  tirarBiblioteca: 'Tirar esta biblioteca deste navegador',
  escolherPasta: 'Escolher pasta de bibliotecas',
  bibliotecasDaPasta: 'Bibliotecas da pasta',
  protegidaSufixo: '(protegida: só abre no CAD do fabricante)',
  denteSolto: 'Ou um dente em arquivo solto',
  denteSoltoAjuda: 'Eixos: x mesial, y vestibular, z oclusal.',
  bibliotecaSemDente: 'Esta biblioteca não tem arquivo legível para este dente.',
  posicaoAutomatica: 'Posição automática',
  mapa: 'Mapa de cores',
  verArco: 'Arcada',
  verAntagonista: 'Antagonista',
  pCimento: 'Espaço de cimento (mm)',
  pInicioCimento: 'Cimento começa a (mm da margem)',
  pEspessura: 'Espessura mínima (mm)',
  pAntagonista: 'Folga do antagonista (mm)',
  pVizinho: 'Folga do vizinho (mm)',
  recalcular: 'Recalcular a coroa',
  rTamanho: 'MD × VL × altura',
  rEspOclusal: 'Espessura oclusal (mais fina / típica)',
  rContatoAnt: 'Contatos com o antagonista',
  rContatoViz: 'Contatos com os vizinhos',
  rMalha: 'Malha',
  rMalhaOk: 'fechada',
  rMalhaRuim: 'com defeito',
  avisoConflito: 'Em alguns pontos a espessura mínima e a folga do antagonista não cabem juntas: ficou a espessura, e o contato ali é forte. Confira no mapa.',
  avisoAlta: 'Sobra material na oclusal: o antagonista está longe. Confira se as arcadas foram exportadas em oclusão e se o dente antagonista está inteiro.',
  avisoRetencao: 'O preparo tem retenção em relação ao eixo de inserção. O lado de dentro da coroa foi preenchido nesses pontos.',
  exportarTexto: 'A coroa sai nas mesmas coordenadas da arcada, pronta para abrir sobre o modelo.',
  baixarStl: 'Baixar STL da coroa',
  avisoRevisao: 'Confira a margem, os contatos e a espessura, e prove em resina antes de fresar. A decisão final é do técnico.',
  centralizarVista: 'Centralizar',
  pBroca: 'Diâmetro da broca (mm)',
  brocaAjuda: 'A menor broca da sua fresadora que trabalha o lado de dentro. Use 0 para impressão.',
  rFresa: 'Corte da broca',
  rFresaAte: 'até',
  rFresaNada: 'não precisou',
  rFresaDesligada: 'desligado',
  avisoBrocaGrande: 'A broca corta muito neste preparo: quinas vivas ou preparo estreito. Confira no mapa do corte ou use uma broca menor.',
  verPorDentro: 'Ver por dentro',
  esculpir: 'Esculpir',
  pincelTamanho: 'Tamanho do pincel',
  pincelForca: 'Força',
  pincelAjuda: 'Arraste com o botão esquerdo sobre a coroa. O direito gira e a roda aproxima. A margem não se move.',
  desfazerTraco: 'Desfazer traço',
  desfazendoTraco: 'Desfazendo…',
  medindo: 'Medindo de novo…',
  pincelNoLimite: 'O pincel parou no limite nesse ponto: espessura mínima ou 3 mm de mudança.',
  avisoEntrouVizinho: 'A coroa está entrando no dente vizinho. Veja no mapa de vizinhos e tire material.',
  avisoEntrouAntagonista: 'A coroa está entrando no antagonista. Veja no mapa do antagonista e tire material.',
  recalcularApaga: 'Recalcular refaz a coroa e apaga o que foi esculpido.',
  voltar: 'Voltar',
  avancar: 'Avançar',
  gerar: 'Gerar coroa',
  abrindoArquivo: 'Abrindo o arquivo…',
  procurandoPreparo: 'Procurando o preparo e a margem…',
  ajustandoMargem: 'Ajustando a margem…',
  posicionandoDente: 'Posicionando o dente…',
  guardandoBiblioteca: 'Guardando a biblioteca neste navegador…',
  gerandoCoroa: 'Gerando a coroa…',
  exportando: 'Preparando o arquivo…',
  erroGenerico: 'Não foi possível concluir. Tente de novo.',
  arquivoGrande: 'Arquivo grande demais para abrir aqui (limite de 400 MB).',
});

export const PINCEIS: readonly { id: ModoPincel; nome: string }[] = Object.freeze([
  { id: 'adicionar', nome: 'Adicionar' },
  { id: 'tirar', nome: 'Tirar' },
  { id: 'suavizar', nome: 'Suavizar' },
]);

export const ETAPAS = Object.freeze(['Caso', 'Preparo e margem', 'Anatomia', 'Ajustes', 'Exportar']);

/** Escala de cor mais usada nos laboratórios. */
export const CORES_DO_DENTE: readonly string[] = Object.freeze(['A1', 'A2', 'A3', 'A3.5', 'A4', 'B1', 'B2', 'B3', 'B4', 'C1', 'C2', 'C3', 'C4', 'D2', 'D3', 'D4']);

export type MapaId = 'nenhum' | 'espessura' | 'antagonista' | 'vizinhos' | 'broca';

export const MAPAS: readonly { id: MapaId; nome: string }[] = Object.freeze([
  { id: 'nenhum', nome: 'Sem mapa' },
  { id: 'espessura', nome: 'Espessura da coroa' },
  { id: 'antagonista', nome: 'Distância ao antagonista' },
  { id: 'vizinhos', nome: 'Distância aos vizinhos' },
  { id: 'broca', nome: 'Corte da broca (lado de dentro)' },
]);

export const MATERIAIS: readonly { id: string; nome: string; parametros: Parametros }[] = Object.freeze([
  { id: 'zirconia', nome: 'Zircônia', parametros: { ...PARAMETROS_PADRAO, espessuraMinima: 0.6 } },
  { id: 'dissilicato', nome: 'Dissilicato de lítio', parametros: { ...PARAMETROS_PADRAO, espessuraMinima: 1.0 } },
  { id: 'feldspatica', nome: 'Feldspática', parametros: { ...PARAMETROS_PADRAO, espessuraMinima: 1.0 } },
  { id: 'hibrida', nome: 'Cerâmica híbrida', parametros: { ...PARAMETROS_PADRAO, espessuraMinima: 1.0 } },
  { id: 'pmma', nome: 'PMMA (provisório)', parametros: { ...PARAMETROS_PADRAO, espessuraMinima: 1.0, cimento: 0.1 } },
  { id: 'metal', nome: 'Metal', parametros: { ...PARAMETROS_PADRAO, espessuraMinima: 0.4 } },
]);

export const AJUSTES_DA_ANATOMIA: readonly {
  chave: keyof Ajuste;
  rotulo: string;
  min: number;
  max: number;
  passo: number;
  casas: number;
  unidade: string;
}[] = Object.freeze([
  { chave: 'escalaMD', rotulo: 'Largura mesiodistal', min: 0.6, max: 1.5, passo: 0.01, casas: 2, unidade: 'x' },
  { chave: 'escalaVL', rotulo: 'Largura vestíbulo-lingual', min: 0.6, max: 1.5, passo: 0.01, casas: 2, unidade: 'x' },
  { chave: 'escalaAltura', rotulo: 'Altura', min: 0.6, max: 1.5, passo: 0.01, casas: 2, unidade: 'x' },
  { chave: 'deslocMesial', rotulo: 'Mover para mesial', min: -3, max: 3, passo: 0.05, casas: 2, unidade: ' mm' },
  { chave: 'deslocVestibular', rotulo: 'Mover para vestibular', min: -3, max: 3, passo: 0.05, casas: 2, unidade: ' mm' },
  { chave: 'deslocOclusal', rotulo: 'Subir para oclusal', min: -6, max: 12, passo: 0.05, casas: 2, unidade: ' mm' },
  { chave: 'giro', rotulo: 'Girar no eixo', min: -30, max: 30, passo: 0.5, casas: 1, unidade: '°' },
]);
