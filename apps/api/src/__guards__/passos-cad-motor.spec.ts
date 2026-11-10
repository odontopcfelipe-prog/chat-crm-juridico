/**
 * Passos CAD — o motor da coroa (roda no navegador do técnico; aqui com geometria sintética,
 * porque este repositório é público e não pode ter escaneamento nem biblioteca de dentes).
 * E as travas do que a tela não pode fazer: subir arquivo para a API e aparecer na clínica.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Bvh, conferirMalha, cross, dot, juntar, mul, norma, soma, sub, unit, vert, type Malha, type V3 } from '../../../web/src/app/atendimento/passos-cad/motor/geo';
import { ArquivoRecusado, escreverStl, lerMalha, lerObj, lerPly, lerStl, EXTENSOES_DE_MALHA } from '../../../web/src/app/atendimento/passos-cad/motor/arquivos';
import { acharPreparo, conferirMargem, margemDePontos, proporMargem, type PontoMargem } from '../../../web/src/app/atendimento/passos-cad/motor/margem';
import {
  anatomiaNoLugar,
  arcoSemTroquel,
  construirCoroa,
  eixosDoDente,
  PARAMETROS_PADRAO,
  posicionarAutomatico,
  type Ajuste,
  type EntradaCoroa,
} from '../../../web/src/app/atendimento/passos-cad/motor/coroa';
import { Sessao } from '../../../web/src/app/atendimento/passos-cad/motor/sessao';
import { Escultor, type ModoPincel } from '../../../web/src/app/atendimento/passos-cad/motor/escultura';
import { compensarFresa, contarSemAlcance, normalizarBroca } from '../../../web/src/app/atendimento/passos-cad/motor/fresa';
import { ALTURA_DA_IMAGEM, DENTES_DA_IMAGEM, LARGURA_DA_IMAGEM } from '../../../web/src/app/atendimento/passos-cad/mapa-da-arcada';
import { juntarRecente, nomesDoCadastro, opcoesDeCliente } from '../../../web/src/app/atendimento/passos-cad/ficha';
import { planoPadrao, validarPlano } from '../../../web/src/app/atendimento/passos-cad/motor/plano-do-dente';
import { alisarLimite, alisarOndeEncosta, normalizarParametros } from '../../../web/src/app/atendimento/passos-cad/motor/coroa';
import { camadaSobOAntagonista, pisoDosSulcos } from '../../../web/src/app/atendimento/passos-cad/motor/forma-do-plano';
import { MATERIAIS } from '../../../web/src/app/atendimento/passos-cad/textos';
import { ANTAGONISTA_SOBRE_O_DENTE, FOLGA_MAXIMA, INVASAO_MAXIMA, medirMordida } from '../../../web/src/app/atendimento/passos-cad/motor/mordida';
import { avisoDaMordida, avisoDoAntagonistaNoDente } from '../../../web/src/app/atendimento/passos-cad/aviso-da-mordida';

const paraBuffer = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** Superfície de revolução por perfil (raio, altura) de fora do eixo até a borda, com normais para fora. */
function revolucao(perfil: [number, number][], colunas = 72, ex = 1, ey = 1, base: V3 = [0, 0, 0]): Malha {
  const pos: number[] = [base[0], base[1], base[2] + perfil[0][1]];
  const tri: number[] = [];
  for (let c = 0; c < colunas; c++) {
    const th = (2 * Math.PI * c) / colunas;
    for (let k = 1; k < perfil.length; k++) {
      pos.push(base[0] + perfil[k][0] * ex * Math.cos(th), base[1] + perfil[k][0] * ey * Math.sin(th), base[2] + perfil[k][1]);
    }
  }
  const K = perfil.length - 1;
  const id = (c: number, k: number) => 1 + (c % colunas) * K + (k - 1);
  for (let c = 0; c < colunas; c++) {
    tri.push(0, id(c, 1), id(c + 1, 1));
    for (let k = 1; k < K; k++) tri.push(id(c, k), id(c, k + 1), id(c + 1, k + 1), id(c, k), id(c + 1, k + 1), id(c + 1, k));
  }
  return { pos: Float64Array.from(pos), tri: Uint32Array.from(tri) };
}

/** Densifica o perfil para a malha não ter triângulo enorme. */
function denso(p: [number, number][], passo = 0.25): [number, number][] {
  const r: [number, number][] = [p[0]];
  for (let i = 0; i + 1 < p.length; i++) {
    const n = Math.max(1, Math.ceil(Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]) / passo));
    for (let k = 1; k <= n; k++) r.push([p[i][0] + ((p[i + 1][0] - p[i][0]) * k) / n, p[i][1] + ((p[i + 1][1] - p[i][1]) * k) / n]);
  }
  return r;
}

const MARGEM_RAIO = 4.5;
const MARGEM_ALTURA = 0.8;

/** Troquel com chanfro e valeta, numa gengiva plana: oclusal para +z. */
function arcoSintetico(): Malha {
  return revolucao(denso([[0, 6], [2.6, 6], [3, 5.7], [3.5, 1.5], [3.7, 1.2], [MARGEM_RAIO, MARGEM_ALTURA], [4.3, -1], [5.2, -1.5], [6, 0], [13, 0]]));
}

/** Casca aberta embaixo, como as das bibliotecas: x mesial, y vestibular, z oclusal. */
function denteSintetico(): Malha {
  const m = revolucao(denso([[0, 3.2], [1.5, 3], [3, 3.6], [4.2, 2.6], [5, 0], [4.5, -3]]), 48, 1, 1.1);
  // Marca do lado mesial: a saliência que mostra se o dente ficou espelhado.
  for (let v = 0; v < m.pos.length / 3; v++) if (m.pos[3 * v] > 2.5 && m.pos[3 * v + 2] > 1) m.pos[3 * v + 2] += 0.5;
  return m;
}

/** Plano com a face virada para baixo, para o dente, como num escaneamento de verdade. */
function antagonistaPlano(z: number): Malha {
  const m = revolucao(denso([[0, z], [14, z]], 1), 36);
  const tri = Uint32Array.from(m.tri);
  for (let t = 0; t < tri.length; t += 3) {
    const x = tri[t + 1];
    tri[t + 1] = tri[t + 2];
    tri[t + 2] = x;
  }
  return { pos: m.pos, tri };
}

const FUNDO_DO_SULCO = -3;
const PERFIL_DO_COTO: [number, number][] = [[0, 6], [2, 6], [2.6, 5.4], [3.3, -2.5], [3.5, FUNDO_DO_SULCO], [4.2, -2], [6, -0.8], [13, -0.5]];

/** Coto liso: a parede entra direto no sulco, sem degrau nenhum, como nos anteriores do caso 031. */
function cotoLiso(): Malha {
  return revolucao(denso(PERFIL_DO_COTO, 0.2), 120);
}

/**
 * O coto com a face de trás cortada numa rampa, que domina a média das normais, e inclinado na boca.
 * `ondula`: quanto a margem sobe entre os dentes (mm), como no caso real; com a margem plana, o plano dela já
 * dá o eixo, e o defeito não aparece.
 */
function cotoDeAnterior(grau: number, ondula = 0): Malha {
  const alturaNoRaio = (r: number) => {
    for (let k = 0; k + 1 < PERFIL_DO_COTO.length; k++) {
      const [r0, z0] = PERFIL_DO_COTO[k];
      const [r1, z1] = PERFIL_DO_COTO[k + 1];
      if (r <= r1) return z0 + ((z1 - z0) * (r - r0)) / (r1 - r0);
    }
    return PERFIL_DO_COTO[PERFIL_DO_COTO.length - 1][1];
  };
  const raios: number[] = [];
  for (let r = 0; r < 6; r += 0.08) raios.push(r);
  for (let r = 6; r <= 13; r += 0.5) raios.push(r);
  const colunas = 120;
  const pos: number[] = [];
  const tri: number[] = [];
  const c = Math.cos((grau * Math.PI) / 180);
  const s = Math.sin((grau * Math.PI) / 180);
  for (let q = 0; q < colunas; q++) {
    const th = (2 * Math.PI * q) / colunas;
    for (const r of raios) {
      const x = r * Math.cos(th);
      const y = r * Math.sin(th);
      const parede = alturaNoRaio(r);
      const rampa = 5.4 + 0.85 * (y - 2.4);
      // Só em cima do coto, numa curva larga: uma quina ali seria um término de verdade.
      const h = Math.max(2 - Math.abs(parede - rampa), 0) / 2;
      const plano = r < 3.3 ? Math.min(parede, rampa) - h * h * 0.5 : parede;
      const z = plano + ondula * Math.cos(th) ** 2 * Math.max(0, Math.min(1, (2 - plano) / 5));
      pos.push(x, y * c - z * s, y * s + z * c);
    }
  }
  const K = raios.length;
  for (let q = 0; q < colunas; q++) {
    const q1 = (q + 1) % colunas;
    for (let k = 0; k + 1 < K; k++) tri.push(q * K + k, q * K + k + 1, q1 * K + k + 1, q * K + k, q1 * K + k + 1, q1 * K + k);
  }
  return { pos: Float64Array.from(pos), tri: Uint32Array.from(tri) };
}

let casoPronto: { arco: Malha; b: Bvh; prep: ReturnType<typeof acharPreparo>; margem: PontoMargem[] } | null = null;

/** O mesmo preparo para os testes da coroa: nada aqui é alterado depois de pronto. */
function preparoEMargem() {
  if (!casoPronto) {
    const arco = arcoSintetico();
    const b = new Bvh(arco);
    const prep = acharPreparo(b, [0.3, 0.2, 6], [0, 0, 1]);
    casoPronto = { arco, b, prep, margem: proporMargem(b, prep, { meridianos: 60 }) };
  }
  return casoPronto;
}

function entrada(fdi: number, antagonista: Malha | null) {
  const { arco, b, prep, margem } = preparoEMargem();
  const e: EntradaCoroa = {
    arco: b,
    antagonista: antagonista ? new Bvh(antagonista) : null,
    vizinhos: null,
    prep,
    margem,
    eixos: eixosDoDente(prep, fdi, arco, [0, -30, 0]),
    anatomia: denteSintetico(),
    parametros: { ...PARAMETROS_PADRAO },
  };
  return { e, ambiente: new Bvh(arcoSemTroquel(arco, prep, margem)) };
}

describe('Passos CAD — arquivos', () => {
  const m: Malha = { pos: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), tri: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]) };

  it('STL binário: ida e volta, sem começar com "solid", e reaproveita vértices', () => {
    const b = escreverStl(m, 'teste');
    expect(new TextDecoder().decode(b.slice(0, 5))).not.toBe('solid');
    const r = lerStl(b);
    expect(r.tri.length).toBe(12);
    expect(r.pos.length / 3).toBe(4);
    expect(conferirMalha(r).arestasAbertas).toBe(0);
  });

  it('STL de texto', () => {
    const t = 'solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid x\n';
    expect(lerStl(paraBuffer(Buffer.from(t))).tri.length).toBe(3);
  });

  it('OBJ com quadrado e com índices no formato v/vt/vn', () => {
    const r = lerObj(paraBuffer(Buffer.from('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1/1/1 2/2/2 3/3/3 4/4/4\n')));
    expect(Array.from(r.tri)).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('PLY de texto e binário, ignorando propriedades que não são posição', () => {
    const txt = 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0 9\n1 0 0 9\n0 1 0 9\n3 0 1 2\n';
    expect(Array.from(lerPly(paraBuffer(Buffer.from(txt))).pos)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const cab = Buffer.from('ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n');
    const v = Buffer.alloc(3 * 13 + 1 + 12);
    [[0, 0, 0], [1, 0, 0], [0, 1, 0]].forEach((p, i) => p.forEach((x, a) => v.writeFloatLE(x, i * 13 + a * 4)));
    v.writeUInt8(3, 39);
    [0, 1, 2].forEach((id, k) => v.writeInt32LE(id, 40 + k * 4));
    const r = lerPly(paraBuffer(Buffer.concat([cab, v])));
    expect(Array.from(r.tri)).toEqual([0, 1, 2]);
    expect(r.pos[3]).toBe(1);
  });

  it('arquivo com defeito é recusado em português, sem travar nem chegar ao cálculo', () => {
    const b = (t: string) => paraBuffer(Buffer.from(t));
    const CAB_PLY = 'property float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n';
    // contagem absurda no cabeçalho
    expect(() => lerMalha('a.ply', b('ply\nformat binary_little_endian 1.0\nelement vertex 2000000000\n' + CAB_PLY))).toThrow(ArquivoRecusado);
    expect(() => lerMalha('a.ply', b('ply\nformat ascii 1.0\nelement vertex -3\n' + CAB_PLY))).toThrow(ArquivoRecusado);
    // cortado no meio
    expect(() => lerMalha('a.ply', b('ply\nformat binary_little_endian 1.0\nelement vertex 3\n' + CAB_PLY + 'abcdefgh'))).toThrow(ArquivoRecusado);
    // índice fora da malha ou que não é número; coordenada que não é número
    expect(() => lerMalha('a.obj', b('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9\n'))).toThrow(ArquivoRecusado);
    expect(() => lerMalha('a.obj', b('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 x\n'))).toThrow(ArquivoRecusado);
    expect(() => lerMalha('a.obj', b('v 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'))).toThrow(ArquivoRecusado);
    expect(() => lerMalha('a.stl', b('solid x\nvertex a 0 0\nvertex 1 0 0\nvertex 0 1 0\nendsolid\n'))).toThrow(ArquivoRecusado);
    expect(() => lerMalha('a.ply', b('ply\nformat ascii 1.0\nelement vertex 3\n' + CAB_PLY + '0 0 0\n1 0 0\n0 1 0\n3 0 1 7\n'))).toThrow(ArquivoRecusado);
    expect(() => lerMalha('a.ply', b('ply\nformat ascii 1.0\nelement vertex 3\n' + CAB_PLY + '0 0 0\n1 0 0\n0 1 0\n3 0 1 x\n'))).toThrow(ArquivoRecusado);
    // PLY de texto cortado: falta vértice, vértice pela metade, face com menos índices
    expect(() => lerMalha('a.ply', b('ply\nformat ascii 1.0\nelement vertex 3\n' + CAB_PLY + '0 0 0\n1 0 0\n'))).toThrow(ArquivoRecusado);
    expect(() => lerMalha('a.ply', b('ply\nformat ascii 1.0\nelement vertex 3\n' + CAB_PLY + '0 0 0\n1 0\n0 1 0\n3 0 1 2\n'))).toThrow(ArquivoRecusado);
    expect(() => lerMalha('a.ply', b('ply\nformat ascii 1.0\nelement vertex 3\n' + CAB_PLY + '0 0 0\n1 0 0\n0 1 0\n3 0 1\n'))).toThrow(ArquivoRecusado);
    // vazio
    expect(() => lerMalha('a.stl', new ArrayBuffer(0))).toThrow(ArquivoRecusado);
    // e o arquivo bom continua abrindo
    expect(lerMalha('a.obj', b('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')).tri.length).toBe(3);
    expect(lerMalha('a.ply', b('ply\nformat ascii 1.0\nelement vertex 3\n' + CAB_PLY + '0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n')).tri.length).toBe(3);
  });

  it('recusa arquivo protegido, cortado ou de outro tipo, sem tentar abrir', () => {
    expect(() => lerMalha('dente.eoff', paraBuffer(Buffer.from('OFF BINARY\n')))).toThrow(ArquivoRecusado);
    expect(() => lerMalha('dente.off', paraBuffer(Buffer.from('OFF BINARY\n')))).toThrow(ArquivoRecusado);
    expect(() => lerMalha('dente.sdfa', new ArrayBuffer(8))).toThrow(ArquivoRecusado);
    const com = Buffer.from('ply\nformat binary_little_endian 1.0\ncomment encrypted\nelement vertex 1\nproperty float x\nend_header\n');
    expect(() => lerPly(paraBuffer(com))).toThrow(ArquivoRecusado);
  });
});

describe('Passos CAD — biblioteca de outro CAD não entra', () => {
  // Os termos de download de bibliotecas do exocad (4.2, 4.4 e 4.6) só permitem o uso dentro do
  // exocad e proíbem extrair dados; VITA e 3Shape vão na mesma linha. A tela não pode convidar
  // o laboratório a importar essas bibliotecas.
  const PASTA_TELA = path.join(__dirname, '../../../web/src/app/atendimento/passos-cad');
  it('sem leitor da pasta de bibliotecas e sem .eoff', () => {
    expect(fs.existsSync(path.join(PASTA_TELA, 'motor/biblioteca-indice.ts'))).toBe(false);
    expect(fs.existsSync(path.join(PASTA_TELA, 'motor/biblioteca.ts'))).toBe(false);
    expect(EXTENSOES_DE_MALHA).toEqual(['stl', 'obj', 'ply']);
    const app = fs.readFileSync(path.join(PASTA_TELA, 'PassosCadApp.tsx'), 'utf8');
    expect(app).not.toMatch(/webkitdirectory|\.eoff|indexarPasta|guardarBiblioteca|modelagem-biblioteca/);
  });

  it('a cópia guardada por versões antigas é apagada do navegador ao abrir a tela', () => {
    const conta = fs.readFileSync(path.join(PASTA_TELA, 'motor/conta.ts'), 'utf8');
    expect(conta).toContain('indexedDB.deleteDatabase(`passos-cad-${contaDoNavegador()}`)');
    const app = fs.readFileSync(path.join(PASTA_TELA, 'PassosCadApp.tsx'), 'utf8');
    expect(app).toMatch(/motor\.current = m;\s*apagarBibliotecaAntiga\(\);/);
  });
});

describe('Passos CAD — preparo e margem', () => {
  it('acha o eixo e fecha a margem na crista do chanfro', () => {
    const { prep, margem } = preparoEMargem();
    expect(Math.acos(Math.min(1, dot(prep.a, [0, 0, 1]))) * (180 / Math.PI)).toBeLessThan(4);
    expect(margem).toHaveLength(60);
    const raios = margem.map((m) => Math.hypot(m.ponto[0], m.ponto[1]));
    const alturas = margem.map((m) => m.ponto[2]);
    expect(Math.max(...raios.map((r) => Math.abs(r - MARGEM_RAIO)))).toBeLessThan(0.45);
    expect(Math.max(...alturas.map((h) => Math.abs(h - MARGEM_ALTURA)))).toBeLessThan(0.5);
  });

  it('o centro e o eixo não dependem de onde se clica no dente: no topo, fora do centro ou na parede', () => {
    const b = new Bvh(arcoSintetico());
    const cliques: V3[] = [[2.2, 0, 6], [0, -3.32, 3]];
    for (const c of cliques) {
      const p = acharPreparo(b, c, [0, 0, 1]);
      expect([c, Math.hypot(p.O[0], p.O[1]) < 0.4]).toEqual([c, true]);
      expect([c, p.a[2] > Math.cos((4 * Math.PI) / 180)]).toEqual([c, true]);
    }
  });

  it('a linha passa pelo ponto que o técnico marcou', () => {
    const arco = arcoSintetico();
    const b = new Bvh(arco);
    const prep = acharPreparo(b, [0.3, 0.2, 6], [0, 0, 1]);
    const fixo = b.raio([3.2, 0, 8], [0, 0, -1]);
    const sem = proporMargem(b, prep, { meridianos: 60 });
    const longe = Math.min(...sem.map((m) => norma(sub(m.ponto, fixo!.ponto))));
    expect(longe).toBeGreaterThan(0.6);
    const com = proporMargem(b, prep, { meridianos: 60, fixos: [fixo!.ponto] });
    expect(Math.min(...com.map((m) => norma(sub(m.ponto, fixo!.ponto))))).toBeLessThan(0.3);
  });

  it('preparo sem degrau: a linha vai até onde a parede acaba, em vez de cortar a parede', () => {
    const b = new Bvh(cotoLiso());
    const margem = proporMargem(b, acharPreparo(b, [0.3, 0.2, 6], [0, 0, 1]), { meridianos: 60 });
    const alturas = margem.map((m) => m.ponto[2]);
    expect(Math.max(...alturas)).toBeLessThan(FUNDO_DO_SULCO + 0.8);
    expect(Math.max(...alturas) - Math.min(...alturas)).toBeLessThan(0.4);
  });

  it('preparo sem degrau: o eixo vem das paredes, mesmo com a primeira estimativa longe', () => {
    const grau = 40;
    const eixo: V3 = [0, -Math.sin((grau * Math.PI) / 180), Math.cos((grau * Math.PI) / 180)];
    // A direção do antagonista no anterior aponta bem para trás: 53° do eixo do dente no 11 do caso 031.
    const lado = unit([0, -0.95, 0.3]);
    const b = new Bvh(cotoDeAnterior(grau, 3.5));
    // Sem o caminho sem crista: 11,7° e 31,1°, conforme o clique. Com ele: menos de 1°.
    for (const desvioDoClique of [0.3, 1.2]) {
      const clique = b.raio(soma([desvioDoClique, 0, 0], mul(eixo, 20)), mul(eixo, -1), 40)!.ponto;
      const prep = acharPreparo(b, clique, lado);
      expect((Math.acos(Math.min(1, dot(prep.a, eixo))) * 180) / Math.PI).toBeLessThan(5);
      // O: no meio do coto, e não encostado numa das paredes.
      const margem = proporMargem(b, prep);
      const raios = margem.map((m) => norma(sub(sub(m.ponto, prep.O), mul(prep.a, dot(sub(m.ponto, prep.O), prep.a)))));
      expect(Math.min(...raios)).toBeGreaterThan(2);
    }
  });

  it('linha fora do tamanho de um dente é recusada, não desenhada', () => {
    const { prep, margem } = preparoEMargem();
    const ruim: PontoMargem[] = margem.map((m, i) => (i === 3 ? { ...m, ponto: [40, 0, 0] as V3 } : m));
    expect(() => conferirMargem(margem, prep)).not.toThrow();
    expect(() => conferirMargem(ruim, prep)).toThrow(/saiu do preparo/);
  });

  it('clique sem superfície perto avisa', () => {
    const b = new Bvh(arcoSintetico());
    expect(() => acharPreparo(b, [0, 0, 60], [0, 0, 1])).toThrow(/superfície/);
  });

  it('lado do arco: mesial, vestibular e oclusal seguem o quadrante', () => {
    const { arco, prep } = preparoEMargem();
    for (const [fdi, sinal] of [[16, 1], [26, -1], [36, 1], [46, -1]] as const) {
      const { mesial, vestibular } = eixosDoDente(prep, fdi, arco, [0, -30, 0]);
      expect(Math.sign(dot(cross(mesial, vestibular), prep.a))).toBe(sinal);
      expect(dot(vestibular, [0, 1, 0])).toBeGreaterThan(0);
    }
  });
});

describe('Passos CAD — coroa', () => {
  const ajuste = (e: EntradaCoroa, ambiente: Bvh): Ajuste => posicionarAutomatico(e, ambiente);

  it('sai fechada, com normais para fora e dentro dos parâmetros', () => {
    const { e, ambiente } = entrada(16, antagonistaPlano(9));
    const r = construirCoroa(e, ambiente, ajuste(e, ambiente), 40);
    const c = conferirMalha(r.malha);
    expect(c.arestasAbertas).toBe(0);
    expect(c.arestasRepetidas).toBe(0);
    expect(c.volume).toBeGreaterThan(0);
    expect(r.relatorio.espessuraOclusal!.p5).toBeGreaterThanOrEqual(PARAMETROS_PADRAO.espessuraMinima - 0.05);
    expect(r.relatorio.conflitosEspessura).toBe(0);
  });

  it('a margem da coroa é a própria linha, e o cimento começa só longe dela', () => {
    const { e, ambiente } = entrada(16, null);
    // Aqui se mede o cimento puro: sem a broca cortando as quinas.
    e.parametros = { ...PARAMETROS_PADRAO, diametroBroca: 0 };
    const r = construirCoroa(e, ambiente, ajuste(e, ambiente), 40);
    const NT = e.margem.length;
    const naMargem = e.margem.map((m, i) => norma(sub(vert(r.malha, r.externos + i), m.ponto)));
    expect(Math.max(...naMargem)).toBeLessThan(1e-9);
    const arco = e.arco;
    const interna = r.malha.pos.length / 3;
    const folgas: number[] = [];
    for (let v = r.externos + NT; v < interna; v++) {
      const p = vert(r.malha, v);
      if (p[2] < 3.5) continue; // longe da margem: parede e topo
      folgas.push(Math.abs(arco.proximo(p, 2)!.d));
    }
    expect(folgas.length).toBeGreaterThan(100);
    folgas.sort((a, b) => a - b);
    expect(folgas[Math.floor(folgas.length * 0.05)]).toBeGreaterThan(PARAMETROS_PADRAO.cimento - 0.03);
    expect(folgas[Math.floor(folgas.length * 0.95)]).toBeLessThan(PARAMETROS_PADRAO.cimento + 0.03);
  });

  it('respeita a folga do antagonista e marca o contato', () => {
    const { e, ambiente } = entrada(16, antagonistaPlano(9));
    const r = construirCoroa(e, ambiente, ajuste(e, ambiente), 40);
    const f = Array.from(r.folgaAntagonista.subarray(0, r.externos));
    expect(Math.min(...f)).toBeGreaterThan(PARAMETROS_PADRAO.folgaAntagonista - 0.03);
    expect(r.relatorio.regioesContatoAntagonista).toBeGreaterThanOrEqual(1);
  });

  it('antagonista colado no preparo: a espessura vence e o conflito é avisado', () => {
    const { e, ambiente } = entrada(16, antagonistaPlano(6.3));
    const r = construirCoroa(e, ambiente, ajuste(e, ambiente), 40);
    expect(r.relatorio.conflitosEspessura).toBeGreaterThan(0);
    expect(r.relatorio.espessuraOclusal!.p5).toBeGreaterThanOrEqual(PARAMETROS_PADRAO.espessuraMinima - 0.05);
  });

  it('fecha o contato com os vizinhos, dos dois lados, sem invadir', () => {
    const { e, ambiente } = entrada(16, null);
    const m = e.eixos.mesial;
    const vizinho = (s: number) => revolucao(denso([[0, 6.5], [2, 6.4], [3.5, 5], [3.8, 3], [3, 0.5]]), 48, 1, 1, [m[0] * s * 9.4, m[1] * s * 9.4, m[2] * s * 9.4]);
    e.vizinhos = new Bvh(juntar(vizinho(1), vizinho(-1)));
    const r = construirCoroa(e, ambiente, ajuste(e, ambiente), 40);
    // Medido em cada lado: na malha grossa do teste a mancha de contato é pequena para contar como região.
    for (const lado of [1, -1]) {
      let menor = Infinity;
      for (let v = 0; v < r.externos; v++) {
        if (lado * dot(sub(vert(r.malha, v), e.prep.O), m) > 0) menor = Math.min(menor, r.folgaVizinho[v]);
      }
      expect(menor).toBeLessThan(0.12);
      // O contato entra de propósito até a sobreposição pedida, e não além dela.
      expect(menor).toBeGreaterThan(PARAMETROS_PADRAO.folgaVizinho - 0.02);
    }
    expect(r.relatorio.malha.arestasAbertas).toBe(0);
  });

  it('o antagonista perto da borda não impede de fechar o contato', () => {
    const { e, ambiente } = entrada(16, antagonistaPlano(7.5));
    const m = e.eixos.mesial;
    const vizinho = (s: number) => revolucao(denso([[0, 6.5], [2, 6.4], [3.5, 5], [3.8, 3], [3, 0.5]]), 48, 1, 1, [m[0] * s * 9.4, m[1] * s * 9.4, m[2] * s * 9.4]);
    e.vizinhos = new Bvh(juntar(vizinho(1), vizinho(-1)));
    const r = construirCoroa(e, ambiente, ajuste(e, ambiente), 40);
    for (const lado of [1, -1]) {
      let menor = Infinity;
      for (let v = 0; v < r.externos; v++) {
        if (lado * dot(sub(vert(r.malha, v), e.prep.O), m) > 0) menor = Math.min(menor, r.folgaVizinho[v]);
      }
      expect(menor).toBeLessThan(0.12);
      // O contato entra de propósito até a sobreposição pedida, e não além dela.
      expect(menor).toBeGreaterThan(PARAMETROS_PADRAO.folgaVizinho - 0.02);
    }
  });

  it('o vizinho que avança sobre a margem continua na conta; a parede do troquel sai', () => {
    const { prep, margem } = preparoEMargem();
    const parede = (tri: number[]): Malha => ({ pos: Float64Array.from([4.2, -1, 3, 4.2, 1, 3, 4.2, 0, 5]), tri: Uint32Array.from(tri) });
    // Mesmo lugar, dentro do cilindro da margem: só muda para onde a face olha.
    expect(arcoSemTroquel(parede([0, 2, 1]), prep, margem).tri.length).toBe(3); // olha para o preparo: é o vizinho
    expect(arcoSemTroquel(parede([0, 1, 2]), prep, margem).tri.length).toBe(0); // olha para fora: é o troquel
    // No meio do cilindro, olhando para O: é fossa do próprio preparo, não vizinho.
    const fossa: Malha = { pos: Float64Array.from([2, -1, 3, 2, 1, 3, 2, 0, 5]), tri: Uint32Array.from([0, 2, 1]) };
    expect(arcoSemTroquel(fossa, prep, margem).tri.length).toBe(0);
  });

  it('sem antagonista também desenha', () => {
    const { e, ambiente } = entrada(16, null);
    const aj = ajuste(e, ambiente);
    expect(aj.deslocOclusal).toBeGreaterThan(0);
    expect(construirCoroa(e, ambiente, aj, 80).relatorio.malha.arestasAbertas).toBe(0);
  });

  it('não sai espelhado: o lado mesial da biblioteca vai para mesial nos dois lados do arco', () => {
    for (const fdi of [16, 26]) {
      const { e } = entrada(fdi, null);
      const aj: Ajuste = { escalaMD: 1, escalaVL: 1, escalaAltura: 1, deslocMesial: 0, deslocVestibular: 0, deslocOclusal: 3, giro: 0 };
      const noLugar = anatomiaNoLugar(e, aj);
      const original = e.anatomia;
      let mesial = 0;
      let total = 0;
      for (let v = 0; v < original.pos.length / 3; v++) {
        if (original.pos[3 * v] <= 2.5 || original.pos[3 * v + 2] <= 1) continue;
        total++;
        if (dot(sub(vert(noLugar, v), e.prep.O), e.eixos.mesial) > 0) mesial++;
      }
      expect(total).toBeGreaterThan(10);
      expect(mesial / total).toBeGreaterThan(0.98);
      // Espelhar inverte o sentido dos triângulos: as normais precisam continuar para fora.
      const b = new Bvh(noLugar);
      const topo = b.raio(e.prep.O, e.prep.a, 30);
      expect(dot(topo!.normal, e.prep.a)).toBeGreaterThan(0);
    }
  });

  it('coroa fora do tamanho de um dente é recusada', () => {
    const { e, ambiente } = entrada(16, null);
    const aj: Ajuste = { escalaMD: 4, escalaVL: 4, escalaAltura: 1, deslocMesial: 0, deslocVestibular: 0, deslocOclusal: 3, giro: 0 };
    expect(() => construirCoroa(e, ambiente, aj, 30)).toThrow(/fora do tamanho/);
  });

  it('o caso inteiro pela sessão: abrir, clicar, escolher o dente, gerar e exportar', () => {
    const s = new Sessao({ meridianos: 60, linhas: 40 });
    s.abrirArco('arco.stl', escreverStl(arcoSintetico(), 'arco'));
    s.abrirAntagonista('ant.stl', escreverStl(antagonistaPlano(9), 'ant'));
    expect(s.temAntagonista()).toBe(true);
    const h = s.apontar([0.3, 0.2, 20], [0, 0, -1]);
    expect(h).not.toBeNull();
    const d = s.abrirDente(16, h!.ponto, h!.normal);
    expect(d.margem.length).toBe(60);
    const fechar = denteSintetico();
    const a = s.abrirAnatomia('dente.stl', escreverStl(fechar, 'dente'), { ...PARAMETROS_PADRAO });
    const c = s.construir(a.ajuste, { ...PARAMETROS_PADRAO });
    expect(c.relatorio.malha.arestasAbertas).toBe(0);
    const stl = lerStl(s.exportarStl());
    const conf = conferirMalha(stl);
    expect(conf.arestasAbertas).toBe(0);
    expect(conf.volume).toBeGreaterThan(0);
    expect(unit([1, 0, 0])[0]).toBe(1);
    expect(juntar(fechar).tri.length).toBe(fechar.tri.length);
  });
});

describe('Passos CAD — ficha do caso', () => {
  const dentes = DENTES_DA_IMAGEM;
  const de = (fdi: number) => dentes.find((d) => d.fdi === fdi) as (typeof dentes)[number];
  /** Pontos do contorno (caminho "M x y L x y ... Z", em pixels da imagem). */
  const pontos = (fdi: number): number[][] =>
    de(fdi).contorno.replace(/[MZ]/g, '').split('L').map((p) => p.trim().split(/\s+/).map(Number));
  const dentro = (x: number, y: number, poly: number[][]): boolean => {
    let sim = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) sim = !sim;
    }
    return sim;
  };

  it('a arcada tem os 32 dentes, uma vez cada', () => {
    const esperados: number[] = [];
    for (const q of [1, 2, 3, 4]) for (let n = 1; n <= 8; n++) esperados.push(q * 10 + n);
    expect(dentes.map((d) => d.fdi).sort((a, b) => a - b)).toEqual(esperados);
  });

  it('a imagem da arcada existe e tem o tamanho do mapa', () => {
    const png = fs.readFileSync(path.join(__dirname, '../../../web/public/passos-cad/arcada.png'));
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(LARGURA_DA_IMAGEM);
    expect(png.readUInt32BE(20)).toBe(ALTURA_DA_IMAGEM);
  });

  it('cada quadrante fica no seu lugar: 1 em cima à esquerda, 2 à direita, 3 embaixo à direita, 4 à esquerda', () => {
    const meioX = LARGURA_DA_IMAGEM / 2;
    const meioY = ALTURA_DA_IMAGEM / 2;
    for (const d of dentes) {
      const q = Math.floor(d.fdi / 10);
      expect([d.fdi, d.x < meioX]).toEqual([d.fdi, q === 1 || q === 4]);
      expect([d.fdi, d.y < meioY]).toEqual([d.fdi, q === 1 || q === 2]);
      for (const [x, y] of pontos(d.fdi)) {
        expect([d.fdi, x >= 0 && x <= LARGURA_DA_IMAGEM && y >= 0 && y <= ALTURA_DA_IMAGEM]).toEqual([d.fdi, true]);
      }
    }
    // Os centrais na frente, os sisos no meio da altura; em cada quadrante, cada dente fica mais para trás que o anterior.
    expect(de(11).y).toBeLessThan(de(18).y);
    expect(de(41).y).toBeGreaterThan(de(48).y);
    expect(de(48).y).toBeGreaterThan(de(18).y);
    for (const q of [1, 2, 3, 4]) {
      for (let n = 1; n < 8; n++) {
        const a = de(q * 10 + n);
        const b = de(q * 10 + n + 1);
        const fundo = (d: typeof a) => (q <= 2 ? d.y : ALTURA_DA_IMAGEM - d.y) + Math.abs(d.x - meioX) * 0.3;
        expect([a.fdi, fundo(b) > fundo(a)]).toEqual([a.fdi, true]);
      }
    }
  });

  it('o contorno de cada dente envolve o centro dele e não chega ao centro do vizinho', () => {
    for (const d of dentes) expect([d.fdi, dentro(d.x, d.y, pontos(d.fdi))]).toEqual([d.fdi, true]);
    const pares: Array<[number, number]> = [[11, 21], [41, 31]];
    for (const q of [1, 2, 3, 4]) for (let n = 1; n < 8; n++) pares.push([q * 10 + n, q * 10 + n + 1]);
    for (const [a, b] of pares) {
      expect([a, b, dentro(de(b).x, de(b).y, pontos(a))]).toEqual([a, b, false]);
      expect([b, a, dentro(de(a).x, de(a).y, pontos(b))]).toEqual([b, a, false]);
    }
  });

  it('nomes lembrados: o último vem primeiro, sem repetir e sem nome vazio', () => {
    expect(juntarRecente(['Dra. Ana', 'Dr. Bruno'], 'dr. bruno')).toEqual(['dr. bruno', 'Dra. Ana']);
    expect(juntarRecente(['Dra. Ana'], '   ')).toEqual(['Dra. Ana']);
    expect(juntarRecente([], '  Dra. Ana ')).toEqual(['Dra. Ana']);
    const muitos = Array.from({ length: 30 }, (_, i) => `Nome ${i}`);
    expect(juntarRecente(muitos, 'Novo').length).toBe(20);
    expect(juntarRecente(muitos, 'Novo')[0]).toBe('Novo');
    expect(juntarRecente([], 'x'.repeat(500))[0].length).toBe(80);
  });

  it('da resposta do cadastro vale só lista de nomes', () => {
    expect(nomesDoCadastro([' Dra. Ana ', 'dra. ana', '', '  ', 7, null, 'Dr. Bruno'])).toEqual(['Dra. Ana', 'Dr. Bruno']);
    expect(nomesDoCadastro({ erro: 'x' })).toEqual([]);
    expect(nomesDoCadastro(null)).toEqual([]);
  });

  it('a lista do Cliente: cadastro primeiro, recente repetido não aparece duas vezes', () => {
    const cadastro = ['Clínica Sorriso', 'Dr. João', 'Dra. Ana'];
    const recentes = ['dr. joao', 'Dr. Fora do Cadastro'];
    expect(opcoesDeCliente(cadastro, recentes, '')).toEqual({ cadastro, outros: ['Dr. Fora do Cadastro'] });
    // Sem acento e em minúsculas acha o nome escrito com acento.
    expect(opcoesDeCliente(cadastro, recentes, 'joao').cadastro).toEqual(['Dr. João']);
    expect(opcoesDeCliente(cadastro, recentes, 'CLINICA').cadastro).toEqual(['Clínica Sorriso']);
    expect(opcoesDeCliente(cadastro, recentes, 'fora')).toEqual({ cadastro: [], outros: ['Dr. Fora do Cadastro'] });
    expect(opcoesDeCliente(cadastro, recentes, 'zzz')).toEqual({ cadastro: [], outros: [] });
    expect(opcoesDeCliente([], [], '')).toEqual({ cadastro: [], outros: [] });
  });

  it('caso novo não herda nada do anterior, principalmente o antagonista', () => {
    const s = new Sessao({ meridianos: 60, linhas: 40 });
    s.abrirArco('arco.stl', escreverStl(arcoSintetico(), 'arco'));
    s.abrirAntagonista('ant.stl', escreverStl(antagonistaPlano(9), 'ant'));
    expect(s.temAntagonista()).toBe(true);
    s.fecharCaso();
    expect(s.temAntagonista()).toBe(false);
    expect(s.apontar([0.3, 0.2, 20], [0, 0, -1])).toBeNull();
    expect(() => s.exportarStl()).toThrow('Gere a coroa primeiro.');
  });

  it('o nome do paciente do caso não fica guardado nem vai no nome do arquivo', () => {
    const raiz = path.resolve(__dirname, '..', '..', '..', '..', 'apps/web/src/app/atendimento/passos-cad');
    const app = fs.readFileSync(path.join(raiz, 'PassosCadApp.tsx'), 'utf8');
    const ficha = fs.readFileSync(path.join(raiz, 'ficha.ts'), 'utf8');
    const exportar = app.slice(app.indexOf('const exportar = () =>'), app.indexOf('const podeAvancar'));
    expect(exportar).toContain('ficha.numero');
    expect(exportar).not.toContain('ficha.nomeDoCaso');
    expect(ficha).toMatch(/guardarRecentes\(ficha: Pick<FichaCaso, 'cliente' \| 'tecnico'>\)/);
    expect(ficha.slice(ficha.indexOf('export function guardarRecentes'))).not.toMatch(/ficha\.paciente/);
  });
});

/** Arcada de cúspides vista de cima, aberta embaixo: cúspides de 2 mm, normais para a oclusal (+z). */
function arcadaDeCuspides(passo = 0.4, meia = 15): Malha {
  const n = Math.round((2 * meia) / passo);
  const pos: number[] = [];
  const tri: number[] = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const x = -meia + i * passo;
      const y = -meia + j * passo;
      pos.push(x, y, 2 * Math.max(0, Math.cos((Math.PI * x) / 6) * Math.cos((Math.PI * y) / 6)));
    }
  }
  const id = (i: number, j: number) => i * (n + 1) + j;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) tri.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
  return { pos: Float64Array.from(pos), tri: Uint32Array.from(tri) };
}

/** O sentido dos triângulos trocado, como sai de alguns programas. */
function invertida(m: Malha): Malha {
  const tri = Uint32Array.from(m.tri);
  for (let t = 0; t < tri.length; t += 3) [tri[t + 1], tri[t + 2]] = [tri[t + 2], tri[t + 1]];
  return { pos: m.pos, tri };
}

/** Antagonista plano na altura z, com a face para baixo; a grade não coincide com a da arcada. */
const antagonistaEm = (z: number): Malha => antagonistaPlano(z);

describe('Passos CAD — conferência da mordida', () => {
  const arcada = arcadaDeCuspides();
  const b = new Bvh(arcada);
  const TOPO = 2;

  it('as arcadas que se tocam estão encaixadas, com o registro entrando um pouco ou com folga pequena', () => {
    const tocando = medirMordida(b, antagonistaEm(TOPO + 0.1));
    expect(tocando.situacao).toBe('encaixada');
    expect(tocando.menor).toBeCloseTo(0.1, 1);
    const entrandoUmPouco = medirMordida(b, antagonistaEm(TOPO - 0.2));
    expect(entrandoUmPouco.situacao).toBe('encaixada');
    expect(entrandoUmPouco.menor).toBeLessThan(0);
  });

  it('mordida aberta: diz a distância, perto ou longe', () => {
    const aberta = medirMordida(b, antagonistaEm(TOPO + 3));
    expect(aberta.situacao).toBe('afastada');
    expect(aberta.menor).toBeCloseTo(3, 1);
    // Nada a menos de 10 mm: a distância vem da medida de longe.
    const longe = medirMordida(b, antagonistaEm(TOPO + 40));
    expect(longe.situacao).toBe('afastada');
    expect(longe.menor).toBeCloseTo(40, 1);
    expect(FOLGA_MAXIMA).toBeLessThan(1);
  });

  it('uma arcada entrando na outra', () => {
    const r = medirMordida(b, antagonistaEm(TOPO - 1.5));
    expect(r.situacao).toBe('invadindo');
    expect(-r.menor).toBeGreaterThan(INVASAO_MAXIMA);
  });

  it('o mesmo arquivo nas duas', () => {
    expect(medirMordida(b, arcadaDeCuspides()).situacao).toBe('mesma');
  });

  it('triângulos no sentido trocado não mudam a resposta (escaneamento aberto)', () => {
    const bi = new Bvh(invertida(arcada));
    expect(medirMordida(bi, antagonistaEm(TOPO + 0.1)).situacao).toBe('encaixada');
    expect(medirMordida(bi, antagonistaEm(TOPO - 1.5)).situacao).toBe('invadindo');
  });

  it('triângulos no sentido trocado não mudam a resposta (modelo fechado, com base)', () => {
    // Esfera fechada: a soma das áreas some, e quem decide é o volume.
    const perfil: [number, number][] = [];
    for (let k = 0; k <= 40; k++) perfil.push([5 * Math.sin((Math.PI * k) / 40), 5 * Math.cos((Math.PI * k) / 40)]);
    const esfera = revolucao(perfil, 72);
    expect(medirMordida(new Bvh(esfera), antagonistaEm(5.1)).situacao).toBe('encaixada');
    expect(medirMordida(new Bvh(invertida(esfera)), antagonistaEm(5.1)).situacao).toBe('encaixada');
    expect(medirMordida(new Bvh(invertida(esfera)), antagonistaEm(3.5)).situacao).toBe('invadindo');
  });

  it('a Sessao confere só com as duas arcadas abertas', () => {
    const s = new Sessao({ meridianos: 60, linhas: 40 });
    s.abrirArco('arco.stl', escreverStl(arcoSintetico(), 'arco'));
    expect(s.conferirMordida()).toBeNull();
    s.abrirAntagonista('ant.stl', escreverStl(antagonistaPlano(6.1), 'ant'));
    expect(s.conferirMordida()?.situacao).toBe('encaixada');
    s.abrirAntagonista('ant.stl', escreverStl(antagonistaPlano(9), 'ant'));
    const aberta = s.conferirMordida();
    expect(aberta?.situacao).toBe('afastada');
    expect(aberta?.menor).toBeCloseTo(3, 1);
  });

  describe('antagonista sobre o dente escolhido', () => {
    const abrir = (antagonista: Malha | null) => {
      const s = new Sessao({ meridianos: 60, linhas: 40 });
      s.abrirArco('arco.stl', escreverStl(arcoSintetico(), 'arco'));
      if (antagonista) s.abrirAntagonista('ant.stl', escreverStl(antagonista, 'ant'));
      const h = s.apontar([0.3, 0.2, 20], [0, 0, -1]);
      return s.abrirDente(16, h!.ponto, h!.normal);
    };
    /** Um pedaço de antagonista que só cobre outro dente, com o centro em x. */
    const pedacoEm = (x: number) => invertida(revolucao(denso([[0, 9], [4, 9]], 1), 36, 1, 1, [x, 0, 0]));

    it('sem arquivo de antagonista não há aviso', () => {
      const d = abrir(null);
      expect(d.antagonista).toBeNull();
      expect(avisoDoAntagonistaNoDente(d.antagonista)).toBeNull();
    });

    it('antagonista sobre o dente: sem aviso', () => {
      const d = abrir(antagonistaPlano(9));
      expect(d.antagonista).toBeLessThanOrEqual(ANTAGONISTA_SOBRE_O_DENTE);
      expect(avisoDoAntagonistaNoDente(d.antagonista)).toBeNull();
    });

    it('antagonista que cobre só o dente ao lado: avisa, com a distância', () => {
      const d = abrir(pedacoEm(16));
      expect(d.antagonista).toBeGreaterThan(11);
      expect(d.antagonista).toBeLessThan(12.5);
      expect(avisoDoAntagonistaNoDente(d.antagonista)).toMatch(/está a 1[12](,\d)? mm/);
    });

    it('antagonista longe de tudo: avisa sem número', () => {
      const d = abrir(pedacoEm(80));
      expect(d.antagonista).toBe(Infinity);
      const aviso = avisoDoAntagonistaNoDente(d.antagonista);
      expect(aviso).toContain('não cobre este dente');
      expect(aviso).not.toMatch(/\d/);
    });
  });

  it('o aviso diz o número com vírgula e manda exportar de novo', () => {
    expect(avisoDaMordida({ situacao: 'encaixada', menor: 0.1 }).ok).toBe(true);
    const aberta = avisoDaMordida({ situacao: 'afastada', menor: 3.26 });
    expect(aberta.ok).toBe(false);
    expect(aberta.texto).toContain('3,3 mm');
    expect(aberta.texto).toContain('registro de mordida');
    expect(avisoDaMordida({ situacao: 'invadindo', menor: -1.44 }).texto).toContain('1,4 mm');
    expect(avisoDaMordida({ situacao: 'mesma', menor: 0 }).ok).toBe(false);
  });
});

describe('Passos CAD — compensação de fresa', () => {
  const J = 120;
  const NT = 120;
  const prep = { O: [0, 0, 1] as V3, a: [0, 0, 1] as V3, e1: [1, 0, 0] as V3, e2: [0, 1, 0] as V3 };

  /** Lado de dentro em grade, pelos raios saindo de O: `alcance(dir)` diz até onde vai em cada direção. */
  function grade(phMargem: number, alcance: (d: V3) => number, colunas = NT, linhas = J) {
    const interna: V3[][] = [];
    const arco: Float64Array[] = [];
    const margem: { ph: number }[] = [];
    for (let i = 0; i < colunas; i++) {
      const th = (2 * Math.PI * i) / colunas;
      const col: V3[] = [];
      for (let j = 0; j <= linhas; j++) {
        const ph = (phMargem * j) / linhas;
        const d: V3 = [Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph)];
        const t = alcance(d);
        col.push([prep.O[0] + d[0] * t, prep.O[1] + d[1] * t, prep.O[2] + d[2] * t]);
      }
      const s = new Float64Array(linhas + 1);
      for (let j = linhas - 1; j >= 0; j--) s[j] = s[j + 1] + norma(sub(col[j], col[j + 1]));
      interna.push(col);
      arco.push(s);
      margem.push({ ph: phMargem });
    }
    return { interna, arco, margem };
  }
  /** Cilindro de raio 3 e topo plano 5 mm acima de O: quina viva de 90° em toda a volta. */
  const cilindro = () => grade(1.4, (d) => Math.min(d[2] > 1e-9 ? 5 / d[2] : Infinity, Math.hypot(d[0], d[1]) > 1e-9 ? 3 / Math.hypot(d[0], d[1]) : Infinity));
  /** Domo de raio 3: bem maior que a broca, sem nenhuma quina. */
  const domo = () => grade(1.4, () => 3);

  it('valor digitado: campo vazio não vira 0, nem número fora da faixa passa', () => {
    expect(normalizarBroca('')).toBeNull();
    expect(normalizarBroca('  ')).toBeNull();
    expect(normalizarBroca('abc')).toBeNull();
    expect(normalizarBroca('0')).toBe(0);
    expect(normalizarBroca('1.2')).toBe(1.2);
    expect(normalizarBroca('-1')).toBe(0);
    expect(normalizarBroca('30')).toBe(3);
  });

  it('preparo mais fino que a broca: a conta termina e corta', () => {
    const g = grade(1.4, (d) => Math.min(d[2] > 1e-9 ? 4 / d[2] : Infinity, Math.hypot(d[0], d[1]) > 1e-9 ? 0.4 / Math.hypot(d[0], d[1]) : Infinity), 48, 48);
    const r = compensarFresa({ ...g, prep, J: 48, diametro: 2 });
    expect(r.pontos).toBeGreaterThan(0);
    expect(r.maiorCorte).toBeGreaterThan(0.2);
    for (const col of r.interna) for (const p of col) if (!p.every(Number.isFinite)) throw new Error('coordenada inválida');
  });

  it('quina abaixo do centro (além de 90° do eixo) também é alcançada', () => {
    // Esfera de raio 3 até 103° do eixo; depois a superfície fecha, formando uma aresta viva em toda a volta.
    const aresta = 1.8;
    const g = grade(2.4, (d) => {
      const ph = Math.acos(d[2]);
      return ph < aresta ? 3 : 3 - (ph - aresta) * 3;
    });
    const antes = contarSemAlcance(g.interna, g.arco, J, 1);
    const r = compensarFresa({ ...g, prep, J, diametro: 1 });
    expect(antes).toBeGreaterThan(NT);
    expect(r.maiorCorte).toBeGreaterThan(0.02);
    expect(contarSemAlcance(r.interna, g.arco, J, 1)).toBeLessThanOrEqual(2 * NT);
    // O corte dá a volta inteira: nenhuma coluna fica sem.
    for (let i = 0; i < NT; i++) expect(Math.max(...r.corte[i])).toBeGreaterThan(0.01);
  });

  it('sem broca (0 mm), nada muda', () => {
    const g = cilindro();
    const r = compensarFresa({ ...g, prep, J, diametro: 0 });
    expect(r.interna).toBe(g.interna);
    expect(r.pontos).toBe(0);
  });

  it('superfície lisa, com curva maior que a broca, não leva corte nenhum', () => {
    const g = domo();
    const r = compensarFresa({ ...g, prep, J, diametro: 1 });
    expect(r.pontos).toBe(0);
    expect(r.maiorCorte).toBe(0);
    expect(r.interna).toBe(g.interna);
  });

  it('quina viva: corta só em volta dela, na medida da conta, e nunca entra no preparo', () => {
    const g = cilindro();
    const r = compensarFresa({ ...g, prep, J, diametro: 1 });
    expect(r.pontos).toBeGreaterThan(0);
    // Bola de raio 0,5 passando pela quina de 90°: entra 0,5 × (1 − 1/√2) = 0,146 mm em cada face, medido na normal.
    let naFace = 0;
    let longe = 0;
    for (let i = 0; i < NT; i++) {
      for (let j = 0; j < J; j++) {
        const antes = g.interna[i][j];
        const depois = r.interna[i][j];
        if (norma(sub(depois, prep.O)) < norma(sub(antes, prep.O)) - 1e-9) throw new Error('entrou no preparo');
        const raioXY = Math.hypot(antes[0], antes[1]);
        const distQuina = Math.hypot(raioXY - 3, antes[2] - 6);
        if (distQuina > 1.2) longe = Math.max(longe, r.corte[i][j]);
        if (distQuina < 0.4) naFace = Math.max(naFace, Math.max(Math.hypot(depois[0], depois[1]) - 3, depois[2] - 6));
      }
    }
    expect(longe).toBeLessThan(1e-9);
    expect(naFace).toBeGreaterThan(0.1);
    expect(naFace).toBeLessThan(0.2);
    expect(r.maiorCorte).toBeGreaterThan(0.1);
    expect(r.maiorCorte).toBeLessThan(0.2);
  });

  it('depois de compensar, a broca alcança o lado de dentro inteiro', () => {
    const g = cilindro();
    const antes = contarSemAlcance(g.interna, g.arco, J, 1);
    const r = compensarFresa({ ...g, prep, J, diametro: 1 });
    expect(antes).toBeGreaterThan(100);
    // Sobra no máximo a aresta onde a bola encontra a parede: uma fileira, e é material para fora da broca.
    expect(contarSemAlcance(r.interna, g.arco, J, 1)).toBeLessThanOrEqual(NT);
  });

  it('broca maior corta mais; broca menor, menos; broca enorme não quebra', () => {
    const g = cilindro();
    const corte = (diametro: number) => compensarFresa({ ...g, prep, J, diametro }).maiorCorte;
    expect(corte(0.6)).toBeLessThan(corte(1.2));
    expect(corte(1.2)).toBeLessThan(corte(2));
    // A maior que o campo aceita, bem maior que a quina: a conta passa por todas as colunas e tem de terminar.
    expect(corte(3)).toBeGreaterThan(corte(2));
  });

  it('a linha da margem e a faixa colada nela não mudam, nem com quina em cima', () => {
    // Quina a 0,1 mm da margem: o raio da coluna manda.
    const g = grade(1.2, (d) => (Math.acos(d[2]) > 1.1 ? 3.2 : 3));
    const r = compensarFresa({ ...g, prep, J, diametro: 1 });
    for (let i = 0; i < NT; i++) {
      for (let j = 0; j <= J; j++) {
        if (g.arco[i][j] >= 0.2) continue;
        expect(r.interna[i][j]).toEqual(g.interna[i][j]);
      }
    }
  });

  it('na coroa: o lado de dentro leva o corte, a espessura é medida depois dele, e a malha continua fechada', () => {
    const { e, ambiente } = entrada(16, null);
    const aj = posicionarAutomatico(e, ambiente);
    e.parametros = { ...PARAMETROS_PADRAO, diametroBroca: 0 };
    const sem = construirCoroa(e, ambiente, aj, 60);
    expect(sem.relatorio.fresa).toEqual({ diametro: 0, pontos: 0, maiorCorte: 0 });
    expect(sem.corteFresa.every((c) => c === 0)).toBe(true);
    e.parametros = { ...PARAMETROS_PADRAO, diametroBroca: 1.2 };
    const com = construirCoroa(e, ambiente, aj, 60);
    expect(com.relatorio.fresa.pontos).toBeGreaterThan(0);
    expect(com.relatorio.fresa.maiorCorte).toBeGreaterThan(0.02);
    let corteFora = 0;
    for (let v = 0; v < com.externos + 60; v++) corteFora = Math.max(corteFora, com.corteFresa[v]);
    expect(corteFora).toBe(0);
    // A margem é a mesma com e sem broca.
    for (let i = com.externos * 3; i < (com.externos + 60) * 3; i++) expect(com.malha.pos[i]).toBe(sem.malha.pos[i]);
    const c = conferirMalha(com.malha);
    expect([c.arestasAbertas, c.arestasRepetidas, c.degenerados]).toEqual([0, 0, 0]);
    expect(c.volume).toBeGreaterThan(0);
    // Sem antagonista, a parte de fora cede: a espessura real continua dentro do pedido.
    expect(com.relatorio.espessuraOclusal!.p5).toBeGreaterThanOrEqual(PARAMETROS_PADRAO.espessuraMinima - 0.05);
  });
});

describe('Passos CAD — escultura à mão', () => {
  const caso = () => {
    const { e, ambiente } = entrada(16, null);
    const r = construirCoroa(e, ambiente, posicionarAutomatico(e, ambiente), 60);
    return { r, escultor: new Escultor(r) };
  };
  const deCima = (x: number, y: number): readonly [V3, V3] => [[x, y, 40], [0, 0, -1]];
  const caminho: [number, number][] = [[-1.5, 0], [-1, 0], [-0.5, 0], [0, 0], [0.5, 0], [1, 0], [1.5, 0]];
  const traco = (es: Escultor, modo: ModoPincel, pontos: [number, number][] = caminho, raio = 2, forca = 1, vezes = 1) => {
    es.iniciar();
    for (let q = 0; q < vezes; q++) for (const [x, y] of pontos) es.pincelar([deCima(x, y)], { modo, raio, forca });
    const fim = es.terminar();
    let medidas = es.medirUmPouco();
    while (!medidas) medidas = es.medirUmPouco();
    return { fim, medidas };
  };
  const altura = (es: Escultor, x: number, y: number) => (es.mira(deCima(x, y)[0], deCima(x, y)[1]) as { centro: V3 }).centro[2];

  it('as caixas acompanham a superfície que mudou', () => {
    const m = revolucao(denso([[0, 1], [6, 1]]));
    const b = new Bvh(m);
    for (let v = 0; v < m.pos.length / 3; v++) m.pos[3 * v + 2] += 5;
    b.ajustarCaixas();
    expect(b.raio([1, 1, 20], [0, 0, -1])?.ponto[2]).toBeCloseTo(6, 6);
    expect(b.proximo([1, 1, 7], 3)?.ponto[2]).toBeCloseTo(6, 6);
  });

  it('adicionar sobe a superfície; margem e lado de dentro não saem do lugar; a coroa continua fechada', () => {
    const { r, escultor } = caso();
    const antes = r.malha.pos.slice();
    const volumeAntes = conferirMalha(r.malha).volume;
    const z0 = altura(escultor, 0, 0);
    const { fim } = traco(escultor, 'adicionar');
    expect(altura(escultor, 0, 0)).toBeGreaterThan(z0 + 0.05);
    expect(fim?.tracos).toBe(1);
    for (let i = r.externos * 3; i < antes.length; i++) if (r.malha.pos[i] !== antes[i]) throw new Error('mexeu fora da superfície externa');
    const c = conferirMalha(r.malha);
    expect([c.arestasAbertas, c.arestasRepetidas, c.degenerados]).toEqual([0, 0, 0]);
    expect(c.volume).toBeGreaterThan(volumeAntes);
  });

  it('perto da margem nada se move, nem com o pincel em cima', () => {
    const { r, escultor } = caso();
    const antes = r.malha.pos.slice();
    const pontos: [number, number][] = [];
    for (let k = 0; k < 24; k++) pontos.push([4.6 * Math.cos((k * Math.PI) / 12), 4.6 * Math.sin((k * Math.PI) / 12)]);
    traco(escultor, 'adicionar', pontos, 3, 1, 4);
    for (let v = 0; v < r.externos; v++) {
      if (r.escultura.distanciaDaMargem[v] > 0.1) continue;
      for (let e = 0; e < 3; e++) expect(r.malha.pos[3 * v + e]).toBe(antes[3 * v + e]);
    }
  });

  it('tirar para na espessura mínima, sem empilhar pontos nem abrir a malha', () => {
    const { r, escultor } = caso();
    const piso = Float32Array.from(r.espessura.subarray(0, r.externos), (e, v) => Math.min(e, r.escultura.pedida[v]));
    const { fim } = traco(escultor, 'tirar', caminho, 2.5, 1, 60);
    expect(fim?.noLimite).toBe(true);
    let tocouNoPiso = 0;
    for (let v = 0; v < r.externos; v++) {
      if (r.espessura[v] < piso[v] - 0.03) throw new Error(`passou da espessura: ${r.espessura[v]} < ${piso[v]}`);
      if (r.espessura[v] < piso[v] + 0.05) tocouNoPiso++;
    }
    expect(tocouNoPiso).toBeGreaterThan(20);
    const c = conferirMalha(r.malha);
    expect([c.arestasAbertas, c.arestasRepetidas, c.degenerados]).toEqual([0, 0, 0]);
    expect(c.volume).toBeGreaterThan(0);
  });

  it('muitas passadas não deixam a superfície fugir: no máximo 3 mm de onde nasceu', () => {
    const { r, escultor } = caso();
    const antes = r.malha.pos.slice();
    traco(escultor, 'adicionar', caminho, 2, 1, 150);
    let maior = 0;
    for (let v = 0; v < r.externos; v++) {
      maior = Math.max(maior, Math.hypot(r.malha.pos[3 * v] - antes[3 * v], r.malha.pos[3 * v + 1] - antes[3 * v + 1], r.malha.pos[3 * v + 2] - antes[3 * v + 2]));
    }
    expect(maior).toBeLessThanOrEqual(3 + 1e-9);
    expect(maior).toBeGreaterThan(2.5);
    expect(conferirMalha(r.malha).arestasAbertas).toBe(0);
  });

  it('suavizar baixa o calombo que o pincel fez', () => {
    const { escultor } = caso();
    traco(escultor, 'adicionar', [[0, 0], [0.5, 0], [0, 0.5], [-0.5, 0], [0, -0.5]], 1.2, 1, 12);
    const calombo = altura(escultor, 0, 0) - altura(escultor, 2.5, 0);
    traco(escultor, 'suavizar', [[0, 0], [0.5, 0], [0, 0.5], [-0.5, 0], [0, -0.5]], 2.5, 1, 6);
    expect(altura(escultor, 0, 0) - altura(escultor, 2.5, 0)).toBeLessThan(calombo - 0.05);
  });

  it('desfazer volta exatamente como estava, um traço de cada vez', () => {
    const { r, escultor } = caso();
    const original = r.malha.pos.slice();
    const espessuraOriginal = r.espessura.slice();
    traco(escultor, 'adicionar');
    const depoisDoPrimeiro = r.malha.pos.slice();
    traco(escultor, 'tirar', [[0, 0.5], [0.5, 0.5]]);
    expect(escultor.tracos).toBe(2);
    expect(escultor.desfazer()?.tracos).toBe(1);
    expect(Array.from(r.malha.pos)).toEqual(Array.from(depoisDoPrimeiro));
    expect(escultor.desfazer()?.tracos).toBe(0);
    expect(Array.from(r.malha.pos)).toEqual(Array.from(original));
    expect(escultor.desfazer()).toBeNull();
    let medidas = escultor.medirUmPouco();
    while (!medidas) medidas = escultor.medirUmPouco();
    for (let v = 0; v < r.externos; v++) expect(medidas.espessura[v]).toBeCloseTo(espessuraOriginal[v], 3);
  });

  it('não desfaz com o traço ainda aberto: a volta sairia misturada', () => {
    const { escultor } = caso();
    traco(escultor, 'adicionar');
    escultor.iniciar();
    escultor.pincelar([deCima(0, 0)], { modo: 'tirar', raio: 2, forca: 1 });
    expect(escultor.desfazer()).toBeNull();
    expect(escultor.terminar()?.tracos).toBe(2);
    expect(escultor.desfazer()?.tracos).toBe(1);
  });

  it('vários raios no mesmo pedido: cada um acha a superfície onde ela já está', () => {
    const { escultor } = caso();
    const z0 = altura(escultor, 0, 0);
    escultor.iniciar();
    const raios = Array.from({ length: 40 }, (_, k) => deCima(k % 2 === 0 ? 0 : 0.5, 0));
    escultor.pincelar(raios, { modo: 'adicionar', raio: 2, forca: 1 });
    escultor.terminar();
    expect(altura(escultor, 0, 0)).toBeGreaterThan(z0 + 0.5);
  });

  it('a quantidade depende do caminho, não do tempo: parado no mesmo ponto não acumula', () => {
    const { escultor } = caso();
    const z0 = altura(escultor, 0, 0);
    escultor.iniciar();
    for (let q = 0; q < 50; q++) escultor.pincelar([deCima(0, 0)], { modo: 'adicionar', raio: 2, forca: 1 });
    escultor.terminar();
    expect(altura(escultor, 0, 0) - z0).toBeLessThan(0.08);
  });

  it('fora da coroa o pincel não faz nada e não conta traço', () => {
    const { escultor } = caso();
    escultor.iniciar();
    expect(escultor.pincelar([[[60, 60, 40], [0, 0, -1]]], { modo: 'adicionar', raio: 2, forca: 1 }).mudanca).toBeNull();
    expect(escultor.terminar()).toBeNull();
    expect(escultor.tracos).toBe(0);
    expect(escultor.mira([60, 60, 40], [0, 0, -1])).toBeNull();
  });

  it('o STL sai com a escultura; gerar de novo apaga a escultura', () => {
    const s = new Sessao({ meridianos: 60, linhas: 40 });
    s.abrirArco('arco.stl', escreverStl(arcoSintetico(), 'arco'));
    const h = s.apontar([0.3, 0.2, 20], [0, 0, -1]);
    s.abrirDente(16, h!.ponto, h!.normal);
    const a = s.abrirAnatomia('dente.stl', escreverStl(denteSintetico(), 'dente'), { ...PARAMETROS_PADRAO });
    s.construir(a.ajuste, { ...PARAMETROS_PADRAO });
    const volumeOriginal = conferirMalha(lerStl(s.exportarStl())).volume;
    s.pincelar(caminho.map(([x, y]) => deCima(x, y)), { modo: 'adicionar', raio: 2, forca: 1 }, true);
    expect(s.terminarTraco()?.tracos).toBe(1);
    const conf = conferirMalha(lerStl(s.exportarStl()));
    expect(conf.arestasAbertas).toBe(0);
    expect(conf.volume).toBeGreaterThan(volumeOriginal + 0.05);
    s.construir(a.ajuste, { ...PARAMETROS_PADRAO });
    expect(s.desfazerTraco()).toBeNull();
    expect(conferirMalha(lerStl(s.exportarStl())).volume).toBeCloseTo(volumeOriginal, 3);
  });
});

describe('Passos CAD — modelagem pelo plano do dente', () => {
  const casoPronto = (antagonista: Malha | null, fdi = 16) => {
    const s = new Sessao({ meridianos: 60, linhas: 40 });
    s.abrirArco('arco.stl', escreverStl(arcoSintetico(), 'arco'));
    if (antagonista) s.abrirAntagonista('ant.stl', escreverStl(antagonista, 'ant'));
    const h = s.apontar([0.3, 0.2, 20], [0, 0, -1]);
    s.abrirDente(fdi, h!.ponto, h!.normal);
    return s;
  };
  const PARAMETROS = { ...PARAMETROS_PADRAO };
  const TODOS = [11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33, 34, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48];

  it.each(TODOS)('o dente %i tem um desenho de partida que o motor aceita sem mudar', (fdi) => {
    const p = planoPadrao(fdi);
    expect(p.cuspides.length).toBeGreaterThan(0);
    for (const c of p.cuspides) {
      expect(Math.abs(c.u)).toBeLessThanOrEqual(0.95);
      expect(Math.abs(c.w)).toBeLessThanOrEqual(0.95);
    }
    // O próprio desenho passa pela conferência da resposta da IA sem perder nada.
    expect(validarPlano(p, fdi)).toEqual(expect.objectContaining({ cuspides: p.cuspides, alturaMm: p.alturaMm }));
  });

  // Os quadrantes 2 e 4 espelham o dente, e os anteriores têm outra forma: todos têm de fechar.
  it.each([11, 23, 26, 31, 35, 42, 46, 48])('o dente %i fecha e não entra no antagonista', (fdi) => {
    const c = casoPronto(antagonistaPlano(10), fdi).construirComPlano(planoPadrao(fdi), PARAMETROS);
    expect(c.relatorio.malha.arestasAbertas).toBe(0);
    expect(c.relatorio.malha.arestasRepetidas).toBe(0);
    expect(c.relatorio.malha.volume).toBeGreaterThan(0);
    const folgas = Array.from(c.folgaAntagonista.subarray(0, c.externos)).filter(Number.isFinite);
    expect(Math.min(...folgas)).toBeGreaterThanOrEqual(0);
  });

  it('o molar inferior tem mais cúspides que o pré-molar, e o superior e o inferior são diferentes', () => {
    expect(planoPadrao(36).cuspides.length).toBe(5);
    expect(planoPadrao(46).cuspides.length).toBe(5);
    expect(planoPadrao(14).cuspides.length).toBe(2);
    expect(planoPadrao(16).cuspides.map((c) => c.nome)).toContain('mesio-palatina');
  });

  it('fecha a coroa sem biblioteca nenhuma', () => {
    const s = casoPronto(antagonistaPlano(9));
    const c = s.construirComPlano(planoPadrao(16), PARAMETROS);
    expect(c.relatorio.malha.arestasAbertas).toBe(0);
    expect(c.relatorio.malha.arestasRepetidas).toBe(0);
    expect(c.relatorio.malha.volume).toBeGreaterThan(0);
    expect(conferirMalha(lerStl(s.exportarStl())).arestasAbertas).toBe(0);
  });

  it('funciona sem antagonista', () => {
    const c = casoPronto(null).construirComPlano(planoPadrao(16), PARAMETROS);
    expect(c.relatorio.malha.arestasAbertas).toBe(0);
    expect(c.relatorio.alturaMm).toBeGreaterThan(4);
  });

  it('não entra no antagonista e mantém a espessura mínima', () => {
    const c = casoPronto(antagonistaPlano(9)).construirComPlano(planoPadrao(16), PARAMETROS);
    const folgas = Array.from(c.folgaAntagonista.subarray(0, c.externos)).filter(Number.isFinite);
    expect(Math.min(...folgas)).toBeGreaterThanOrEqual(0);
    expect(c.relatorio.espessuraOclusal!.p5).toBeGreaterThanOrEqual(PARAMETROS.espessuraMinima - 0.05);
    expect(c.relatorio.conflitosEspessura).toBe(0);
  });

  it('parede sem pregas: em volta do dente, o raio muda aos poucos', () => {
    const c = casoPronto(antagonistaPlano(9)).construirComPlano(planoPadrao(16), PARAMETROS);
    const NT = 60;
    const J = 40;
    // Linha no meio da parede, longe da margem e da oclusal.
    const j = 30;
    const raio = (i: number) => {
      const v = 1 + i * (J - 1) + (j - 1);
      return Math.hypot(c.malha.pos[3 * v], c.malha.pos[3 * v + 1]);
    };
    let maiorDobra = 0;
    for (let i = 0; i < NT; i++) maiorDobra = Math.max(maiorDobra, Math.abs(raio((i + 1) % NT) - 2 * raio(i) + raio((i + NT - 1) % NT)));
    expect(maiorDobra).toBeLessThan(0.12);
  });

  it('antagonista alto não carimba: a descida se espalha, sem paredão em volta da marca', () => {
    // Uma cúspide do antagonista descendo sobre a coroa, deixando espaço para a espessura. A face fica
    // virada para baixo, como num escaneamento de verdade.
    const cone = revolucao(denso([[0, 7.2], [4, 11], [8, 14]]));
    const tri = Uint32Array.from(cone.tri);
    for (let k = 0; k < tri.length; k += 3) {
      const x = tri[k + 1];
      tri[k + 1] = tri[k + 2];
      tri[k + 2] = x;
    }
    const c = casoPronto({ pos: cone.pos, tri }).construirComPlano(planoPadrao(16), PARAMETROS);
    const folgas = Array.from(c.folgaAntagonista.subarray(0, c.externos)).filter(Number.isFinite);
    expect(Math.min(...folgas)).toBeGreaterThanOrEqual(0);
    // Tudo na mesma folga seria a impressão do cone: a parte encostada tem de ser pequena.
    const encostados = folgas.filter((f) => f < PARAMETROS.folgaAntagonista + 0.02).length;
    expect(encostados / folgas.length).toBeLessThan(0.1);
    expect(c.relatorio.malha.arestasAbertas).toBe(0);
  });

  it('o pincel funciona na coroa do plano, e o STL sai fechado com a escultura', () => {
    const s = casoPronto(antagonistaPlano(9));
    s.construirComPlano(planoPadrao(16), PARAMETROS);
    const volume = conferirMalha(lerStl(s.exportarStl())).volume;
    const raios: [V3, V3][] = [[-1, 0], [0, 0], [1, 0]].map(([x, y]) => [[x, y, 20] as V3, [0, 0, -1] as V3]);
    s.pincelar(raios, { modo: 'adicionar', raio: 2, forca: 1 }, true);
    expect(s.terminarTraco()?.tracos).toBe(1);
    const conf = conferirMalha(lerStl(s.exportarStl()));
    expect(conf.arestasAbertas).toBe(0);
    expect(conf.volume).toBeGreaterThan(volume);
  });

  it('preparo com degrau: a parede desce até a margem, sem saia, nos dois jeitos de modelar', () => {
    // Ombro largo: o lado de dentro dá a volta no degrau, e a distância por ali é maior que a real.
    const comDegrau = revolucao(denso([[0, 6], [2.4, 6], [2.7, 5.7], [2.9, 2], [4.1, 1.6], [4.3, 1.5], [4.5, -1], [5.2, -1.5], [6, 0], [13, 0]]));
    const montar = () => {
      const s = new Sessao({ meridianos: 60, linhas: 80 });
      s.abrirArco('arco.stl', escreverStl(comDegrau, 'arco'));
      const h = s.apontar([0.3, 0.2, 20], [0, 0, -1]);
      s.abrirDente(16, h!.ponto, h!.normal);
      return s;
    };
    const maiorSaia = (c: { malha: Malha }, margem: V3[]) => {
      const J = 80;
      let maior = -Infinity;
      for (let i = 0; i < margem.length; i++) {
        const rm = Math.hypot(margem[i][0], margem[i][1]);
        for (let j = J - 4; j < J; j++) {
          const v = 1 + i * (J - 1) + (j - 1);
          maior = Math.max(maior, Math.hypot(c.malha.pos[3 * v], c.malha.pos[3 * v + 1]) - rm);
        }
      }
      return maior;
    };
    const s = montar();
    const h = s.apontar([0.3, 0.2, 20], [0, 0, -1]);
    const dente = s.abrirDente(16, h!.ponto, h!.normal);
    expect(maiorSaia(s.construirComPlano(planoPadrao(16), PARAMETROS), dente.margem)).toBeLessThan(0.5);
    const a = s.abrirAnatomia('dente.stl', escreverStl(denteSintetico(), 'dente'), PARAMETROS);
    expect(maiorSaia(s.construir(a.ajuste, PARAMETROS), dente.margem)).toBeLessThan(0.5);
  });

  it('a parede do próprio preparo não é tomada por vizinho', () => {
    // Preparo mais largo em cima que na margem deixa a parede dele entre os "vizinhos". Aqui ela entra
    // de propósito, com a arcada inteira no lugar dos vizinhos: sem a regra, o contorno encolhe até ela.
    const { e } = entrada(11, null);
    const J = 40;
    const aj: Ajuste = { escalaMD: 1, escalaVL: 1, escalaAltura: 1, deslocMesial: 0, deslocVestibular: 0, deslocOclusal: 0, giro: 0 };
    const c = construirCoroa({ ...e, plano: planoPadrao(11) }, new Bvh(arcoSintetico()), aj, J);
    let menor = Infinity;
    for (let i = 0; i < e.margem.length; i++) {
      let maior = 0;
      for (let j = 1; j < J; j++) {
        const v = 1 + i * (J - 1) + (j - 1);
        // Só no meio da parede: perto da margem a coroa é sempre larga e esconderia o encolhimento.
        if (c.malha.pos[3 * v + 2] > 3) maior = Math.max(maior, Math.hypot(c.malha.pos[3 * v], c.malha.pos[3 * v + 1]));
      }
      menor = Math.min(menor, maior);
    }
    // Medido em 04/11/2026: 4,95 mm com a regra e 4,05 mm sem ela, colada no preparo.
    expect(menor).toBeGreaterThan(4.5);
    expect(c.relatorio.malha.arestasAbertas).toBe(0);
  });

  it('vizinho longe não estica o dente: o espaço fica aberto', () => {
    // Dois dentes vizinhos, longe do preparo: alcançar os dois faria o incisivo lateral largo demais.
    const vizinho = (x: number) => revolucao(denso([[0, 9], [3, 8.5], [3.4, 3], [3.8, 0]]), 36, 1, 1, [x, 0, 0]);
    const s = new Sessao({ meridianos: 60, linhas: 40 });
    s.abrirArco('arco.stl', escreverStl(juntar(arcoSintetico(), vizinho(9.6), vizinho(-9.6)), 'arco'));
    const h = s.apontar([0.3, 0.2, 20], [0, 0, -1]);
    s.abrirDente(12, h!.ponto, h!.normal);
    const estreito = s.construirComPlano(planoPadrao(12), PARAMETROS);
    const largo = s.construirComPlano({ ...planoPadrao(12), larguraMm: 12 }, PARAMETROS);
    // Com largura natural de 12 mm ele alcança os dois vizinhos; com a de um incisivo lateral, não.
    expect(largo.relatorio.mdMm).toBeGreaterThan(estreito.relatorio.mdMm + 1);
    expect(estreito.relatorio.mdMm).toBeLessThan(10.5);
  });

  it('o mesmo plano gera sempre a mesma coroa', () => {
    const a = casoPronto(antagonistaPlano(9)).construirComPlano(planoPadrao(16), PARAMETROS);
    const b = casoPronto(antagonistaPlano(9)).construirComPlano(planoPadrao(16), PARAMETROS);
    expect(Array.from(a.malha.pos)).toEqual(Array.from(b.malha.pos));
  });

  it('o plano muda a coroa: a altura pedida aparece no dente', () => {
    const base = planoPadrao(16);
    const baixo = { ...base, cuspides: base.cuspides.map((k) => ({ ...k, h: k.h * 0.82 })), cristas: base.cristas.map((k) => ({ ...k, hDe: k.hDe * 0.82, hMeio: k.hMeio * 0.82, hAte: k.hAte * 0.82 })) };
    const alto = casoPronto(null).construirComPlano(base, PARAMETROS).relatorio.alturaMm;
    const menor = casoPronto(null).construirComPlano(baixo, PARAMETROS).relatorio.alturaMm;
    expect(menor).toBeLessThan(alto - 0.3);
  });

  describe('anatomia', () => {
    const POSTERIORES = [14, 15, 16, 17, 24, 25, 26, 27, 34, 35, 36, 37, 44, 45, 46, 47];
    const materialDe = (id: string) => MATERIAIS.find((m) => m.id === id)!.parametros;

    it('as medidas de cada dente vêm da tabela de anatomia', () => {
      expect([planoPadrao(11).alturaMm, planoPadrao(11).larguraMm, planoPadrao(11).vlMm]).toEqual([10.5, 8.5, 7]);
      expect([planoPadrao(25).alturaMm, planoPadrao(25).larguraMm, planoPadrao(25).vlMm]).toEqual([8.5, 6.5, 9]);
      expect([planoPadrao(16).alturaMm, planoPadrao(16).larguraMm, planoPadrao(16).vlMm]).toEqual([7.5, 10, 11]);
      expect([planoPadrao(41).alturaMm, planoPadrao(41).larguraMm, planoPadrao(41).vlMm]).toEqual([9, 5, 6]);
      expect([planoPadrao(47).alturaMm, planoPadrao(47).larguraMm, planoPadrao(47).vlMm]).toEqual([7, 10.5, 10]);
    });

    it.each(POSTERIORES)('dente %i: mesa oclusal entre 55%% e 65%% da largura VL', (fdi) => {
      const cuspides = planoPadrao(fdi).cuspides;
      const vest = Math.max(...cuspides.map((c) => c.w));
      const ling = Math.min(...cuspides.map((c) => c.w));
      const mesa = (vest - ling) / 2;
      expect(mesa).toBeGreaterThanOrEqual(0.55);
      expect(mesa).toBeLessThanOrEqual(0.65);
    });

    it.each(POSTERIORES)('dente %i: sulco principal de 0,5 a 1 mm e sulcos secundários rasos', (fdi) => {
      const sulcos = planoPadrao(fdi).sulcos;
      const principais = sulcos.filter((s) => s.largura! >= 0.5);
      const secundarios = sulcos.filter((s) => s.largura! < 0.5);
      const fundo = Math.max(...principais.flatMap((s) => s.pontos.map((p) => p[2])));
      expect(fundo).toBeGreaterThanOrEqual(0.5);
      expect(fundo).toBeLessThanOrEqual(1);
      expect(secundarios.length).toBeGreaterThanOrEqual(4);
      for (const s of secundarios) expect(Math.max(...s.pontos.map((p) => p[2]))).toBeLessThanOrEqual(0.35);
    });

    it('cada molar inferior tem o seu padrão: Y com cinco cúspides no 36, cruz com quatro no 37', () => {
      expect(planoPadrao(36).cuspides).toHaveLength(5);
      expect(planoPadrao(37).cuspides).toHaveLength(4);
      // No 37 os sulcos vestibular e lingual saem alinhados; no 36, o vestibular vai para a mesial.
      const fimVestibular = (fdi: number) => planoPadrao(fdi).sulcos[1].pontos.at(-1)!;
      expect(Math.abs(fimVestibular(37)[0])).toBeLessThan(0.1);
      expect(fimVestibular(36)[0]).toBeGreaterThan(0.2);
    });

    it('a morfologia que identifica cada dente', () => {
      const alturas = (fdi: number) => Object.fromEntries(planoPadrao(fdi).cuspides.map((c) => [c.nome, c.h]));
      // 14: vestibular cerca de 1 mm mais alta. 15: quase iguais.
      expect((alturas(14).vestibular - alturas(14).palatina) * planoPadrao(14).alturaMm).toBeCloseTo(1, 0);
      expect(alturas(15).vestibular - alturas(15).palatina).toBeLessThan(0.06);
      // 16: a mesio-palatina é a maior e a disto-palatina, a menor.
      expect(alturas(16)['mesio-palatina']).toBe(Math.max(...Object.values(alturas(16))));
      expect(alturas(16)['disto-palatina']).toBe(Math.min(...Object.values(alturas(16))));
      // 36: as linguais são mais altas que as vestibulares.
      expect(alturas(36)['mesio-lingual']).toBeGreaterThan(alturas(36)['mesio-vestibular']);
      // Canino: a ponta fica para a mesial.
      expect(planoPadrao(13).cuspides[0].u).toBeGreaterThan(0);
      expect(planoPadrao(33).cuspides[0].u).toBeGreaterThan(planoPadrao(13).cuspides[0].u);
      // Crista marginal só nos posteriores: nos anteriores, ela desalinharia a borda incisal.
      expect(planoPadrao(11).cristas.some((c) => c.lado)).toBe(false);
      expect(planoPadrao(13).cristas.some((c) => c.lado)).toBe(false);
      expect(planoPadrao(16).cristas.filter((c) => c.lado).map((c) => c.lado).sort()).toEqual(['distal', 'mesial']);
    });

    it('contato com o antagonista e com o vizinho nas faixas certas', () => {
      for (const m of MATERIAIS) {
        expect(m.parametros.folgaAntagonista).toBeGreaterThanOrEqual(0);
        expect(m.parametros.folgaAntagonista).toBeLessThanOrEqual(0.05);
        expect(m.parametros.folgaVizinho).toBeGreaterThanOrEqual(-0.05);
        expect(m.parametros.folgaVizinho).toBeLessThanOrEqual(-0.02);
      }
    });

    it('cada material tem a sua espessura, e a oclusal nunca é menor que a parede', () => {
      const pares = (id: string) => [materialDe(id).espessuraOclusal, materialDe(id).espessuraMinima];
      expect(pares('zirconia')).toEqual([0.8, 0.6]);
      expect(pares('dissilicato')).toEqual([1.5, 1]);
      expect(pares('pmma')).toEqual([1.2, 1]);
      for (const m of MATERIAIS) expect(m.parametros.espessuraOclusal).toBeGreaterThanOrEqual(m.parametros.espessuraMinima);
    });

    it('a espessura oclusal do material vale na coroa pelo plano', () => {
      const medir = (id: string) => casoPronto(null).construirComPlano(planoPadrao(16), materialDe(id)).relatorio.espessuraOclusal!.p5;
      expect(medir('dissilicato')).toBeGreaterThanOrEqual(1.45);
      expect(medir('zirconia')).toBeGreaterThanOrEqual(0.75);
      expect(medir('dissilicato')).toBeGreaterThan(medir('zirconia') + 0.3);
    });

    it('a espessura oclusal do material vale também na coroa pela biblioteca', () => {
      const pedidaNoTopo = (id: string) => {
        const s = casoPronto(null);
        const a = s.abrirAnatomia('dente.stl', escreverStl(denteSintetico(), 'dente'), materialDe(id));
        const c = s.construir(a.ajuste, materialDe(id));
        expect(c.relatorio.espessuraOclusal!.p5).toBeGreaterThanOrEqual(materialDe(id).espessuraOclusal - 0.05);
        return c.espessuraPedida[0];
      };
      expect(pedidaNoTopo('dissilicato')).toBeCloseTo(1.5, 1);
      expect(pedidaNoTopo('zirconia')).toBeCloseTo(0.8, 1);
    });

    it('a oclusal pede a espessura dela, e toda a parede, inclusive a alta, a da parede', () => {
      const c = casoPronto(null).construirComPlano(planoPadrao(16), materialDe('dissilicato'));
      let maiorNaParede = 0;
      let paredes = 0;
      for (let v = 0; v < c.externos; v++) {
        const x = c.malha.pos[3 * v];
        const y = c.malha.pos[3 * v + 1];
        const z = c.malha.pos[3 * v + 2];
        // Preparo sintético: parede de z = 1,5 a 5,7 e topo em z = 6. O raio passa de 4 mm só na parede.
        if (z > 2 && z < 5.5 && Math.hypot(x, y) > 4) {
          maiorNaParede = Math.max(maiorNaParede, c.espessuraPedida[v]);
          paredes++;
        }
      }
      expect(paredes).toBeGreaterThan(50);
      expect(maiorNaParede).toBeLessThanOrEqual(1.05);
      expect(c.espessuraPedida[0]).toBeCloseTo(1.5, 1);
    });

    it('valor digitado errado não chega cru ao motor', () => {
      const p = normalizarParametros({ ...PARAMETROS, folgaVizinho: -1, espessuraMinima: -2, espessuraOclusal: Number.NaN, folgaAntagonista: -0.5, cimento: 9 });
      expect(p.folgaVizinho).toBe(-0.1);
      expect(p.espessuraMinima).toBe(0.2);
      expect(p.espessuraOclusal).toBe(PARAMETROS_PADRAO.espessuraOclusal);
      expect(p.folgaAntagonista).toBe(0);
      expect(p.cimento).toBe(0.3);
      // A coroa sai fechada e sem entrar 1 mm em nada.
      const c = casoPronto(antagonistaPlano(9)).construirComPlano(planoPadrao(16), { ...PARAMETROS, folgaVizinho: -1, espessuraMinima: -2, folgaAntagonista: -0.5 });
      expect(c.relatorio.malha.arestasAbertas).toBe(0);
      expect(Math.min(...Array.from(c.folgaAntagonista.subarray(0, c.externos)).filter(Number.isFinite))).toBeGreaterThanOrEqual(-0.01);
    });

    it('o piso dos sulcos não passa da cúspide do antagonista, nem depois de alisado', () => {
      const n = 41;
      const camada = new Float64Array(n * n).fill(5);
      // Antagonista 0,3 mm acima da camada, com uma cúspide estreita descendo até 0,05 mm dela.
      const teto = new Float64Array(n * n).fill(5.3);
      teto[20 * n + 20] = 5.05;
      const piso = pisoDosSulcos(teto, camada, n, n);
      for (let k = 0; k < piso.length; k++) expect(piso[k]).toBeLessThanOrEqual(teto[k] + 1e-9);
      // Sem antagonista, a folga inteira fica disponível para o sulco.
      const semTeto = pisoDosSulcos(new Float64Array(n * n).fill(Infinity), camada, n, n);
      expect(semTeto[20 * n + 20]).toBeCloseTo(5.35, 5);
      // Sem espaço, o piso fica na camada: a espessura manda mais que o contato.
      const semEspaco = pisoDosSulcos(new Float64Array(n * n).fill(4.9), camada, n, n);
      expect(semEspaco[20 * n + 20]).toBeCloseTo(5, 5);
    });

    it('a camada cede ao antagonista até a espessura de verdade, sem borda', () => {
      const n = 41;
      const k = 20 * n + 20;
      const ceder = (zAnt: Float64Array, nivelPiso = 4.2) => {
        const camada = new Float64Array(n * n).fill(5);
        camadaSobOAntagonista(camada, new Float64Array(n * n).fill(nivelPiso), zAnt, 0.05, n, n);
        return camada;
      };
      // Cúspide estreita do antagonista descendo até 4,6, abaixo da camada de 5.
      const comCuspide = new Float64Array(n * n).fill(6);
      comCuspide[k] = 4.6;
      const camada = ceder(comCuspide);
      expect(camada[k]).toBeLessThanOrEqual(4.55 + 1e-9);
      expect(camada[k]).toBeGreaterThanOrEqual(4.2);
      // Sem degrau, que é o anel em volta da cúspide: de uma célula para a outra muda pouco.
      let maiorDegrau = 0;
      for (let x = 0; x + 1 < n; x++) maiorDegrau = Math.max(maiorDegrau, Math.abs(camada[x + 1 + 20 * n] - camada[x + 20 * n]));
      expect(maiorDegrau).toBeLessThan(0.15);
      // Longe do antagonista não muda nada.
      expect(camada[0]).toBeCloseTo(5, 6);
      expect(ceder(new Float64Array(n * n).fill(Infinity))[k]).toBeCloseTo(5, 6);
      // Sem espaço para os dois, a espessura manda.
      expect(ceder(new Float64Array(n * n).fill(3), 4.2)[k]).toBeCloseTo(4.2, 6);
    });

    it('antagonista áspero não deixa a oclusal áspera', () => {
      // Desce sobre o ombro da coroa: é onde a camada é mais grossa que o mínimo e sobra espaço entre as duas.
      const aspero = (amplitude: number): Malha => {
        const lado = 97;
        const pos = new Float64Array(3 * lado * lado);
        for (let y = 0; y < lado; y++) {
          for (let x = 0; x < lado; x++) {
            const v = 3 * (x + y * lado);
            pos[v] = -9 + x * 0.1875;
            pos[v + 1] = -9 + y * 0.1875;
            const r = Math.hypot(pos[v], pos[v + 1]);
            pos[v + 2] = 7.3 - 0.6 * Math.max(0, r - 3) + (amplitude * ((x * 7 + y * 13) % 5)) / 4;
          }
        }
        const tri: number[] = [];
        for (let y = 0; y + 1 < lado; y++) {
          for (let x = 0; x + 1 < lado; x++) {
            const a = x + y * lado;
            tri.push(a, a + lado, a + 1, a + 1, a + lado, a + lado + 1);
          }
        }
        return { pos, tri: Uint32Array.from(tri) };
      };
      // Pontos colados nele: é a superfície copiando o antagonista, em vez de só encostar.
      const coladosNele = (antagonista: Malha) => {
        const c = casoPronto(antagonista).construirComPlano(planoPadrao(16), PARAMETROS);
        expect(c.relatorio.malha.arestasAbertas).toBe(0);
        let colados = 0;
        for (let v = 0; v < c.externos; v++) if (c.folgaAntagonista[v] < PARAMETROS.folgaAntagonista + 0.03) colados++;
        return { colados, total: c.externos };
      };
      // Sem a camada ceder, ficam 28 pontos colados aqui.
      expect(coladosNele(aspero(0.16)).colados).toBeLessThan(10);
    });

    it('o limite de espessura fica liso, e não sobe até o antagonista', () => {
      const NT = 60;
      const J = 40;
      const arco = Array.from({ length: NT }, () => new Float64Array(J + 1).fill(5));
      const pisoRuidoso = () => Array.from({ length: NT }, () => Float64Array.from({ length: J + 1 }, (_, j) => 6 + (j % 2) * 0.1));
      // Longe do antagonista: fica liso.
      const longe = pisoRuidoso();
      alisarLimite(longe, Array.from({ length: NT }, () => new Float64Array(J + 1).fill(Infinity)), arco, NT, J);
      const naLinha = Array.from(longe[0].subarray(5, J - 5));
      expect(Math.max(...naLinha) - Math.min(...naLinha)).toBeLessThan(0.03);
      // Com o antagonista áspero logo acima: sobe só até uma versão lisa do teto. Até o teto cru, copiaria a textura dele.
      const perto = pisoRuidoso();
      const teto = Array.from({ length: NT }, (_, i) => Float64Array.from({ length: J + 1 }, (_, j) => 6.02 + (((i * 7 + j * 13) % 5) * 0.02)));
      alisarLimite(perto, teto, arco, NT, J);
      const antes = pisoRuidoso();
      const naTexturaDele: number[] = [];
      for (let i = 0; i < NT; i++) {
        for (let j = 2; j < J - 2; j++) {
          expect(perto[i][j]).toBeLessThanOrEqual(Math.max(antes[i][j], teto[i][j]) + 1e-9);
          if (j % 2 === 0) naTexturaDele.push(perto[i][j]);
        }
      }
      expect(Math.max(...naTexturaDele) - Math.min(...naTexturaDele)).toBeLessThan(0.02);
      // Com a espessura passando do antagonista: fica liso, porque não há contato a preservar.
      const semEspaco = pisoRuidoso();
      alisarLimite(semEspaco, Array.from({ length: NT }, () => new Float64Array(J + 1).fill(5.5)), arco, NT, J);
      const emConflito = Array.from(semEspaco[0].subarray(5, J - 5));
      expect(Math.max(...emConflito) - Math.min(...emConflito)).toBeLessThan(0.03);
    });

    it('a borda do dente oposto não vira degrau no limite de espessura', () => {
      const NT = 60;
      const J = 40;
      const arco = Array.from({ length: NT }, () => new Float64Array(J + 1).fill(5));
      const piso = Array.from({ length: NT }, () => new Float64Array(J + 1).fill(6));
      for (const linha of piso) for (let j = 0; j <= J; j++) linha[j] += (j % 2) * 0.3;
      // Metade dos raios pega o dente oposto, e a outra passa por fora, numa linha serrilhada.
      const teto = Array.from({ length: NT }, (_, i) => Float64Array.from({ length: J + 1 }, (_, j) => (j < 18 + (i % 2) * 4 ? 6.2 : Infinity)));
      alisarLimite(piso, teto, arco, NT, J);
      let maior = 0;
      for (let i = 0; i < NT; i++) for (let j = 4; j < J - 4; j += 2) maior = Math.max(maior, Math.abs(piso[(i + 1) % NT][j] - piso[i][j]));
      expect(maior).toBeLessThan(0.08);
    });

    it('a lateral do dente oposto não carimba degraus na camada', () => {
      const n = 81;
      // Dois dentes de baixo, um mais à frente que o outro, com a lateral quase em pé.
      const zAnt = new Float64Array(n * n).fill(Infinity);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (y < (x < 40 ? 30 : 36)) zAnt[x + y * n] = 5;
      const camada = new Float64Array(n * n).fill(9);
      camadaSobOAntagonista(camada, new Float64Array(n * n).fill(4), zAnt, 0.05, n, n);
      for (let k = 0; k < camada.length; k++) if (zAnt[k] !== Infinity) expect(camada[k]).toBeLessThanOrEqual(4.95 + 1e-9);
      // Sobe aos poucos a partir da lateral: sem isso, pula cerca de 1 mm de uma célula para a outra.
      let maior = 0;
      for (let y = 0; y + 1 < n; y++) for (let x = 0; x < n; x++) maior = Math.max(maior, Math.abs(camada[x + (y + 1) * n] - camada[x + y * n]));
      expect(maior).toBeLessThan(0.45);
    });

    it('onde a camada cede, ela não copia o relevo do preparo', () => {
      const n = 81;
      const zAnt = new Float64Array(n * n).fill(Infinity);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (y < 30) zAnt[x + y * n] = 5;
      const piso = new Float64Array(n * n);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) piso[x + y * n] = 6 + (((x * 7 + y * 13) % 5) * 0.05);
      const camada = new Float64Array(n * n).fill(9);
      camadaSobOAntagonista(camada, piso, zAnt, 0.05, n, n);
      // Logo depois da lateral dele, onde o teto liso ainda está abaixo do preparo: fica no apoio liso.
      const naLinha = Array.from({ length: 41 }, (_, x) => camada[x + 20 + 34 * n]);
      expect(Math.max(...naLinha) - Math.min(...naLinha)).toBeLessThan(0.03);
    });

    it('onde a coroa encosta, fica lisa e entre os dois limites; o resto não muda', () => {
      const NT = 60;
      const J = 60;
      const piso = Array.from({ length: NT }, () => new Float64Array(J + 1).fill(4));
      // Até a linha 20 os raios pegam o dente oposto, numa borda serrilhada.
      const teto = Array.from({ length: NT }, (_, i) => Float64Array.from({ length: J + 1 }, (_, j) => (j < 20 + (i % 2) * 3 ? 5 : Infinity)));
      const R = Array.from({ length: NT }, (_, i) => Float64Array.from({ length: J + 1 }, (_, j) => (j < 20 + (i % 2) * 3 ? 5 : 6)));
      // Um sulco longe dali: o alisado não pode apagar.
      for (let i = 0; i < NT; i++) R[i][45] = 5.6;
      alisarOndeEncosta(R, piso, teto, NT, J);
      let degrau = 0;
      for (let i = 0; i < NT; i++) {
        for (let j = 2; j < J - 2; j++) {
          expect(R[i][j]).toBeLessThanOrEqual(teto[i][j] + 1e-9);
          expect(R[i][j]).toBeGreaterThanOrEqual(piso[i][j] - 1e-9);
          if (j > 12 && j < 30) degrau = Math.max(degrau, Math.abs(R[(i + 1) % NT][j] - R[i][j]));
        }
      }
      expect(degrau).toBeLessThan(0.3);
      expect(R[0][45]).toBeCloseTo(5.6, 6);
    });

    it('preparo sem degrau: o contorno não incha para dar espessura perto da margem', () => {
      const s = new Sessao({ meridianos: 60, linhas: 40 });
      s.abrirArco('coto.stl', escreverStl(cotoLiso(), 'coto'));
      const h = s.apontar([0.3, 0.2, 20], [0, 0, -1]);
      s.abrirDente(11, h!.ponto, h!.normal);
      const c = s.construirComPlano(planoPadrao(11), PARAMETROS);
      expect(c.relatorio.malha.arestasAbertas).toBe(0);
      // Sem a correção: 9,28 e 10,37 mm. Com ela: 8,23 e 9,54 mm.
      expect(c.relatorio.vlMm).toBeLessThan(8.7);
      expect(c.relatorio.mdMm).toBeLessThan(10);
    });

    describe('gengiva entre os dentes', () => {
      const COTO = PERFIL_DO_COTO.slice(0, 5);
      const GENGIVA_BAIXA: [number, number][] = [[6, -2.8], [13, -2.6]];
      const coroaSobre = (arco: Malha, parametros = PARAMETROS) => {
        const s = new Sessao({ meridianos: 60, linhas: 40 });
        s.abrirArco('coto.stl', escreverStl(arco, 'coto'));
        const h = s.apontar([0.3, 0.2, 20], [0, 0, -1]);
        s.abrirDente(11, h!.ponto, h!.normal);
        return s.construirComPlano(planoPadrao(11), parametros);
      };

      it('a gengiva entre os dentes não limita nem puxa a coroa', () => {
        const baixa = coroaSobre(revolucao(denso([...COTO, ...GENGIVA_BAIXA], 0.2), 120));
        const alta = coroaSobre(revolucao(denso([...COTO, [4.3, -1.4], [7, -0.8], [13, -0.5]], 0.2), 120));
        // Sem a correção, a alta vira contato: 9,22 mm contra 8,16 mm.
        expect(Math.abs(alta.relatorio.mdMm - baixa.relatorio.mdMm)).toBeLessThan(0.1);
        expect(alta.relatorio.regioesContatoVizinho).toBe(0);
      });

      it('um dente baixo ao lado continua limitando: a coroa não entra nele', () => {
        // Parede em pé em x = 3,6, de 0,4 a 2,4 mm acima da margem: é dente, não gengiva. Espessura fina, para
        // caber: se a espessura pedida não coubesse, ela venceria, e a tela avisaria do conflito.
        const dente = revolucao(denso([[0, -0.6], [3.6, -0.6], [3.6, -3]]), 72, 1, 1, [7.2, 0, 0]);
        const c = coroaSobre(juntar(revolucao(denso([...COTO, ...GENGIVA_BAIXA], 0.2), 120), dente), { ...PARAMETROS, espessuraMinima: 0.3 });
        let maisLonge = -Infinity;
        for (let v = 0; v < c.externos; v++) {
          const p = vert(c.malha, v);
          if (p[2] > -2 && p[2] < -0.8 && Math.abs(p[1]) < 0.5) maisLonge = Math.max(maisLonge, p[0]);
        }
        // Sem a correção: 3,81 mm, 0,2 mm dentro do dente. Com ela: 3,63 mm.
        expect(maisLonge).toBeLessThan(3.7);
      });
    });

    it('anterior: a altura conta da margem vestibular', () => {
      const arco = cotoLiso();
      const b = new Bvh(arco);
      const prep = acharPreparo(b, [0.3, 0.2, 6], [0, 0, 1]);
      const pontos: V3[] = [];
      for (let k = 0; k < 72; k++) {
        const th = (2 * Math.PI * k) / 72;
        // A margem vestibular (y positivo) 2 mm abaixo da palatina, como no 13 do caso 031.
        pontos.push([3.3 * Math.cos(th), 3.3 * Math.sin(th), -1 - Math.sin(th)]);
      }
      const margem = margemDePontos(b, prep, pontos, 60);
      const ajuste: Ajuste = { escalaMD: 1, escalaVL: 1, escalaAltura: 1, deslocMesial: 0, deslocVestibular: 0, deslocOclusal: 0, giro: 0 };
      const altura = (plano: ReturnType<typeof planoPadrao>) => {
        const e: EntradaCoroa = { arco: b, antagonista: null, vizinhos: null, prep, margem, eixos: eixosDoDente(prep, 11, arco, [0, -30, 0]), anatomia: { pos: new Float64Array(0), tri: new Uint32Array(0) }, parametros: { ...PARAMETROS }, plano };
        return construirCoroa(e, new Bvh(arcoSemTroquel(arco, prep, margem)), ajuste).relatorio.alturaMm;
      };
      const plano = planoPadrao(11);
      expect(plano.anterior).toBe(true);
      expect(altura({ ...plano, anterior: false }) - altura(plano)).toBeGreaterThan(0.6);
      // Posterior segue contando do meio da margem, e a IA não troca isso.
      expect(planoPadrao(16).anterior).toBe(false);
      expect(validarPlano({ anterior: false, cuspides: [{ nome: 'a', u: 0, w: 0, h: 1 }] }, 11).anterior).toBe(true);
    });

    it('vizinho longe abre o contorno devagar: estreito, o passo vira uma asa saindo do dente', () => {
      const vizinho = revolucao(denso([[0, 9], [3, 8.5], [3.4, 3], [3.8, 0]]), 36, 1, 1, [10.6, 0, 0]);
      const s = new Sessao({ meridianos: 90, linhas: 40 });
      s.abrirArco('arco.stl', escreverStl(juntar(arcoSintetico(), vizinho), 'arco'));
      const h = s.apontar([0.3, 0.2, 20], [0, 0, -1]);
      s.abrirDente(16, h!.ponto, h!.normal);
      const c = s.construirComPlano({ ...planoPadrao(16), larguraMm: 16 }, PARAMETROS);
      // A largura do dente perto da ponta. Sem a correção: 3,78 mm. Com ela: 4,82 mm.
      const pontos = Array.from({ length: c.externos }, (_, v) => vert(c.malha, v));
      const maisLonge = Math.max(...pontos.map((p) => p[0]));
      const ys = pontos.filter((p) => p[0] > maisLonge - 1).map((p) => p[1]);
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(4.3);
    });

    it('crista marginal da IA só vale em dente posterior', () => {
      const resposta = { cuspides: [{ nome: 'a', u: 0, w: 0, h: 1 }], cristas: [{ de: [0, 0], ate: [1, 1], lado: 'mesial' }, { de: [0, 0], ate: [1, 1], lado: 'nenhum' }] };
      expect(validarPlano(resposta, 16).cristas.map((c) => c.lado)).toEqual(['mesial', undefined]);
      expect(validarPlano(resposta, 11).cristas.map((c) => c.lado)).toEqual([undefined, undefined]);
    });

    it('a largura VL se aproxima da natural, sem passar do bojo de um dente natural', () => {
      const base = planoPadrao(16);
      const vl = (vlMm: number) => casoPronto(null).construirComPlano({ ...base, vlMm }, PARAMETROS).relatorio.vlMm;
      const natural = vl(base.vlMm);
      const pedeMais = vl(13);
      const pedeMenos = vl(6);
      expect(pedeMais).toBeGreaterThan(natural + 0.3);
      expect(pedeMenos).toBeLessThan(natural - 0.3);
      // O bojo vai de 0,5 mm a 1,7 mm somando os dois lados: não adianta pedir além disso.
      expect(pedeMais - pedeMenos).toBeLessThanOrEqual(1.3);
    });

    it('os sulcos entram mesmo na coroa, sem quebrar a espessura', () => {
      const comSulcos = casoPronto(null).construirComPlano(planoPadrao(16), PARAMETROS);
      const semSulcos = casoPronto(null).construirComPlano({ ...planoPadrao(16), sulcos: [] }, PARAMETROS);
      expect(comSulcos.relatorio.malha.volume).toBeLessThan(semSulcos.relatorio.malha.volume - 0.5);
      expect(comSulcos.relatorio.espessuraOclusal!.p5).toBeGreaterThanOrEqual(PARAMETROS.espessuraOclusal - 0.05);
      expect(comSulcos.relatorio.malha.arestasAbertas).toBe(0);
    });

    it('a crista marginal acompanha a altura do vizinho', () => {
      const vizinho = (x: number, topo: number) => revolucao(denso([[0, topo], [3, topo - 0.4], [3.4, 3], [3.8, 0]]), 36, 1, 1, [x, 0, 0]);
      const alturaNaBorda = (topo: number) => {
        const s = new Sessao({ meridianos: 60, linhas: 40 });
        s.abrirArco('arco.stl', escreverStl(juntar(arcoSintetico(), vizinho(8.6, topo), vizinho(-8.6, topo)), 'arco'));
        const h = s.apontar([0.3, 0.2, 20], [0, 0, -1]);
        s.abrirDente(16, h!.ponto, h!.normal);
        const c = s.construirComPlano(planoPadrao(16), PARAMETROS);
        let maior = -Infinity;
        for (let v = 0; v < c.externos; v++) {
          if (Math.abs(c.malha.pos[3 * v]) > 3.6 && Math.abs(c.malha.pos[3 * v + 1]) < 0.8) maior = Math.max(maior, c.malha.pos[3 * v + 2]);
        }
        return maior;
      };
      // Vizinho baixo pede pouca correção; o alto, a maior que o motor faz. Sem o alinhamento, seriam iguais.
      expect(alturaNaBorda(8.6)).toBeGreaterThan(alturaNaBorda(6.4) + 0.25);
    });

    it('o contato com o vizinho entra só a sobreposição pedida, pelo plano também', () => {
      const vizinho = (x: number) => revolucao(denso([[0, 8], [3, 7.6], [3.4, 3], [3.8, 0]]), 36, 1, 1, [x, 0, 0]);
      const menorFolga = (folgaVizinho: number) => {
        const s = new Sessao({ meridianos: 60, linhas: 40 });
        s.abrirArco('arco.stl', escreverStl(juntar(arcoSintetico(), vizinho(8.6), vizinho(-8.6)), 'arco'));
        const h = s.apontar([0.3, 0.2, 20], [0, 0, -1]);
        s.abrirDente(16, h!.ponto, h!.normal);
        const c = s.construirComPlano(planoPadrao(16), { ...PARAMETROS, folgaVizinho });
        return Math.min(...Array.from(c.folgaVizinho.subarray(0, c.externos)).filter(Number.isFinite));
      };
      const comSobreposicao = menorFolga(-0.03);
      expect(comSobreposicao).toBeGreaterThan(-0.06);
      expect(comSobreposicao).toBeLessThan(0.1);
      expect(menorFolga(0.1)).toBeGreaterThan(0.07);
    });
  });

  describe('resposta da IA', () => {
    it('aceita pontos como objeto, que é o formato da resposta', () => {
      const p = validarPlano(
        {
          cuspides: [{ nome: 'a', u: 0.5, w: 0.5, h: 1 }],
          cristas: [{ de: { u: 0, w: 0 }, ate: { u: 0.5, w: 0.5 }, hDe: 0.8, hMeio: 0.7, hAte: 0.9, largura: 1 }],
          sulcos: [{ pontos: [{ u: 0, w: 0, prof: 0.3 }, { u: 0.4, w: 0, prof: 0.2 }] }],
          centro: { u: 0.1, w: 0.1 },
        },
        16,
      );
      expect(p.cristas[0].de).toEqual([0, 0]);
      expect(p.sulcos[0].pontos[1]).toEqual([0.4, 0, 0.2]);
      expect(p.centro).toEqual([0.1, 0.1]);
    });

    it.each([[null], ['texto'], [42], [{}], [{ cuspides: [] }], [{ cuspides: 'nada' }], [{ cuspides: [{ u: 'x' }] }]])('resposta sem cúspide válida (%j) fica com o desenho de partida', (bruto) => {
      expect(validarPlano(bruto, 16).cuspides).toEqual(planoPadrao(16).cuspides);
    });

    it('número absurdo é trazido para dentro do limite', () => {
      const p = validarPlano(
        {
          cuspides: [{ nome: 'a', u: 99, w: -99, h: 50 }],
          cristas: [{ de: [50, 50], ate: [-50, -50], hDe: 9, hMeio: -9, hAte: 1, largura: 100 }],
          sulcos: [{ pontos: [[0, 0, 99], [1, 1, -5]] }],
          centro: [9, -9],
          alturaMm: 999,
          bojoVestibular: 99,
          bojoLingual: -1,
          contornoVestibular: 99,
          contornoLingual: -1,
          mesa: 7,
        },
        16,
      );
      expect(p.cuspides[0]).toEqual({ nome: 'a', u: 0.95, w: -0.95, h: 1.05 });
      expect(p.cristas[0].largura).toBe(1.3);
      expect(p.sulcos[0].pontos[0][2]).toBe(1);
      expect(p.sulcos[0].pontos[1][2]).toBe(0);
      expect(p.centro).toEqual([0.5, -0.5]);
      expect(p.alturaMm).toBeCloseTo(planoPadrao(16).alturaMm * 1.2);
      expect(p.bojoVestibular).toBe(0.7);
      expect(p.bojoLingual).toBe(0.3);
      expect(p.mesa).toBe(0.95);
    });

    it('crista não sobe além das cúspides: viraria uma torre no meio do dente', () => {
      const p = validarPlano(
        { cuspides: [{ nome: 'a', u: 0, w: 0.4, h: 0.6 }, { nome: 'b', u: 0, w: -0.4, h: 0.5 }], cristas: [{ de: [0, 0], ate: [0.5, 0.5], hDe: 1.05, hMeio: 1.05, hAte: 1.05, largura: 1 }] },
        16,
      );
      expect(p.cristas[0].hMeio).toBeCloseTo(0.63);
    });

    it('cúspides todas achatadas não formam dente: fica a forma de partida', () => {
      const p = validarPlano({ cuspides: [{ nome: 'a', u: 0, w: 0, h: 0.2 }], cristas: [{ de: [0, 0], ate: [1, 1], hDe: 1, hMeio: 1, hAte: 1, largura: 1 }] }, 16);
      expect(p.cuspides).toEqual(planoPadrao(16).cuspides);
      expect(p.cristas).toEqual(planoPadrao(16).cristas);
    });

    it('a altura de um plano baixo não é esticada até a altura natural', () => {
      const base = planoPadrao(16);
      const baixo = validarPlano({ ...base, cuspides: base.cuspides.map((k) => ({ ...k, h: k.h * 0.6 })) }, 16);
      const c = casoPronto(null).construirComPlano(baixo, PARAMETROS);
      // Até onde o preparo deixa: abaixo disso quem manda é a espessura sobre ele.
      expect(c.relatorio.alturaMm).toBeLessThan(casoPronto(null).construirComPlano(base, PARAMETROS).relatorio.alturaMm - 0.3);
      expect(c.relatorio.malha.arestasAbertas).toBe(0);
    });

    it('NaN e infinito não entram', () => {
      const p = validarPlano({ cuspides: [{ nome: 'a', u: NaN, w: 0, h: 1 }, { nome: 'b', u: 0, w: Infinity, h: 1 }, { nome: 'c', u: 0, w: 0, h: 1 }], alturaMm: NaN }, 16);
      expect(p.cuspides.map((c) => c.nome)).toEqual(['c']);
      expect(p.alturaMm).toBe(planoPadrao(16).alturaMm);
    });

    it('lista enorme é cortada', () => {
      const muitas = Array.from({ length: 500 }, (_, i) => ({ nome: 'x', u: 0, w: i / 1000, h: 1 }));
      const p = validarPlano({ cuspides: muitas, cristas: Array.from({ length: 500 }, () => ({ de: [0, 0], ate: [1, 1] })), sulcos: Array.from({ length: 500 }, () => ({ pontos: Array.from({ length: 500 }, () => [0, 0, 0.1]) })) }, 16);
      expect(p.cuspides.length).toBeLessThanOrEqual(6);
      expect(p.cristas.length).toBeLessThanOrEqual(16);
      expect(p.sulcos.length).toBeLessThanOrEqual(16);
      expect(p.sulcos[0].pontos.length).toBeLessThanOrEqual(12);
    });

    it('nome com texto enorme é cortado', () => {
      const p = validarPlano({ cuspides: [{ nome: 'x'.repeat(500), u: 0, w: 0, h: 1 }] }, 16);
      expect(p.cuspides[0].nome.length).toBe(40);
    });

    it('mesmo com o pior plano aceito, a coroa sai fechada e sem entrar no antagonista', () => {
      const pior = validarPlano(
        {
          cuspides: [{ nome: 'a', u: 0.95, w: 0.95, h: 1.05 }, { nome: 'b', u: -0.95, w: -0.95, h: 0.2 }],
          cristas: [{ de: [1, 1], ate: [-1, -1], hDe: 1.05, hMeio: 0.2, hAte: 1.05, largura: 0.4 }],
          sulcos: [{ pontos: [[-1, 0, 0.8], [1, 0, 0.8]] }, { pontos: [[0, -1, 0.8], [0, 1, 0.8]] }],
          bojoVestibular: 1.2,
          bojoLingual: 0.1,
          mesa: 0.5,
        },
        16,
      );
      const c = casoPronto(antagonistaPlano(9)).construirComPlano(pior, PARAMETROS);
      expect(c.relatorio.malha.arestasAbertas).toBe(0);
      expect(c.relatorio.malha.arestasRepetidas).toBe(0);
      const folgas = Array.from(c.folgaAntagonista.subarray(0, c.externos)).filter(Number.isFinite);
      expect(Math.min(...folgas)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('o que vai para a IA', () => {
    it('só o número do dente e medidas: mapas 11 × 11, sem nenhum dado da malha', () => {
      const q = casoPronto(antagonistaPlano(9)).quadroParaIa(PARAMETROS);
      expect(q.fdi).toBe(16);
      expect(Object.keys(q).sort()).toEqual(['fdi', 'mapaAntagonista', 'mapaPreparo', 'medidas', 'planoInicial']);
      expect(q.mapaAntagonista).toHaveLength(11);
      expect(q.mapaPreparo).toHaveLength(11);
      for (const linha of [...q.mapaAntagonista, ...q.mapaPreparo]) {
        expect(linha).toHaveLength(11);
        for (const v of linha) expect(v === null || typeof v === 'number').toBe(true);
      }
      // O texto todo cabe numa mensagem pequena: não há como carregar um escaneamento aqui.
      expect(JSON.stringify(q).length).toBeLessThan(8000);
    });

    it('sem antagonista, o mapa dele vem vazio', () => {
      const q = casoPronto(null).quadroParaIa(PARAMETROS);
      expect(q.mapaAntagonista.flat().every((v) => v === null)).toBe(true);
      expect(q.mapaPreparo.flat().some((v) => v !== null)).toBe(true);
    });

    it('fora da margem o mapa do preparo fica vazio: lá o raio pegaria o vizinho', () => {
      const q = casoPronto(null).quadroParaIa(PARAMETROS);
      expect(q.mapaPreparo[0][0]).toBeNull();
      expect(q.mapaPreparo[10][10]).toBeNull();
    });

    it('pedir o quadro antes do preparo dá erro claro', () => {
      expect(() => new Sessao().quadroParaIa(PARAMETROS)).toThrow(/Faltam/);
    });
  });
});

describe('Passos CAD — o que a tela não pode fazer', () => {
  const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
  const PASTA = path.join(RAIZ, 'apps/web/src/app/atendimento/passos-cad');
  const arquivos = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? arquivos(path.join(d, e.name)) : [path.join(d, e.name)]));

  // Pelo caminho inteiro: outro arquivo com o mesmo nome, em subpasta, não pode herdar a exceção.
  const EXCECAO_DE_REDE = path.join(PASTA, 'clientes-do-cadastro.ts');
  const EXCECAO_DA_IA = path.join(PASTA, 'desenho-com-ia.ts');

  it('não manda arquivo para fora do computador: nenhuma chamada de rede', () => {
    for (const f of arquivos(PASTA)) {
      if (f === EXCECAO_DE_REDE || f === EXCECAO_DA_IA) continue;
      const src = fs.readFileSync(f, 'utf8');
      expect([path.basename(f), /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|axios|lib\/api\b/.test(src)]).toEqual([path.basename(f), false]);
    }
  });

  it('a única exceção de rede só lê a lista de nomes e não recebe nada do caso', () => {
    const src = fs.readFileSync(EXCECAO_DE_REDE, 'utf8');
    expect(src.match(/^import .*$/gm)).toEqual(["import api from '@/lib/api';"]);
    expect(src.match(/\bapi\.\w+/g)).toEqual(['api.get']);
    // A linha inteira: nem corpo, nem cabeçalho, nem parâmetro a mais.
    expect(src).toContain("api.get<unknown>('/patients/nomes', { signal: sinal, ...EM_SEGUNDO_PLANO })");
    expect(src).toContain('const EM_SEGUNDO_PLANO = { _silent401: true } as object;');
    expect(src).toContain('buscarClientesDoCadastro(sinal: AbortSignal)');
    expect(src.match(/\bexport\b/g)).toHaveLength(1);
    expect(src).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|axios|params|FormData|`/);
    const quemUsa = arquivos(PASTA)
      .filter((f) => f !== EXCECAO_DE_REDE && /clientes-do-cadastro/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.basename(f));
    expect(quemUsa).toEqual(['CampoCliente.tsx']);
  });

  it('a exceção da IA manda só o pedido de medidas, para a rota certa', () => {
    const src = fs.readFileSync(EXCECAO_DA_IA, 'utf8');
    expect(src.match(/^import .*$/gm)).toEqual(["import api from '@/lib/api';", "import type { PedidoDesenhoIa } from './motor/plano-do-dente';"]);
    expect(src.match(/\bapi\.\w+/g)).toEqual(['api.post']);
    expect(src).toContain("api.post<{ plano: unknown }>('/passos-cad/desenho-ia', pedido, SEM_DERRUBAR_O_CASO)");
    expect(src).toContain('pedirDesenhoIa(pedido: PedidoDesenhoIa)');
    expect(src).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|axios|FormData|`/);
    const quemUsa = arquivos(PASTA)
      .filter((f) => f !== EXCECAO_DA_IA && /desenho-com-ia/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.basename(f));
    expect(quemUsa).toEqual(['PassosCadApp.tsx']);
  });

  it('o pedido à IA só tem número do dente e medidas: nenhum campo de arquivo ou da ficha', () => {
    const src = fs.readFileSync(path.join(PASTA, 'motor/plano-do-dente.ts'), 'utf8');
    const tipo = src.slice(src.indexOf('export interface PedidoDesenhoIa'), src.indexOf('export interface Cuspide'));
    for (const proibido of ['pos', 'tri', 'malha', 'Malha', 'buf', 'cliente', 'numero', 'nomeDoCaso', 'tecnico', 'notas', 'string']) {
      expect([proibido, new RegExp(`\\b${proibido}\\b`).test(tipo)]).toEqual([proibido, false]);
    }
  });

  it('o worker segue sem rede: quem chama a IA é a tela, com o que o motor mediu', () => {
    const src = fs.readFileSync(path.join(PASTA, 'motor/worker.ts'), 'utf8');
    expect(src).not.toMatch(/desenho-com-ia|@\/lib\/api|\bfetch\s*\(/);
  });

  it('o visor 3D carrega só nesta tela', () => {
    const app = fs.readFileSync(path.join(PASTA, 'page.tsx'), 'utf8');
    expect(app).toContain("dynamic(() => import('./PassosCadApp'), { ssr: false })");
    const fora = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return p === PASTA || e.name === 'node_modules' ? [] : fora(p);
      return /\.tsx?$/.test(e.name) && /from 'three'/.test(fs.readFileSync(p, 'utf8')) ? [p] : [];
    });
    expect(fora(path.join(RAIZ, 'apps/web/src'))).toEqual([]);
  });

  it('a Tela ao vivo não vê o paciente do caso, as observações nem o nome dos arquivos', () => {
    // O rrweb só mascara senha; o resto sai em claro, e o nome do escaneamento costuma ter o do paciente.
    const ficha = fs.readFileSync(path.join(PASTA, 'FichaDoCaso.tsx'), 'utf8');
    expect(ficha).toMatch(/data-testid="caso-nome" data-rr-is-password/);
    expect(ficha).toMatch(/data-testid="caso-notas" data-rr-is-password/);
    expect(ficha).toContain("nome ? 'truncate rr-mask' : 'truncate'");
    const app = fs.readFileSync(path.join(PASTA, 'PassosCadApp.tsx'), 'utf8');
    expect(app).toContain("nome ? 'truncate rr-mask' : 'truncate'");
    expect(app).toMatch(/rotulo === T\.fichaPaciente \|\| rotulo === T\.fichaNotas \? ' rr-mask'/);
  });

  it('o que a tela lembra no navegador é da conta: duas contas não se enxergam', () => {
    const src = fs.readFileSync(path.join(PASTA, 'motor/conta.ts'), 'utf8');
    expect(src).toMatch(/decodeJwtPayload\(.*\)\?\.tenant_id/);
    expect(fs.readFileSync(path.join(PASTA, 'ficha.ts'), 'utf8')).toContain('`passos-cad-recentes-${contaDoNavegador()}`');
  });

  it('no Início, o atalho segue o setor visto, não o da pessoa', () => {
    const src = fs.readFileSync(path.join(RAIZ, 'apps/web/src/components/home/LabInicio.tsx'), 'utf8');
    expect(src).toContain('canAccessRouteBt(PASSOS_CAD, temNoSetorVisto, BT_LABORATORIO)');
    expect(src).toContain('permissoesDoVisto.has(p)');
  });

  it('mudar arcada, antagonista, dente ou margem tira a coroa antiga da tela', () => {
    const src = fs.readFileSync(path.join(PASTA, 'PassosCadApp.tsx'), 'utf8');
    expect(src).toMatch(/const abrirArquivo[\s\S]{0,420}descartarDente\(\);/);
    expect(src).toMatch(/setFdi\(n\);\s*descartarDente\(\);/);
    expect((src.match(/tipo: 'margem'[^\n]*\n\s*descartarCoroa\(\);/g) ?? []).length).toBe(2);
  });

  it('cálculo que morre sem avisar não trava a tela', () => {
    const src = fs.readFileSync(path.join(PASTA, 'motor/cliente.ts'), 'utf8');
    expect(src).toContain('this.worker.onmessageerror');
    expect(src).toMatch(/relogio: setTimeout\(\(\) => this\.falharTudo\(\), TEMPO_MAXIMO\)/);
  });

  it('a clínica não vê: a tela confere o tipo da conta e o menu só existe no laboratório', () => {
    expect(fs.readFileSync(path.join(PASTA, 'page.tsx'), 'utf8')).toMatch(/if \(!lab\) \{\s*return <div[^>]*>\{TEXTOS\.telaFechada\}<\/div>;/);
    const menu = fs.readFileSync(path.join(RAIZ, 'apps/web/src/components/Sidebar.tsx'), 'utf8');
    expect(menu).toContain("show: lab && hasPermission('create_evaluation'),");
    expect(menu).toMatch(/\.\.\.\(lab\s*\? \[\{\s*id: 'producao'/);
  });
});
