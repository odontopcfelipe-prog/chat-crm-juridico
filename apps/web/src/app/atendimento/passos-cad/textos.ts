/**
 * Passos CAD — textos e listas da tela. Só o laboratório monta esta tela.
 */
import { PARAMETROS_PADRAO, type Ajuste, type Parametros } from './motor/coroa';
import type { ModoPincel } from './motor/escultura';

export const TEXTOS = Object.freeze({
  titulo: 'Passos CAD',
  subtitulo: 'Desenho de coroa unitária',
  telaFechada: 'Esta tela é do laboratório.',
  nomeCaso: 'Nome do caso',
  nomeCasoExemplo: 'Ex.: OS 1024',
  nomePadraoCaso: 'caso',
  arcoPreparo: 'Arcada com o preparo',
  arcoAntagonista: 'Arcada antagonista',
  antagonistaAjuda: 'Opcional. Exporte as duas arcadas já em oclusão, nas mesmas coordenadas.',
  escolherArquivo: 'Escolher STL, OBJ ou PLY',
  dente: 'Dente',
  material: 'Material',
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

export const DENTES_FDI: readonly number[] = Object.freeze([
  18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28,
  48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38,
]);

export type MapaId = 'nenhum' | 'espessura' | 'antagonista' | 'vizinhos';

export const MAPAS: readonly { id: MapaId; nome: string }[] = Object.freeze([
  { id: 'nenhum', nome: 'Sem mapa' },
  { id: 'espessura', nome: 'Espessura até o preparo' },
  { id: 'antagonista', nome: 'Distância ao antagonista' },
  { id: 'vizinhos', nome: 'Distância aos vizinhos' },
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
