/**
 * F5 do laboratório — MARCADORES que a lógica lê dentro de texto. O laboratório troca
 * os textos de clínica por texto próprio; estes pedaços NÃO podem mudar, porque alguma
 * regra procura por eles:
 *   - "Venda rapida" no começo das notas (isVendaRapidaQuote e a cópia em
 *     patients/dentist-links.ts; a regex da aba Financeiro da ficha);
 *   - a tag [plan:<id>] no fim da descrição da cobrança (liga a cobrança ao plano);
 *   - "Parcela N/M" (rótulo do carnê), "Parcelado (" e "Parcelas " (o guarda-chuva do
 *     "Do mês"), "sinal"/"entrada"/"parcelado" (a emissão não repete o que existe);
 *   - o marcador -CARTAO- no external_id (venda no cartão da maquineta).
 * E a regra dos arquivos de MUITO MOVIMENTO: neles o laboratório entra só com portão e
 * texto importado — nada de pickBt( nem const LAB_ (a trava de textos marcaria o arquivo).
 *
 * Roda as funções de verdade e lê as fontes (sem banco, sem Nest).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { isVendaRapidaQuote } from '../commercial/quotes.service';
import { notasVendaBalcao, type FormaBalcao } from '../commercial/venda-balcao.util';
import {
  DESCRICAO_DE_EMISSAO_DO_LABORATORIO,
  descricaoDaReceitaDoLaboratorio,
  rotuloDoBalcaoDoLaboratorio,
} from '../payment-gateway/cobranca-laboratorio';

const SRC = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SRC, '..', '..', '..');
const ler = (relativoRaiz: string) => fs.readFileSync(path.join(RAIZ, relativoRaiz), 'utf8').replace(/\r\n/g, '\n');
const PLANO = '00000000-0000-4000-8000-0000000000aa';

/** A cópia de isVendaRapidaQuote em patients/dentist-links.ts (não exportada), compilada do fonte. */
function copiaDeDentistLinks(): (q: { title?: string | null; notes?: string | null }) => boolean {
  const src = ler('apps/api/src/patients/dentist-links.ts');
  const norm = /^const norm = [\s\S]*?;\n/m.exec(src)?.[0];
  const fn = /^function isVendaRapidaQuote\([\s\S]*?\n\}/m.exec(src)?.[0];
  if (!norm || !fn) throw new Error('não achei norm/isVendaRapidaQuote em patients/dentist-links.ts');
  const js = ts.transpileModule(`${norm}\n${fn}\nexports.isVendaRapidaQuote = isVendaRapidaQuote;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exp: Record<string, unknown> = {};
  new Function('exports', js)(exp);
  return exp.isVendaRapidaQuote as (q: { title?: string | null; notes?: string | null }) => boolean;
}

describe('"Venda rapida" — a marca da venda de balcão', () => {
  const copia = copiaDeDentistLinks();
  const formas: FormaBalcao[][] = [
    [{ method: 'DINHEIRO', value: 100 }],
    [{ method: 'PIX', value: 100 }],
    [{ method: 'CARTAO', value: 60 }, { method: 'CARTAO', value: 40 }],
    [{ method: 'PIX', value: 70 }, { method: 'DINHEIRO', value: 30 }],
    [],
  ];
  const notas = [
    ...formas.map((ps) => notasVendaBalcao(ps)),
    ...formas.map((ps) => notasVendaBalcao(ps, true)),
    // As notas que a tela da venda rápida grava nos caminhos dela.
    'Venda rapida (balcao sem avaliacao)',
    'Venda rápida (balcão)',
  ];
  const regexDaFicha = /venda\s*r[áa]pida/i;

  it.each(notas.map((n) => [n]))('%j é venda rápida para o orçamento, para a cópia dos vínculos e para a aba Financeiro', (n) => {
    expect(isVendaRapidaQuote({ notes: n })).toBe(true);
    expect(copia({ notes: n })).toBe(true);
    expect(regexDaFicha.test(n)).toBe(true);
  });

  it('o título "Venda rápida" (com acento) também marca, nos dois lados', () => {
    expect(isVendaRapidaQuote({ title: 'Venda rápida' })).toBe(true);
    expect(copia({ title: 'Venda rápida' })).toBe(true);
    expect(isVendaRapidaQuote({ title: 'Orçamento', notes: 'Coroa' })).toBe(false);
    expect(copia({ title: 'Orçamento', notes: 'Coroa' })).toBe(false);
  });

  it('a regex da aba Financeiro da ficha continua no fonte', () => {
    expect(ler('apps/web/src/app/atendimento/pacientes/components/FinanceiroTab.tsx')).toContain('/venda\\s*r[áa]pida/i');
  });
});

describe('[plan:<id>] — a tag que liga a cobrança ao plano', () => {
  const extrair = (d: string) => d.match(/\[plan:([0-9a-f-]{36})\]/i)?.[1];

  it('a regex que lê a tag continua no QuotesService', () => {
    expect(ler('apps/api/src/commercial/quotes.service.ts')).toContain('.match(/\\[plan:([0-9a-f-]{36})\\]/i)');
  });

  it('as descrições do laboratório no billing terminam com a tag (emissão e balcão)', () => {
    const linhas = ler('apps/api/src/commercial/treatment-plan-billing.service.ts').split('\n');
    const usos = linhas
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes('DESCRICAO_DE_EMISSAO_DO_LABORATORIO.') && !l.trim().startsWith('//'));
    // carnê, entrada, parcelado, à vista/cartão e o balcão.
    expect(usos.length).toBeGreaterThanOrEqual(5);
    for (const { l, i } of usos) {
      // A tag fecha a mesma descrição (na linha ou nas duas seguintes, quando é montada em partes).
      const trecho = linhas.slice(i, i + 3).join('\n');
      expect([l.trim(), trecho.includes('[plan:${planId}]')]).toEqual([l.trim(), true]);
    }
  });

  it('montada com os textos do laboratório, a descrição devolve o id do plano', () => {
    const balcao = `${DESCRICAO_DE_EMISSAO_DO_LABORATORIO.trabalho} — Dr. Exemplo (${rotuloDoBalcaoDoLaboratorio({ receiveNow: true, soCartao: false, nx: '', formas: 1 })}) [plan:${PLANO}]`;
    expect(extrair(balcao)).toBe(PLANO);
    expect(extrair(`${DESCRICAO_DE_EMISSAO_DO_LABORATORIO.entrada} — Dr. Exemplo [plan:${PLANO}]`)).toBe(PLANO);
    expect(extrair(`${DESCRICAO_DE_EMISSAO_DO_LABORATORIO.parcelado} — Dr. Exemplo (3x) [plan:${PLANO}]`)).toBe(PLANO);
    // A receita do caixa leva a descrição da cobrança inteira (com a tag).
    expect(extrair(descricaoDaReceitaDoLaboratorio({ inClinic: true, nome: 'Dr. Exemplo', descricao: balcao, parcelaSuffix: '' }))).toBe(PLANO);
  });
});

describe('parcelas, guarda-chuva e partes da emissão', () => {
  it('"Parcela N/M" do carnê casa com o rótulo do envio dos boletos', () => {
    const billing = ler('apps/api/src/commercial/treatment-plan-billing.service.ts');
    expect(billing).toContain('description: `Parcela ${child.installmentNumber ?? \'?\'}/${options.installmentCount} — `');
    const envio = ler('apps/api/src/payment-gateway/boleto-delivery.service.ts');
    expect(envio).toContain('/Parcela\\s+(\\d+)\\s*\\/\\s*\\d+/i');
    expect(/Parcela\s+(\d+)\s*\/\s*\d+/i.exec(`Parcela 2/3 — Dr. Exemplo [plan:${PLANO}]`)?.[1]).toBe('2');
  });

  it('"Parcelado (" e o guarda-chuva do "Do mês" continuam literais', () => {
    expect(ler('apps/api/src/commercial/treatment-plan-billing.service.ts')).toContain('description: `Parcelado (${options.installmentCount}x) — ');
    const charges = ler('apps/api/src/financeiro/financeiro-charges.service.ts');
    for (const literal of ["startsWith: 'Parcelado ('", "startsWith: 'Parcelas '", "startsWith: 'Parcelado (1x)'", "startsWith: 'Parcelas 1x '"]) {
      expect([literal, charges.includes(literal)]).toEqual([literal, true]);
    }
  });

  it('"sinal", "entrada" e "parcelado": a emissão do laboratório acha o que já existe', () => {
    const billing = ler('apps/api/src/commercial/treatment-plan-billing.service.ts');
    expect(billing).toContain("isKind('SINAL', 'sinal', c)");
    expect(billing).toContain("isKind('ENTRADA', 'entrada', c)");
    expect(billing).toContain("isKind('INSTALLMENT', 'parcelado', c)");
    expect(`${DESCRICAO_DE_EMISSAO_DO_LABORATORIO.entrada} — Dr. Exemplo`.toLowerCase()).toContain('entrada');
    expect(`${DESCRICAO_DE_EMISSAO_DO_LABORATORIO.parcelado} — Dr. Exemplo (3x)`.toLowerCase()).toContain('parcelado');
  });
});

describe('-CARTAO- — a venda no cartão da maquineta', () => {
  it('o marcador continua no external_id do balcão e nas telas que o leem', () => {
    expect(ler('apps/api/src/commercial/treatment-plan-billing.service.ts')).toContain("soCartao || !receiveNow ? 'CARTAO' : 'AVISTA'");
    expect(ler('apps/web/src/app/atendimento/financeiro/components/BoletosTab.tsx')).toContain("includes('-CARTAO-')");
    expect(ler('apps/web/src/app/atendimento/pacientes/components/FinanceiroTab.tsx')).toContain("includes('-CARTAO-')");
  });
});

describe('arquivos de MUITO MOVIMENTO: laboratório só com portão e texto importado', () => {
  const MUITO_MOVIMENTO = [
    'apps/web/src/app/atendimento/pacientes/components/PropostasTab.tsx',
    'apps/web/src/app/atendimento/pacientes/components/AddQuoteItemModal.tsx',
    'apps/web/src/app/atendimento/pacientes/components/FinanceiroTab.tsx',
    'apps/web/src/app/atendimento/financeiro/contas-a-pagar/page.tsx',
    'apps/web/src/app/atendimento/financeiro/components/BoletosTab.tsx',
    'apps/web/src/app/atendimento/financeiro/components/BoletosKpis.tsx',
    'apps/web/src/app/atendimento/page.tsx',
    'apps/web/src/app/atendimento/pacientes/[id]/page.tsx',
    'apps/web/src/app/atendimento/layout.tsx',
    'apps/web/src/components/Sidebar.tsx',
    'apps/web/src/app/atendimento/venda-rapida/page.tsx',
    'apps/web/src/app/atendimento/settings/users/page.tsx',
    'apps/web/src/app/atendimento/crm/page.tsx',
    'apps/api/src/commercial/quotes.service.ts',
    'apps/api/src/commercial/treatment-plan-billing.service.ts',
    'apps/api/src/payment-gateway/payment-gateway.service.ts',
    'apps/api/src/leads/leads.service.ts',
    'apps/api/src/patients/patients.service.ts',
    'apps/api/src/financeiro/financeiro.service.ts',
    'packages/shared/src/index.ts',
  ];

  it.each(MUITO_MOVIMENTO.map((a) => [a]))('%s: sem pickBt( e sem const LAB_', (arq) => {
    const src = ler(arq);
    expect(src.match(/\bpickBt\s*\(/g) ?? []).toEqual([]);
    expect(src.match(/\b(?:const|let|var)\s+LAB_\w*/g) ?? []).toEqual([]);
  });
});
