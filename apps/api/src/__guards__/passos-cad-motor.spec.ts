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

function preparoEMargem() {
  const arco = arcoSintetico();
  const b = new Bvh(arco);
  const prep = acharPreparo(b, [0.3, 0.2, 6], [0, 0, 1]);
  const margem = proporMargem(b, prep, { meridianos: 60 });
  return { arco, b, prep, margem };
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

describe('Passos CAD — o que a tela não pode fazer', () => {
  const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
  const PASTA = path.join(RAIZ, 'apps/web/src/app/atendimento/passos-cad');
  const arquivos = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? arquivos(path.join(d, e.name)) : [path.join(d, e.name)]));

  it('não manda arquivo para fora do computador: nenhuma chamada de rede', () => {
    for (const f of arquivos(PASTA)) {
      const src = fs.readFileSync(f, 'utf8');
      expect([path.basename(f), /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|axios|from '@\/lib\/api'/.test(src)]).toEqual([path.basename(f), false]);
    }
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

  it('a clínica não vê: a tela confere o tipo da conta e o menu só existe no laboratório', () => {
    expect(fs.readFileSync(path.join(PASTA, 'page.tsx'), 'utf8')).toMatch(/if \(!lab\) \{\s*return <div[^>]*>\{TEXTOS\.telaFechada\}<\/div>;/);
    const menu = fs.readFileSync(path.join(RAIZ, 'apps/web/src/components/Sidebar.tsx'), 'utf8');
    expect(menu).toContain("show: lab && hasPermission('create_evaluation'),");
    expect(menu).toMatch(/\.\.\.\(lab\s*\? \[\{\s*id: 'producao'/);
  });
});
