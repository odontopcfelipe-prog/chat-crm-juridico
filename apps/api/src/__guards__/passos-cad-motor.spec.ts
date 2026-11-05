/**
 * Passos CAD — o motor da coroa (roda no navegador do técnico; aqui com geometria sintética,
 * porque este repositório é público e não pode ter escaneamento nem biblioteca de dentes).
 * E as travas do que a tela não pode fazer: subir arquivo para a API e aparecer na clínica.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Bvh, conferirMalha, cross, dot, juntar, norma, sub, unit, vert, type Malha, type V3 } from '../../../web/src/app/atendimento/passos-cad/motor/geo';
import { ArquivoRecusado, escreverStl, lerMalha, lerObj, lerOffBinario, lerPly, lerStl } from '../../../web/src/app/atendimento/passos-cad/motor/arquivos';
import { acharPreparo, conferirMargem, proporMargem, type PontoMargem } from '../../../web/src/app/atendimento/passos-cad/motor/margem';
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
import { chaveDoDente, denteDoFdi, indexarPasta } from '../../../web/src/app/atendimento/passos-cad/motor/biblioteca-indice';
import { Sessao } from '../../../web/src/app/atendimento/passos-cad/motor/sessao';
import { Escultor, type ModoPincel } from '../../../web/src/app/atendimento/passos-cad/motor/escultura';
import { compensarFresa, contarSemAlcance, normalizarBroca } from '../../../web/src/app/atendimento/passos-cad/motor/fresa';
import { ALTURA_DO_ARCO, LARGURA_DO_ARCO, dentesDoArco } from '../../../web/src/app/atendimento/passos-cad/arco-dos-dentes';
import { juntarRecente, nomesDoCadastro, opcoesDeCliente } from '../../../web/src/app/atendimento/passos-cad/ficha';
import { planoPadrao, validarPlano } from '../../../web/src/app/atendimento/passos-cad/motor/plano-do-dente';

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

  const off = () => {
    const c = Buffer.from('OFF BINARY\n');
    const h = Buffer.alloc(12);
    h.writeUInt32LE(3, 0);
    h.writeUInt32LE(1, 4);
    const p = Buffer.alloc(36);
    [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((x, i) => p.writeFloatLE(x, i * 4));
    const f = Buffer.alloc(14);
    f.writeUInt16LE(3, 0);
    [0, 1, 2].forEach((id, k) => f.writeUInt32LE(id, 2 + k * 4));
    return Buffer.concat([c, h, p, f]);
  };

  it('OFF binário das bibliotecas', () => {
    const r = lerOffBinario(paraBuffer(off()));
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
    expect(() => lerOffBinario(paraBuffer(Buffer.from('drmSDFA10 conteudo cifrado')))).toThrow(ArquivoRecusado);
    expect(() => lerOffBinario(paraBuffer(off().subarray(0, 40)))).toThrow(ArquivoRecusado);
    expect(() => lerMalha('dente.sdfa', new ArrayBuffer(8))).toThrow(ArquivoRecusado);
    const com = Buffer.from('ply\nformat binary_little_endian 1.0\ncomment encrypted\nelement vertex 1\nproperty float x\nend_header\n');
    expect(() => lerPly(paraBuffer(com))).toThrow(ArquivoRecusado);
  });
});

describe('Passos CAD — pasta de bibliotecas', () => {
  const f = (caminho: string) => ({ name: caminho.split('/').pop() as string, webkitRelativePath: caminho });

  it('acha dentes por arcada e posição, prefere .eoff e ignora o que não é dente', () => {
    const r = indexarPasta([
      f('Bib/teeth/Autor A/upperjaw/6.stl'),
      f('Bib/teeth/Autor A/upperjaw/6.eoff'),
      f('Bib/teeth/Autor A/lowerjaw/1.eoff'),
      f('Bib/teeth/Autor A/upperjaw/._6.eoff'),
      f('Bib/pontics/Autor A/upperjaw/2.eoff'),
      f('Bib/metadata/Autor A/upperjaw/3.eoff'),
      f('Bib/teeth/Autor A/upperjaw/9.eoff'),
      f('Bib/teeth/Protegida/lowerjaw/2.drmsdfa'),
      f('Bib/teeth/Protegida/lowerjaw/3.sdfa'),
    ]);
    expect(r.map((b) => b.nome)).toEqual(['Autor A', 'Protegida']);
    const a = r[0];
    expect([...a.dentes.keys()].sort()).toEqual(['inferior1', 'superior6']);
    expect(a.dentes.get('superior6')?.name).toBe('6.eoff');
    expect(a.protegida).toBe(false);
    expect(r[1].dentes.size).toBe(0);
    expect(r[1].protegida).toBe(true);
  });

  it('número FDI vira arcada e posição', () => {
    expect(denteDoFdi(16)).toEqual({ arcada: 'superior', posicao: 6 });
    expect(denteDoFdi(25)).toEqual({ arcada: 'superior', posicao: 5 });
    expect(denteDoFdi(36)).toEqual({ arcada: 'inferior', posicao: 6 });
    expect(denteDoFdi(41)).toEqual({ arcada: 'inferior', posicao: 1 });
    expect(chaveDoDente('superior', 6)).toBe('superior6');
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
      expect(menor).toBeGreaterThan(-0.02);
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
      expect(menor).toBeGreaterThan(-0.02);
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
  const dentes = dentesDoArco();
  const de = (fdi: number) => dentes.find((d) => d.fdi === fdi) as (typeof dentes)[number];

  it('a arcada tem os 32 dentes, uma vez cada', () => {
    const esperados: number[] = [];
    for (const q of [1, 2, 3, 4]) for (let n = 1; n <= 8; n++) esperados.push(q * 10 + n);
    expect(dentes.map((d) => d.fdi).sort((a, b) => a - b)).toEqual(esperados);
  });

  it('cada quadrante fica no seu lugar: 1 em cima à esquerda, 2 à direita, 3 embaixo à direita, 4 à esquerda', () => {
    const meioX = LARGURA_DO_ARCO / 2;
    const meioY = ALTURA_DO_ARCO / 2;
    for (const d of dentes) {
      const q = Math.floor(d.fdi / 10);
      expect([d.fdi, d.x < meioX]).toEqual([d.fdi, q === 1 || q === 4]);
      expect([d.fdi, d.y < meioY]).toEqual([d.fdi, q === 1 || q === 2]);
      expect(d.x - d.largura / 2).toBeGreaterThan(-20);
      expect(d.x + d.largura / 2).toBeLessThan(LARGURA_DO_ARCO + 20);
    }
    // Os centrais colados na linha média, em cima e embaixo; os sisos no meio da altura.
    expect(meioX - de(11).x).toBeLessThan(de(11).largura);
    expect(de(21).x - meioX).toBeLessThan(de(21).largura);
    expect(de(11).y).toBeLessThan(de(18).y);
    expect(de(41).y).toBeGreaterThan(de(48).y);
    expect(de(48).y).toBeGreaterThan(de(18).y);
  });

  it('os dois lados são espelho um do outro', () => {
    for (let n = 1; n <= 8; n++) {
      for (const [e, d] of [[10, 20], [40, 30]]) {
        expect(de(e + n).x + de(d + n).x).toBeCloseTo(LARGURA_DO_ARCO, 6);
        expect(de(e + n).y).toBeCloseTo(de(d + n).y, 6);
        expect(de(e + n).largura).toBeCloseTo(de(d + n).largura, 6);
      }
    }
  });

  it('um dente não cobre o vizinho na mesma arcada', () => {
    for (const q of [1, 2, 3, 4]) {
      for (let n = 1; n < 8; n++) {
        const a = de(q * 10 + n);
        const b = de(q * 10 + n + 1);
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(0.85 * (a.largura + b.largura) / 2);
      }
    }
    // Os dois centrais de cada arcada também não se cruzam.
    expect(de(21).x - de(11).x).toBeGreaterThanOrEqual((de(11).largura + de(21).largura) / 2 * 0.85);
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
      expect(p.sulcos[0].pontos[0][2]).toBe(0.8);
      expect(p.sulcos[0].pontos[1][2]).toBe(0);
      expect(p.centro).toEqual([0.5, -0.5]);
      expect(p.alturaMm).toBeCloseTo(planoPadrao(16).alturaMm * 1.2);
      expect(p.bojoVestibular).toBe(1.2);
      expect(p.bojoLingual).toBe(0.1);
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
      expect(c.relatorio.alturaMm).toBeLessThan(base.alturaMm * 0.85);
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
      expect(p.sulcos.length).toBeLessThanOrEqual(8);
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

  it('a biblioteca guardada no navegador é da conta: duas contas não se enxergam', () => {
    const src = fs.readFileSync(path.join(PASTA, 'motor/biblioteca.ts'), 'utf8');
    expect(src).toContain('indexedDB.open(nomeDoBanco(), 1)');
    expect(src).toMatch(/decodeJwtPayload\(.*\)\?\.tenant_id/);
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
