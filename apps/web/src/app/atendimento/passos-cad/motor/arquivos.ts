/**
 * Passos CAD — leitura e escrita de malhas: STL (binário e texto), OBJ, PLY (binário
 * little-endian e texto) e o OFF binário das bibliotecas de dentes. Os arquivos ficam no
 * computador do técnico: nada aqui acessa a rede.
 */
import type { Malha } from './geo';

export class ArquivoRecusado extends Error {}

/** Junta vértices com a mesma posição (STL repete o vértice em cada triângulo). */
function soldador() {
  const indice = new Map<string, number>();
  const pos: number[] = [];
  return {
    pos,
    v(x: number, y: number, z: number): number {
      const k = `${x},${y},${z}`;
      let i = indice.get(k);
      if (i === undefined) {
        i = pos.length / 3;
        pos.push(x, y, z);
        indice.set(k, i);
      }
      return i;
    },
  };
}

export function lerStl(buf: ArrayBuffer): Malha {
  const dv = new DataView(buf);
  const s = soldador();
  if (buf.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === buf.byteLength) {
      const tri = new Uint32Array(n * 3);
      for (let t = 0; t < n; t++) {
        for (let k = 0; k < 3; k++) {
          const o = 84 + t * 50 + 12 + k * 12;
          tri[3 * t + k] = s.v(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true));
        }
      }
      return { pos: Float64Array.from(s.pos), tri };
    }
  }
  const texto = new TextDecoder('latin1').decode(buf);
  const tri: number[] = [];
  for (const m of texto.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) tri.push(s.v(+m[1], +m[2], +m[3]));
  if (!tri.length || tri.length % 3) throw new ArquivoRecusado('STL inválido ou vazio.');
  return { pos: Float64Array.from(s.pos), tri: Uint32Array.from(tri) };
}

export function lerObj(buf: ArrayBuffer): Malha {
  const texto = new TextDecoder('latin1').decode(buf);
  const pos: number[] = [];
  const tri: number[] = [];
  for (const linha of texto.split('\n')) {
    if (linha.startsWith('v ')) {
      const p = linha.trim().split(/\s+/);
      pos.push(+p[1], +p[2], +p[3]);
    } else if (linha.startsWith('f ')) {
      const nv = pos.length / 3;
      const f = linha.trim().split(/\s+/).slice(1).map((c) => {
        const i = parseInt(c, 10);
        return i < 0 ? nv + i : i - 1;
      });
      if (f.some((i) => !Number.isInteger(i) || i < 0)) throw new ArquivoRecusado('OBJ com índice inválido.');
      for (let i = 1; i + 1 < f.length; i++) tri.push(f[0], f[i], f[i + 1]);
    }
  }
  if (!tri.length) throw new ArquivoRecusado('OBJ sem triângulos.');
  return { pos: Float64Array.from(pos), tri: Uint32Array.from(tri) };
}

type TipoPly = { tam: number; ler: (dv: DataView, o: number) => number };
const TIPOS_PLY: Record<string, TipoPly> = {
  char: { tam: 1, ler: (d, o) => d.getInt8(o) },
  int8: { tam: 1, ler: (d, o) => d.getInt8(o) },
  uchar: { tam: 1, ler: (d, o) => d.getUint8(o) },
  uint8: { tam: 1, ler: (d, o) => d.getUint8(o) },
  short: { tam: 2, ler: (d, o) => d.getInt16(o, true) },
  int16: { tam: 2, ler: (d, o) => d.getInt16(o, true) },
  ushort: { tam: 2, ler: (d, o) => d.getUint16(o, true) },
  uint16: { tam: 2, ler: (d, o) => d.getUint16(o, true) },
  int: { tam: 4, ler: (d, o) => d.getInt32(o, true) },
  int32: { tam: 4, ler: (d, o) => d.getInt32(o, true) },
  uint: { tam: 4, ler: (d, o) => d.getUint32(o, true) },
  uint32: { tam: 4, ler: (d, o) => d.getUint32(o, true) },
  float: { tam: 4, ler: (d, o) => d.getFloat32(o, true) },
  float32: { tam: 4, ler: (d, o) => d.getFloat32(o, true) },
  double: { tam: 8, ler: (d, o) => d.getFloat64(o, true) },
  float64: { tam: 8, ler: (d, o) => d.getFloat64(o, true) },
};

interface ElementoPly {
  nome: string;
  qtd: number;
  props: { nome: string; tipo?: string; tipoQtd?: string; tipoItem?: string }[];
}

export function lerPly(buf: ArrayBuffer): Malha {
  const bytes = new Uint8Array(buf);
  const inicio = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const fim = inicio.indexOf('end_header');
  if (!inicio.startsWith('ply') || fim < 0) throw new ArquivoRecusado('PLY inválido.');
  const fimLinha = inicio.indexOf('\n', fim) + 1;
  const elementos: ElementoPly[] = [];
  let formato = '';
  let cifrado = false;
  for (const linha of inicio.slice(0, fim).split(/\r?\n/)) {
    const p = linha.trim().split(/\s+/);
    if (p[0] === 'format') formato = p[1];
    else if (p[0] === 'comment' && /encrypt|drm|protected/i.test(linha)) cifrado = true;
    else if (p[0] === 'element') elementos.push({ nome: p[1], qtd: +p[2], props: [] });
    else if (p[0] === 'property' && elementos.length) {
      const e = elementos[elementos.length - 1];
      if (p[1] === 'list') e.props.push({ nome: p[4], tipoQtd: p[2], tipoItem: p[3] });
      else e.props.push({ nome: p[2], tipo: p[1] });
    }
  }
  if (cifrado) throw new ArquivoRecusado('Este PLY está protegido e só abre no programa que o gerou.');
  // Cada elemento ocupa pelo menos um byte: contagem maior que o arquivo é cabeçalho corrompido.
  for (const e of elementos) {
    if (!Number.isInteger(e.qtd) || e.qtd < 0 || e.qtd > buf.byteLength) throw new ArquivoRecusado('PLY com cabeçalho corrompido.');
  }
  const ve = elementos.find((e) => e.nome === 'vertex');
  const fa = elementos.find((e) => e.nome === 'face');
  if (!ve) throw new ArquivoRecusado('PLY sem vértices.');
  const pos = new Float64Array(ve.qtd * 3);
  const tri: number[] = [];
  const eixos = ['x', 'y', 'z'];

  if (formato === 'ascii') {
    const linhas = new TextDecoder('latin1').decode(bytes.subarray(fimLinha)).split(/\r?\n/);
    let l = 0;
    for (const e of elementos) {
      for (let i = 0; i < e.qtd; i++, l++) {
        if (l >= linhas.length) throw new ArquivoRecusado('PLY cortado: faltam linhas.');
        const c = linhas[l].trim().split(/\s+/).map(Number);
        if (e === ve) {
          if (c.length < e.props.length) throw new ArquivoRecusado('PLY cortado: linha de vértice incompleta.');
          e.props.forEach((p, k) => {
            const a = eixos.indexOf(p.nome);
            if (a >= 0) pos[3 * i + a] = c[k];
          });
        } else if (e === fa) {
          const n = c[0];
          if (!Number.isInteger(n) || n < 0 || c.length < n + 1 || c.slice(1, n + 1).some((id) => !Number.isInteger(id) || id < 0)) throw new ArquivoRecusado('PLY com índice inválido.');
          for (let k = 2; k < n; k++) tri.push(c[1], c[k], c[k + 1]);
        }
      }
    }
  } else if (formato === 'binary_little_endian') {
    const dv = new DataView(buf);
    let o = fimLinha;
    for (const e of elementos) {
      for (let i = 0; i < e.qtd; i++) {
        for (const p of e.props) {
          if (p.tipoQtd) {
            const tq = TIPOS_PLY[p.tipoQtd];
            const ti = TIPOS_PLY[p.tipoItem as string];
            if (!tq || !ti) throw new ArquivoRecusado('PLY com tipo desconhecido.');
            const n = tq.ler(dv, o);
            if (!Number.isInteger(n) || n < 0) throw new ArquivoRecusado('PLY corrompido.');
            o += tq.tam;
            if (e === fa && /vertex_ind/.test(p.nome)) {
              const ids: number[] = [];
              for (let k = 0; k < n; k++) ids.push(ti.ler(dv, o + k * ti.tam));
              if (ids.some((id) => !Number.isInteger(id) || id < 0)) throw new ArquivoRecusado('PLY com índice inválido.');
              for (let k = 1; k + 1 < n; k++) tri.push(ids[0], ids[k], ids[k + 1]);
            }
            o += n * ti.tam;
          } else {
            const t = TIPOS_PLY[p.tipo as string];
            if (!t) throw new ArquivoRecusado('PLY com tipo desconhecido.');
            if (e === ve) {
              const a = eixos.indexOf(p.nome);
              if (a >= 0) pos[3 * i + a] = t.ler(dv, o);
            }
            o += t.tam;
          }
        }
      }
    }
  } else {
    throw new ArquivoRecusado('Formato de PLY não suportado.');
  }
  if (!tri.length) throw new ArquivoRecusado('PLY sem triângulos.');
  return { pos, tri: Uint32Array.from(tri) };
}

/** Só escaneamento. Biblioteca de outro CAD (.eoff e afins) não entra: os termos dela só permitem o uso no CAD de origem. */
export const EXTENSOES_DE_MALHA = ['stl', 'obj', 'ply'];

export function extensao(nome: string): string {
  const i = nome.lastIndexOf('.');
  return i < 0 ? '' : nome.slice(i + 1).toLowerCase();
}

/** Índice fora da malha ou coordenada que não é número: arquivo com defeito, não chega ao cálculo. */
export function conferirArquivo(m: Malha): Malha {
  const nv = m.pos.length / 3;
  if (!nv || !m.tri.length) throw new ArquivoRecusado('O arquivo não tem superfície.');
  for (let i = 0; i < m.pos.length; i++) {
    if (!Number.isFinite(m.pos[i])) throw new ArquivoRecusado('O arquivo tem coordenada inválida.');
  }
  for (let i = 0; i < m.tri.length; i++) {
    if (m.tri[i] >= nv) throw new ArquivoRecusado('O arquivo tem triângulo com índice inválido.');
  }
  return m;
}

function porExtensao(nome: string, buf: ArrayBuffer): Malha {
  switch (extensao(nome)) {
    case 'stl':
      return lerStl(buf);
    case 'obj':
      return lerObj(buf);
    case 'ply':
      return lerPly(buf);
    default:
      throw new ArquivoRecusado('Use um arquivo STL, OBJ ou PLY.');
  }
}

export function lerMalha(nome: string, buf: ArrayBuffer): Malha {
  try {
    return conferirArquivo(porExtensao(nome, buf));
  } catch (e) {
    // Leitura além do fim do arquivo ou memória insuficiente.
    if (e instanceof RangeError) throw new ArquivoRecusado('Arquivo cortado, corrompido ou grande demais.');
    throw e;
  }
}

/** STL binário. O cabeçalho não pode começar com "solid" (leitor confunde com STL de texto). */
export function escreverStl(m: Malha, cabecalho: string): ArrayBuffer {
  const nt = m.tri.length / 3;
  const buf = new ArrayBuffer(84 + nt * 50);
  const dv = new DataView(buf);
  const texto = `Passos CAD ${cabecalho}`.replace(/[^\x20-\x7e]/g, ' ').slice(0, 80);
  for (let i = 0; i < 80; i++) dv.setUint8(i, i < texto.length ? texto.charCodeAt(i) : 32);
  dv.setUint32(80, nt, true);
  const p = m.pos;
  let o = 84;
  for (let t = 0; t < nt; t++) {
    const a = m.tri[3 * t] * 3;
    const b = m.tri[3 * t + 1] * 3;
    const c = m.tri[3 * t + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    for (const x of [nx / l, ny / l, nz / l, p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]]) {
      dv.setFloat32(o, x, true);
      o += 4;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}
