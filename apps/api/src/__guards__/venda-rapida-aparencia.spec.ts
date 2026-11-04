/**
 * Venda rápida — Edição básica (web: venda-rapida/aparencia.ts).
 *
 * O web não tem test runner: este spec carrega o arquivo puro do web pelo compilador do
 * TypeScript. Errar aqui deixa o texto ilegível na cor que o dono escolher, ou muda o visual
 * de quem nunca abriu a edição.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
const ARQ = 'apps/web/src/app/atendimento/venda-rapida/aparencia.ts';
const FONTE = fs.readFileSync(path.join(RAIZ, ARQ), 'utf8');

function carregar(): any {
  const js = ts.transpileModule(FONTE, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const modulo = { exports: {} as any };
  new Function('module', 'exports', js)(modulo, modulo.exports);
  return modulo.exports;
}

const a = carregar();
const ESCURO = 'rgba(0, 0, 0, 0.9)';
const CLARO = '#ffffff';

describe('normalizarAparencia', () => {
  it.each([[null], [undefined], ['texto'], [12], [[]], [{}]])('%p vira o padrão', (bruto) => {
    expect(a.normalizarAparencia(bruto)).toEqual(a.APARENCIA_PADRAO);
  });

  it('fica com o que vale e põe o padrão só no que não vale', () => {
    expect(a.normalizarAparencia({
      cor_cabecalho: '#123ABC',
      cor_produtos: 'vermelho',
      cor_destaque: '#fff',
      cor_rodape: 7,
      tamanho_foto: 'gigante',
    })).toEqual({ ...a.APARENCIA_PADRAO, cor_cabecalho: '#123abc' });
  });

  it('não deixa passar nada que possa virar CSS', () => {
    expect(a.normalizarAparencia({ cor_rodape: 'url(https://x.y/z)' }).cor_rodape).toBe(a.APARENCIA_PADRAO.cor_rodape);
    expect(a.normalizarAparencia({ cor_rodape: '#000000;color:red' }).cor_rodape).toBe(a.APARENCIA_PADRAO.cor_rodape);
  });

  it.each([['pequeno'], ['medio'], ['grande']])('aceita o tamanho %s', (tamanho) => {
    expect(a.normalizarAparencia({ tamanho_foto: tamanho }).tamanho_foto).toBe(tamanho);
  });
});

describe('textoSobre', () => {
  it.each([['#ffe600'], ['#ffffff'], ['#ebebeb'], ['#fde68a']])('fundo claro %s pede texto escuro', (cor) => {
    expect(a.textoSobre(cor)).toBe(ESCURO);
  });

  it.each([['#000000'], ['#2d3277'], ['#1f2937'], ['#7c3aed']])('fundo escuro %s pede texto claro', (cor) => {
    expect(a.textoSobre(cor)).toBe(CLARO);
  });
});

describe('varsDaAparencia', () => {
  it('no padrão, o visual de sempre: a faixa amarela se desfaz no cinza e o título é marinho', () => {
    const v = a.varsDaAparencia(a.APARENCIA_PADRAO);
    expect(v['--vr-fundo-conteudo']).toBe('linear-gradient(180deg, #ffe600 0, #ebebeb 170px)');
    expect(v['--vr-marca-cabecalho']).toBe('#2d3277');
    expect(v['--vr-texto-cabecalho']).toBe(ESCURO);
  });

  it.each([
    [{ cor_produtos: '#1f2937' }],
    [{ cor_cabecalho: '#7c3aed' }],
  ])('com cor escolhida (%j), cada parte fica com a sua, sem degradê', (mudanca) => {
    const aparencia = { ...a.APARENCIA_PADRAO, ...mudanca };
    expect(a.varsDaAparencia(aparencia)['--vr-fundo-conteudo']).toBe(aparencia.cor_produtos);
  });

  it('cabeçalho escuro: título e texto claros, e o número da etapa escuro sobre o círculo claro', () => {
    const v = a.varsDaAparencia({ ...a.APARENCIA_PADRAO, cor_cabecalho: '#111827' });
    expect(v['--vr-texto-cabecalho']).toBe(CLARO);
    expect(v['--vr-marca-cabecalho']).toBe(CLARO);
    expect(v['--vr-contra-cabecalho']).toBe('#1a1a1a');
  });
});

describe('partes e tamanhos', () => {
  it('as 4 partes, na ordem da tela', () => {
    expect(a.PARTES.map((p: any) => p.campo)).toEqual(['cor_cabecalho', 'cor_produtos', 'cor_destaque', 'cor_rodape']);
  });

  it('o tamanho padrão é o de antes da edição', () => {
    expect(a.APARENCIA_PADRAO.tamanho_foto).toBe('medio');
    expect(a.TAMANHOS.medio).toMatchObject({ grade: 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4', foto: 'h-28', icone: 44 });
  });

  it('o arquivo continua sem import, para este spec conseguir carregá-lo', () => {
    expect(FONTE).not.toMatch(/^\s*import\s/m);
  });
});
