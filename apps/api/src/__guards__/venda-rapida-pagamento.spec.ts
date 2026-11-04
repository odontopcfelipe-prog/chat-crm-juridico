/**
 * Venda rápida — regras do pagamento em lista (web: venda-rapida/pagamento-balcao.ts).
 *
 * O web não tem test runner: este spec carrega o arquivo puro do web pelo compilador do
 * TypeScript (o arquivo não tem import) e confere o que vai para o POST /venda-rapida/balcao.
 * Errar aqui lança na conta errada do caixa ou grava "1x" no que passou em 3x.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
const ARQ = 'apps/web/src/app/atendimento/venda-rapida/pagamento-balcao.ts';

function carregar(): any {
  const fonte = fs.readFileSync(path.join(RAIZ, ARQ), 'utf8');
  const js = ts.transpileModule(fonte, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const modulo = { exports: {} as any };
  new Function('module', 'exports', js)(modulo, modulo.exports);
  return modulo.exports;
}

const p = carregar();
const TOTAL = 95000;

/** Uma forma só, valor cheio. */
const umaForma = (forma: string, extra: Record<string, unknown> = {}) => ({
  ...p.PAGAMENTO_VAZIO,
  atual: { ...p.ESCOLHA_VAZIA, forma, ...extra },
});

/** Duas formas: fecha a primeira com o valor digitado e escolhe a segunda. */
function duasFormas(valor: string, primeira: Record<string, unknown>, segunda: Record<string, unknown>) {
  const inicio = { ...p.ligarDuasFormas(), valorPrimeira: valor, atual: { ...p.ESCOLHA_VAZIA, ...primeira } };
  const fechada = p.fecharPrimeira(inicio, TOTAL);
  return { ...fechada, atual: { ...p.ESCOLHA_VAZIA, ...segunda } };
}

const payments = (estado: any) => p.paraPayments(p.analisar(estado, TOTAL).linhas);

describe('venda rápida — o que vai para o servidor', () => {
  it.each([
    ['dinheiro', umaForma('DINHEIRO'), [{ method: 'DINHEIRO', value: 950 }]],
    ['PIX na chave', umaForma('PIX', { localPix: 'CHAVE' }), [{ method: 'PIX', value: 950 }]],
    ['PIX na maquineta', umaForma('PIX', { localPix: 'MAQUINETA' }), [{ method: 'PIX_MAQUININHA', value: 950 }]],
    ['débito', umaForma('DEBITO'), [{ method: 'CARTAO', value: 950, debit: true }]],
    ['crédito à vista', umaForma('CREDITO', { parcelas: 1 }), [{ method: 'CARTAO', value: 950, installments: 1 }]],
    ['crédito 3x', umaForma('CREDITO', { parcelas: 3 }), [{ method: 'CARTAO', value: 950, installments: 3 }]],
  ])('%s', (_nome, estado, esperado) => {
    expect(p.analisar(estado, TOTAL).acao).toBe('FINALIZAR');
    expect(payments(estado)).toEqual(esperado);
  });

  it('divide: a primeira leva o digitado e a segunda leva o resto', () => {
    const estado = duasFormas('100,50', { forma: 'PIX', localPix: 'CHAVE' }, { forma: 'DINHEIRO' });
    expect(payments(estado)).toEqual([
      { method: 'PIX', value: 100.5 },
      { method: 'DINHEIRO', value: 849.5 },
    ]);
    expect(p.analisar(estado, TOTAL).faltaCentavos).toBe(0);
  });

  it('2 cartões são 2 formas, cada um com o seu tipo', () => {
    const estado = duasFormas('500', { forma: 'DEBITO' }, { forma: 'CREDITO', parcelas: 6 });
    expect(payments(estado)).toEqual([
      { method: 'CARTAO', value: 500, debit: true },
      { method: 'CARTAO', value: 450, installments: 6 },
    ]);
  });

  it('nunca manda parcelas fora do crédito nem débito fora do cartão', () => {
    const todos = [
      ...payments(umaForma('DINHEIRO')),
      ...payments(umaForma('PIX', { localPix: 'MAQUINETA' })),
    ];
    for (const pg of todos) {
      expect(pg).not.toHaveProperty('installments');
      expect(pg).not.toHaveProperty('debit');
    }
    expect(payments(umaForma('DEBITO'))[0]).not.toHaveProperty('installments');
    expect(payments(umaForma('CREDITO', { parcelas: 2 }))[0]).not.toHaveProperty('debit');
  });

  it('centavos não viram dízima: a soma das formas bate com o total', () => {
    const total = 33333;
    const inicio = { ...p.ligarDuasFormas(), valorPrimeira: '111,11', atual: { ...p.ESCOLHA_VAZIA, forma: 'DINHEIRO' } };
    const estado = { ...p.fecharPrimeira(inicio, total), atual: { ...p.ESCOLHA_VAZIA, forma: 'DEBITO' } };
    const linhas = p.paraPayments(p.analisar(estado, total).linhas);
    expect(linhas.map((l: any) => l.value)).toEqual([111.11, 222.22]);
    for (const l of linhas) expect(String(l.value)).toMatch(/^\d+(\.\d{1,2})?$/);
  });
});

describe('venda rápida — o que falta responder', () => {
  it('nada vem marcado: sem escolha não finaliza', () => {
    const a = p.analisar(p.PAGAMENTO_VAZIO, TOTAL);
    expect(a.pendencia).toBe('FORMA');
    expect(a.acao).toBeNull();
    expect(a.linhas).toEqual([]);
    expect(a.faltaCentavos).toBe(TOTAL);
  });

  it('PIX sem o lugar e crédito sem as parcelas não finalizam', () => {
    expect(p.analisar(umaForma('PIX'), TOTAL).pendencia).toBe('LOCAL_PIX');
    expect(p.analisar(umaForma('CREDITO'), TOTAL).pendencia).toBe('PARCELAS');
    expect(p.analisar(umaForma('CREDITO', { parcelas: 13 }), TOTAL).pendencia).toBe('PARCELAS');
  });

  it.each([[''], ['0'], ['950,00'], ['2000'], ['abc'], ['10,555']])('valor "%s" da primeira forma não passa', (valor) => {
    const a = p.analisar({ ...p.ligarDuasFormas(), valorPrimeira: valor, atual: { ...p.ESCOLHA_VAZIA, forma: 'DINHEIRO' } }, TOTAL);
    expect(a.pendencia).toBe('VALOR');
    expect(a.acao).toBeNull();
  });

  it('na primeira forma o botão continua; só na segunda finaliza', () => {
    const inicio = { ...p.ligarDuasFormas(), valorPrimeira: '500', atual: { ...p.ESCOLHA_VAZIA, forma: 'DINHEIRO' } };
    expect(p.analisar(inicio, TOTAL).acao).toBe('CONTINUAR');
    const fechada = p.fecharPrimeira(inicio, TOTAL);
    expect(p.analisar(fechada, TOTAL).pendencia).toBe('FORMA');
    expect(p.analisar(fechada, TOTAL).baseCentavos).toBe(45000);
  });

  it('fecharPrimeira não fecha com pendência', () => {
    const semForma = { ...p.ligarDuasFormas(), valorPrimeira: '500' };
    expect(p.fecharPrimeira(semForma, TOTAL)).toBe(semForma);
  });

  it('total menor que a primeira forma trava em vez de mandar valor negativo', () => {
    const estado = duasFormas('500', { forma: 'DINHEIRO' }, { forma: 'DEBITO' });
    const a = p.analisar(estado, 40000);
    expect(a.acao).toBeNull();
    expect(a.pendencia).toBe('VALOR');
  });

  it('venda sem valor não finaliza', () => {
    expect(p.analisar(umaForma('DINHEIRO'), 0).acao).toBeNull();
  });
});

describe('venda rápida — escolher e trocar', () => {
  it('tocar de novo na mesma forma não apaga as parcelas; trocar de forma apaga', () => {
    const credito = umaForma('CREDITO', { parcelas: 3 });
    expect(p.escolherForma(credito, 'CREDITO').atual.parcelas).toBe(3);
    expect(p.escolherForma(credito, 'DEBITO').atual).toEqual({ forma: 'DEBITO', localPix: null, parcelas: null });
  });

  it('trocar a primeira forma reabre como estava e tira a segunda', () => {
    const estado = duasFormas('100,50', { forma: 'PIX', localPix: 'CHAVE' }, { forma: 'DEBITO' });
    const reaberta = p.trocarPrimeira(estado);
    expect(reaberta.primeira).toBeNull();
    expect(reaberta.valorPrimeira).toBe('100,50');
    expect(reaberta.atual).toEqual({ forma: 'PIX', localPix: 'CHAVE', parcelas: null });
  });

  it('dinheiro não repete na segunda forma; PIX e cartão repetem', () => {
    const formas = ['DINHEIRO', 'PIX', 'DEBITO', 'CREDITO'];
    const comDinheiro = duasFormas('500', { forma: 'DINHEIRO' }, {});
    expect(p.formasDaSegunda(comDinheiro, formas)).toEqual(['PIX', 'DEBITO', 'CREDITO']);
    const comPix = duasFormas('500', { forma: 'PIX', localPix: 'CHAVE' }, {});
    expect(p.formasDaSegunda(comPix, formas)).toEqual(formas);
  });
});

describe('venda rápida — texto em R$ para centavos', () => {
  it.each([
    ['100', 10000],
    ['100,5', 10050],
    ['100,50', 10050],
    ['1.800,00', 180000],
    ['350.50', 35050],
    ['1.200', 120000],
    ['1800', 180000],
    ['R$ 50,00', 5000],
    ['0,01', 1],
    ['1.234.567,89', 123456789],
  ])('"%s" = %d centavos', (texto, centavos) => {
    expect(p.paraCentavos(texto)).toBe(centavos);
  });

  it.each([[''], ['abc'], ['-5'], ['10,555'], ['1,2,3'], ['1.2,50'], ['1.2000'], [',50']])('"%s" é inválido', (texto) => {
    expect(p.paraCentavos(texto)).toBeNull();
  });
});

describe('venda rápida — onde o dinheiro cai e o que o botão diz', () => {
  it('PIX cai no Banco mesmo na maquineta; só cartão cai na Maquininha', () => {
    expect(p.destinoDaForma('DINHEIRO')).toBe('Caixa');
    expect(p.destinoDaForma('PIX')).toBe('Banco');
    expect(p.destinoDaForma('DEBITO')).toBe('Maquininha');
    expect(p.destinoDaForma('CREDITO')).toBe('Maquininha');
  });

  it('o botão diz o que vai gravar', () => {
    const uma = p.analisar(umaForma('CREDITO', { parcelas: 3 }), TOTAL).linhas;
    expect(p.textoFinalizar(uma).replace(/\s/g, ' ')).toBe('Finalizar · R$ 950,00 em Crédito 3x');
    const duas = p.analisar(duasFormas('500', { forma: 'DINHEIRO' }, { forma: 'DEBITO' }), TOTAL).linhas;
    expect(p.textoFinalizar(duas)).toBe('Finalizar · 2 formas');
  });
});

describe('venda rápida — a tela', () => {
  const pasta = 'apps/web/src/app/atendimento/venda-rapida';
  const ler = (arq: string) => fs.readFileSync(path.join(RAIZ, pasta, arq), 'utf8');

  it('o arquivo das regras continua puro (sem import), para este spec carregar', () => {
    expect(/^\s*import\s/m.test(ler('pagamento-balcao.ts'))).toBe(false);
  });

  it('a venda rápida não tem mais o PIX online: só recebe no balcão', () => {
    const pagina = ler('page.tsx');
    for (const trecho of ['approve-and-bill', 'TESTE-SISTEMA', '/payment-gateway/settings', "billing_type"]) {
      expect(pagina.includes(trecho)).toBe(false);
    }
  });

  it('a venda é gravada antes do POST e só apagada com a resposta (F5 no meio não duplica)', () => {
    const pagina = ler('page.tsx');
    const guardar = pagina.indexOf('guardarPendente(envio);');
    const enviar = pagina.indexOf('void enviarVenda(envio);');
    expect(guardar).toBeGreaterThan(-1);
    expect(guardar).toBeLessThan(enviar);
    const post = pagina.indexOf("api.post<any>('/venda-rapida/balcao'");
    expect(post).toBeGreaterThan(-1);
    expect(post).toBeLessThan(pagina.indexOf('guardarPendente(null);', post));
  });
});
