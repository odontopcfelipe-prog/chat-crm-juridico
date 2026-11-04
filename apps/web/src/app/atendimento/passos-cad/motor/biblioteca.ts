/**
 * Passos CAD — bibliotecas de dentes do laboratório.
 *
 * A biblioteca é do laboratório que a comprou: fica na pasta dele e, depois de escolhida, no
 * armazenamento deste navegador. Nunca vai para o servidor nem para o código do sistema.
 */
import { decodeJwtPayload } from '@crm/shared';
import type { BibliotecaDaPasta } from './biblioteca-indice';

export { chaveDoDente, denteDoFdi, indexarPasta } from './biblioteca-indice';

// ---------- armazenamento neste navegador ----------

const LOJA = 'bibliotecas';

/** Um banco por conta: duas contas no mesmo navegador não enxergam a biblioteca uma da outra. */
function nomeDoBanco(): string {
  let conta: unknown;
  try {
    conta = decodeJwtPayload(window.localStorage.getItem('token'))?.tenant_id;
  } catch {
    conta = undefined;
  }
  return `passos-cad-${typeof conta === 'string' && conta ? conta : 'sem-conta'}`;
}

interface BibliotecaGuardada {
  nome: string;
  dentes: Record<string, { nome: string; dados: ArrayBuffer }>;
}

function abrirBanco(): Promise<IDBDatabase> {
  return new Promise((ok, falha) => {
    const r = indexedDB.open(nomeDoBanco(), 1);
    r.onupgradeneeded = () => r.result.createObjectStore(LOJA, { keyPath: 'nome' });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => falha(r.error ?? new Error('Armazenamento indisponível.'));
  });
}

function pedido<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((ok, falha) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => falha(r.error ?? new Error('Armazenamento indisponível.'));
  });
}

export async function guardarBiblioteca(b: BibliotecaDaPasta<File>): Promise<void> {
  const dentes: BibliotecaGuardada['dentes'] = {};
  for (const [chave, f] of b.dentes) dentes[chave] = { nome: f.name, dados: await f.arrayBuffer() };
  const db = await abrirBanco();
  try {
    await pedido(db.transaction(LOJA, 'readwrite').objectStore(LOJA).put({ nome: b.nome, dentes } satisfies BibliotecaGuardada));
  } finally {
    db.close();
  }
}

export async function bibliotecasGuardadas(): Promise<string[]> {
  try {
    const db = await abrirBanco();
    try {
      const chaves = await pedido(db.transaction(LOJA).objectStore(LOJA).getAllKeys());
      return chaves.map(String).sort((a, b) => a.localeCompare(b));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export async function lerDenteGuardado(nome: string, chave: string): Promise<{ nome: string; dados: ArrayBuffer } | null> {
  const db = await abrirBanco();
  try {
    const b = (await pedido(db.transaction(LOJA).objectStore(LOJA).get(nome))) as BibliotecaGuardada | undefined;
    return b?.dentes[chave] ?? null;
  } finally {
    db.close();
  }
}

export async function apagarBiblioteca(nome: string): Promise<void> {
  const db = await abrirBanco();
  try {
    await pedido(db.transaction(LOJA, 'readwrite').objectStore(LOJA).delete(nome));
  } finally {
    db.close();
  }
}
