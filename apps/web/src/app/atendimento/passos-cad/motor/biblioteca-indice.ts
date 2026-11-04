/**
 * Passos CAD — índice da pasta de bibliotecas. Puro: não lê o conteúdo dos arquivos.
 * Arquivos 1 a 8 = incisivo central a terceiro molar, por arcada.
 * Formato protegido pelo fabricante (.sdfa, .csdfa, .drmsdfa) não é lido: abre só no CAD dele.
 */

export type Arcada = 'superior' | 'inferior';

export interface ArquivoDaPasta {
  name: string;
  webkitRelativePath?: string;
}

export interface BibliotecaDaPasta<T extends ArquivoDaPasta = ArquivoDaPasta> {
  nome: string;
  /** Chave `superior6` etc. → arquivo legível. */
  dentes: Map<string, T>;
  protegida: boolean;
}

const FORA_DA_LISTA = /^(pontics|prosthetictoothsets|metadata)$/i;

export const chaveDoDente = (arcada: Arcada, posicao: number) => `${arcada}${posicao}`;

export function denteDoFdi(fdi: number): { arcada: Arcada; posicao: number } {
  const q = Math.floor(fdi / 10);
  return { arcada: q === 1 || q === 2 ? 'superior' : 'inferior', posicao: fdi % 10 };
}

/** Organiza a pasta escolhida: raiz com várias bibliotecas ou a pasta de uma só. */
export function indexarPasta<T extends ArquivoDaPasta>(arquivos: ArrayLike<T>): BibliotecaDaPasta<T>[] {
  const porNome = new Map<string, BibliotecaDaPasta<T>>();
  const preferido = new Map<string, string>();
  for (let i = 0; i < arquivos.length; i++) {
    const f = arquivos[i];
    const caminho = (f.webkitRelativePath || f.name).split('/');
    const nomeArq = caminho[caminho.length - 1];
    if (nomeArq.startsWith('._')) continue;
    if (caminho.some((c) => FORA_DA_LISTA.test(c))) continue;
    const pasta = caminho.findIndex((c) => /^(upperjaw|lowerjaw)$/i.test(c));
    if (pasta < 1 || pasta !== caminho.length - 2) continue;
    const m = /^([1-8]).([a-z]+)$/i.exec(nomeArq);
    if (!m) continue;
    const nome = caminho[pasta - 1];
    const ext = m[2].toLowerCase();
    let b = porNome.get(nome);
    if (!b) {
      b = { nome, dentes: new Map(), protegida: false };
      porNome.set(nome, b);
    }
    if (ext === 'sdfa' || ext === 'csdfa' || ext === 'drmsdfa') {
      b.protegida = true;
      continue;
    }
    if (ext !== 'eoff' && ext !== 'stl') continue;
    const chave = chaveDoDente(/^upper/i.test(caminho[pasta]) ? 'superior' : 'inferior', +m[1]);
    // O mesmo dente em dois formatos: fica o .eoff, que vem com a malha original.
    const marca = `${nome}|${chave}`;
    if (preferido.get(marca) === 'eoff') continue;
    preferido.set(marca, ext);
    b.dentes.set(chave, f);
  }
  return [...porNome.values()].sort((a, b) => a.nome.localeCompare(b.nome));
}
