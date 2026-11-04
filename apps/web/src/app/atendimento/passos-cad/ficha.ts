/**
 * Passos CAD — os dados da ficha do caso. Ficam só na memória desta tela, como o resto do caso.
 * Neste navegador ficam lembrados só os nomes de cliente e de técnico, para sugerir no próximo
 * caso. O paciente do caso nunca é guardado nem vai no nome do arquivo.
 */
import { contaDoNavegador } from './motor/biblioteca';

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
