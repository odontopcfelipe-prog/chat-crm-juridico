/**
 * Passos CAD — os dados da ficha do caso. Ficam só na memória desta tela, como o resto do caso.
 * Neste navegador ficam lembrados só os nomes de cliente e de técnico, para sugerir no próximo
 * caso. O paciente do caso nunca é guardado nem vai no nome do arquivo.
 */
import { contaDoNavegador } from './motor/conta';

export interface FichaCaso {
  numero: string;
  cliente: string;
  nomeDoCaso: string;
  tecnico: string;
  notas: string;
  cor: string;
  abertoEm: string;
}

export interface Recentes {
  clientes: string[];
  tecnicos: string[];
}

const MAXIMO_DE_RECENTES = 20;
/** Campo errado com um texto colado não vira sugestão enorme. */
const MAIOR_NOME_LEMBRADO = 80;

function chaveDosRecentes(): string {
  return `passos-cad-recentes-${contaDoNavegador()}`;
}

/** Novo nome na frente da lista, sem repetir o mesmo nome com outra grafia de maiúsculas. */
export function juntarRecente(lista: readonly string[], nome: string): string[] {
  const limpo = nome.trim().slice(0, MAIOR_NOME_LEMBRADO);
  if (!limpo) return [...lista];
  const chave = limpo.toLocaleLowerCase('pt-BR');
  return [limpo, ...lista.filter((x) => x.toLocaleLowerCase('pt-BR') !== chave)].slice(0, MAXIMO_DE_RECENTES);
}

const soTextos = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function lerRecentes(): Recentes {
  try {
    const salvo = JSON.parse(window.localStorage.getItem(chaveDosRecentes()) ?? '{}') as Partial<Recentes>;
    return { clientes: soTextos(salvo.clientes), tecnicos: soTextos(salvo.tecnicos) };
  } catch {
    return { clientes: [], tecnicos: [] };
  }
}

export function guardarRecentes(ficha: Pick<FichaCaso, 'cliente' | 'tecnico'>): Recentes {
  const atuais = lerRecentes();
  const novos = { clientes: juntarRecente(atuais.clientes, ficha.cliente), tecnicos: juntarRecente(atuais.tecnicos, ficha.tecnico) };
  try {
    window.localStorage.setItem(chaveDosRecentes(), JSON.stringify(novos));
  } catch {
    // Sem armazenamento, só não sugere no próximo caso.
  }
  return novos;
}

/** Da resposta do cadastro vale só lista de textos, sem vazios nem repetidos. */
export function nomesDoCadastro(resposta: unknown): string[] {
  const vistos = new Set<string>();
  const nomes: string[] = [];
  for (const bruto of soTextos(resposta)) {
    const nome = bruto.trim();
    const chave = nome.toLocaleLowerCase('pt-BR');
    if (!nome || vistos.has(chave)) continue;
    vistos.add(chave);
    nomes.push(nome);
  }
  return nomes;
}

/** "joao" acha "João": a busca ignora maiúsculas e acentos. */
const paraBuscar = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');

/** A lista do campo Cliente: o cadastro primeiro; dos recentes, só o que não está nele. */
export function opcoesDeCliente(cadastro: readonly string[], recentes: readonly string[], busca: string): { cadastro: string[]; outros: string[] } {
  const termo = paraBuscar(busca.trim());
  const combina = (nome: string) => paraBuscar(nome).includes(termo);
  const jaNoCadastro = new Set(cadastro.map(paraBuscar));
  return {
    cadastro: cadastro.filter(combina),
    outros: recentes.filter((n) => !jaNoCadastro.has(paraBuscar(n)) && combina(n)),
  };
}

/** Ficha em branco; o técnico costuma ser o mesmo do caso anterior. */
export function fichaNova(tecnico: string): FichaCaso {
  return {
    numero: '',
    cliente: '',
    nomeDoCaso: '',
    tecnico,
    notas: '',
    cor: 'A1',
    abertoEm: new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }),
  };
}
