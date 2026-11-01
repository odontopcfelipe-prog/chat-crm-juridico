/**
 * F7 do laboratório — os textos do laboratório da agenda e da Central de Disparos
 * (packages/shared/src/lab-agenda-textos.ts e lab-disparos-textos.ts).
 *
 *   - os dois arquivos só têm consts LAB_ (e import de tipo): qualquer string fora
 *     delas reprovaria a trava 1 de scripts/ci/check-pick-literals.mjs;
 *   - todo texto (inclusive a saída das funções) passa nos PROIBIDOS do script (a
 *     lista é lida do próprio script) e no detector de vocabulário de clínica dos
 *     envios do laboratório, sem as variáveis;
 *   - {clinica} e {{clinica_nome}} são o nome do laboratório: sem artigo antes.
 *
 * Lê o fonte (nomes das consts) e o @crm/shared COMPILADO (valores): depois de mexer
 * no shared, rode `npm run build -w @crm/shared` antes.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as shared from '@crm/shared';
import { semVariaveis, temVocabularioDeClinica } from '../payment-gateway/cobranca-laboratorio';

const SRC = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SRC, '..', '..', '..');
const ARQUIVOS = ['packages/shared/src/lab-agenda-textos.ts', 'packages/shared/src/lab-disparos-textos.ts'];

/** A lista PROIBIDOS (e PERMITIDOS) lida do próprio script da trava (ele é ESM e roda git ao carregar). */
function travaDoScript(): { proibidos: Array<[string, RegExp]>; permitidos: RegExp[] } {
  const src = fs.readFileSync(path.join(RAIZ, 'scripts', 'ci', 'check-pick-literals.mjs'), 'utf8');
  const bloco = (nome: string) => {
    const m = new RegExp(`const ${nome} = \\[([\\s\\S]*?)\\]\\.map`).exec(src);
    if (!m) throw new Error(`não achei ${nome} em check-pick-literals.mjs`);
    return m[1];
  };
  const palavra = (padrao: string, flags: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${padrao})(?![\\p{L}\\p{N}])`, `u${flags}`);
  const proibidos = [...bloco('PROIBIDOS').matchAll(/\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/g)].map(
    (m) => [m[1], palavra(m[2], '')] as [string, RegExp],
  );
  const permitidos = [...bloco('PERMITIDOS').matchAll(/'([^']+)'/g)].map((m) => palavra(m[1], 'g'));
  return { proibidos, permitidos };
}

const normalizar = (t: string) =>
  t
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');

/** Fonte do arquivo pelo compilador: consts LAB_ declaradas e strings fora delas. */
function analisar(arq: string): { consts: string[]; foraDeLab: string[]; outrasInstrucoes: string[] } {
  const fonte = fs.readFileSync(path.join(RAIZ, arq), 'utf8');
  const sf = ts.createSourceFile(arq, fonte, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const consts: string[] = [];
  const foraDeLab: string[] = [];
  const outrasInstrucoes: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      if (!st.importClause?.isTypeOnly) outrasInstrucoes.push(`import não é só de tipo: ${st.getText(sf)}`);
      continue;
    }
    if (ts.isVariableStatement(st) && (st.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text.startsWith('LAB_')) consts.push(d.name.text);
        else outrasInstrucoes.push(`const fora do padrão: ${d.name.getText(sf)}`);
      }
      continue;
    }
    outrasInstrucoes.push(st.getText(sf).slice(0, 80));
    const visitar = (no: ts.Node) => {
      if (ts.isStringLiteralLike(no) || ts.isTemplateHead(no) || ts.isTemplateMiddle(no) || ts.isTemplateTail(no)) foraDeLab.push(no.getText(sf));
      ts.forEachChild(no, visitar);
    };
    visitar(st);
  }
  return { consts, foraDeLab, outrasInstrucoes };
}

/** Todas as strings de um valor; funções são chamadas com argumentos de exemplo. */
function textos(v: unknown, saida: string[] = []): string[] {
  if (typeof v === 'string') saida.push(v);
  else if (typeof v === 'function') {
    const args = Array.from({ length: v.length }, (_, i) => `Exemplo${i}`);
    textos((v as (...a: unknown[]) => unknown)(...args), saida);
  } else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) textos(x, saida);
  return saida;
}

const NOMES = ARQUIVOS.flatMap((arq) => analisar(arq).consts);
const LAB = shared as unknown as Record<string, unknown>;

/** Saída das funções com os dados preenchidos e vazios (todos os ramos). */
function saidasDasFuncoes(): string[] {
  return [
    (LAB.LAB_NEGOCIACAO as any).legendaDoPdf('Carlos'),
    (LAB.LAB_NEGOCIACAO as any).arquivoDoPdf('Carlos'),
    (LAB.LAB_ENTRADA as any).mensagem('Carlos', 'da entrada', 'R$ 500,00', '10/11/2026'),
    (LAB.LAB_ENTRADA as any).mensagem('Carlos', 'da entrada', 'R$ 500,00', null),
    (LAB.LAB_NOVO_AGENDAMENTO as any).montar({
      nome: 'Dr. Carlos Lima',
      telefone: '5582900000000',
      quando: 'segunda-feira 03/11 às 14:30',
      tipo: 'Coleta',
      protetico: 'Pedro Exemplo',
      marcadoPor: 'Ana Exemplo',
      repete: 'semanal',
    }),
    (LAB.LAB_NOVO_AGENDAMENTO as any).montar({ quando: 'segunda-feira 03/11 às 14:30', tipo: 'Entrega' }),
  ];
}

describe('F7 — textos do laboratório da agenda e da Central', () => {
  it('os dois arquivos só têm consts LAB_ (e import de tipo); nenhuma string fora delas', () => {
    for (const arq of ARQUIVOS) {
      const r = analisar(arq);
      expect([arq, r.consts.length > 0]).toEqual([arq, true]);
      expect([arq, r.outrasInstrucoes, r.foraDeLab]).toEqual([arq, [], []]);
    }
  });

  it('cada const LAB_ do fonte está no @crm/shared compilado, congelada', () => {
    expect(NOMES).toEqual(
      expect.arrayContaining([
        'LAB_AGENDA_TIPO',
        'LAB_AGENDA_TIPO_FRASE',
        'LAB_AGENDA_TEXTOS',
        'LAB_AGENDA_EMAIL',
        'LAB_NOVO_AGENDAMENTO',
        'LAB_NEGOCIACAO',
        'LAB_ENTRADA',
        'LAB_VENDA_FEITA',
        'LAB_RESUMO_DIA',
        'LAB_RECUSA_DISPAROS',
        'LAB_TESTE_DA_CENTRAL',
      ]),
    );
    for (const nome of NOMES) {
      expect([nome, LAB[nome] !== undefined]).toEqual([nome, true]);
      expect([nome, Object.isFrozen(LAB[nome])]).toEqual([nome, true]);
    }
  });

  it('todo texto (e a saída das funções) sem os termos PROIBIDOS da trava', () => {
    const { proibidos, permitidos } = travaDoScript();
    expect(proibidos.length).toBeGreaterThanOrEqual(8);
    const todos = [...NOMES.flatMap((n) => textos(LAB[n])), ...saidasDasFuncoes()];
    expect(todos.length).toBeGreaterThan(40);
    const ruins: string[] = [];
    for (const t of todos) {
      let n = normalizar(t);
      for (const re of permitidos) n = n.replace(re, ' ');
      const termos = proibidos.filter(([, re]) => re.test(n)).map(([r]) => r);
      if (termos.length) ruins.push(`${t} → ${termos.join(', ')}`);
    }
    expect(ruins).toEqual([]);
  });

  it('sem vocabulário de clínica no texto fixo (sem as variáveis)', () => {
    const todos = [...NOMES.flatMap((n) => textos(LAB[n])), ...saidasDasFuncoes()];
    expect(todos.filter((t) => temVocabularioDeClinica(semVariaveis(t)))).toEqual([]);
  });

  it('{clinica} e {{clinica_nome}} sem artigo antes (é o nome do laboratório)', () => {
    const comArtigo = /(?<![\p{L}\p{N}])(?:a|o|da|do|na|no|à|ao|pela|pelo)\s+\{\{?\s*clinica(?:_nome)?\s*\}\}?/iu;
    const todos = NOMES.flatMap((n) => textos(LAB[n]));
    expect(todos.filter((t) => comArtigo.test(t))).toEqual([]);
  });

  it('as funções montam o texto esperado', () => {
    const [legenda, arquivo, entradaComVencimento, entradaSemVencimento, aviso, avisoVazio] = saidasDasFuncoes();
    expect(legenda).toBe('Aqui estão os serviços do seu orçamento, Carlos.');
    expect(arquivo).toBe('servicos-Carlos.pdf');
    expect(entradaComVencimento).toBe(
      'Carlos, pra liberarmos o início do seu trabalho, segue o *boleto da entrada* de *R$ 500,00* (vence em *10/11/2026*).',
    );
    expect(entradaSemVencimento).toBe('Carlos, pra liberarmos o início do seu trabalho, segue o *boleto da entrada* de *R$ 500,00*.');
    expect(aviso).toBe(
      [
        '📅 *Novo agendamento*',
        'Cliente: Dr. Carlos Lima (5582900000000)',
        'Quando: segunda-feira 03/11 às 14:30',
        'Tipo: Coleta',
        'Com: Pedro Exemplo',
        'Marcado por: Ana Exemplo',
        'Repete: semanal (aviso só da 1ª)',
      ].join('\n'),
    );
    expect(avisoVazio).toBe(
      [
        '📅 *Novo agendamento*',
        'Cliente: Cliente sem nome',
        'Quando: segunda-feira 03/11 às 14:30',
        'Tipo: Entrega',
        'Com: sem protético definido',
        'Marcado por: equipe',
      ].join('\n'),
    );
  });

  it('o lembrete de 48 h e as recusas da Central têm o texto decidido', () => {
    const agenda = LAB.LAB_AGENDA_TEXTOS as Record<string, string>;
    expect(agenda.lembrete48h).toBe(
      'Oi {nome}! Lembrete do laboratório: *{data}* às *{hora}* passamos no consultório para a {tipo} do seu trabalho.\n' +
        '{local_line}\n' +
        'Se precisar mudar, é só responder aqui.',
    );
    expect(agenda.clienteObrigatorio.length).toBeGreaterThan(10);
    expect(Object.keys(LAB.LAB_RECUSA_DISPAROS as object).sort()).toEqual(
      ['aniversario', 'antecedencia', 'escondido', 'regua', 'template', 'teste'].sort(),
    );
  });
});
