/**
 * F5/F6 do laboratório — componentes que SÓ o laboratório monta (o cadastro do cliente, o
 * painel do contato e a aba Orçamento) e os arquivos de textos novos da F6. Como a clínica nunca passa por eles, o texto inteiro é do
 * laboratório e a trava de textos (scripts/ci/check-pick-literals.mjs) não os enxerga
 * quando não têm pickBt/LAB_. Este spec cobre isso:
 *   - nenhum texto visível (string, template ou texto de JSX) com palavra de clínica —
 *     o mesmo detector do LabVocabInterceptor (temPalavraDeClinica, lab-vocab.spec);
 *   - nenhuma chamada a rota que é só de clínica (agenda, odontograma, anamnese,
 *     memória da IA, Drive, honorários, alergias, medicamentos, atender, aniversários,
 *     primeiras consultas, portal do paciente).
 * Os arquivos são criados pelas telas da F5 (cadastro e contato) e da F6 (orçamento,
 * propostas, trabalhos e painel): até lá este spec acusa "não existe".
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { temPalavraDeClinica } from '../business-type/lab-vocab.interceptor';

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');

const ARQUIVOS_DO_LAB = [
  'apps/web/src/app/atendimento/pacientes/components/LabClienteModal.tsx',
  'apps/web/src/components/LabClientPanel.tsx',
  // F6 — aba Orçamento do laboratório e os textos novos das telas do orçamento de trabalho
  'apps/web/src/app/atendimento/pacientes/components/LabOrcamentoTab.tsx',
  'apps/web/src/app/atendimento/pacientes/lab-orcamento-textos.ts',
  'apps/web/src/app/atendimento/pacientes/lab-propostas-textos.ts',
  'apps/web/src/app/atendimento/pacientes/lab-trabalhos-textos.ts',
  'apps/web/src/app/atendimento/orcamentos/lab-orcamentos-textos.ts',
  // F7 — textos novos da agenda e da Central de Disparos do laboratório
  'apps/web/src/app/atendimento/agenda/lab-agenda-textos.ts',
  'apps/web/src/app/atendimento/settings/disparos/lab-disparos-textos.ts',
  'apps/web/src/app/atendimento/settings/disparos/catalogo-laboratorio.ts',
];

/** Trechos de rota que são só de clínica (negados ao laboratório na API). */
const ROTAS_DE_CLINICA = [
  '/calendar/',
  '/odontogram',
  '/anamnes',
  '/memories',
  '/google-drive',
  '/honorarios',
  '/allergies',
  '/medications',
  '/start-attending',
  '/birthdays',
  '/first-visits',
  '/portal/',
  // F6 — sugestões do odontograma, duplicar como opção, contrato, consulta de crédito,
  // aceite sem cobrança, afiliados e o prefixo '/commercial/' (que a API não tem: 404)
  '/state-suggestions',
  '/duplicate-as-option',
  '/contract',
  '/credit-check',
  '/accept-no-charge',
  '/affiliates/options',
  '/commercial/',
];

/** Textos que chegam à tela: string, template (partes fixas) e texto de JSX. Fora: import/export e tipos. */
function textosVisiveis(arq: string, fonte: string): Array<{ texto: string; linha: number }> {
  const sf = ts.createSourceFile(arq, fonte, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Array<{ texto: string; linha: number }> = [];
  const guardar = (texto: string, no: ts.Node) => {
    const t = texto.replace(/\s+/g, ' ').trim();
    if (t) out.push({ texto: t, linha: sf.getLineAndCharacterOfPosition(no.getStart(sf)).line + 1 });
  };
  const ehTipo = (no: ts.Node) =>
    (no.kind >= ts.SyntaxKind.FirstTypeNode && no.kind <= ts.SyntaxKind.LastTypeNode) ||
    ts.isInterfaceDeclaration(no) ||
    ts.isTypeAliasDeclaration(no);
  const visitar = (no: ts.Node): void => {
    if (ehTipo(no) || ts.isImportDeclaration(no) || ts.isExportDeclaration(no)) return;
    if (ts.isStringLiteral(no) || ts.isNoSubstitutionTemplateLiteral(no)) guardar(no.text, no);
    else if (ts.isTemplateHead(no) || ts.isTemplateMiddle(no) || ts.isTemplateTail(no)) guardar(no.text, no);
    else if (ts.isJsxText(no)) guardar(no.text, no);
    ts.forEachChild(no, visitar);
  };
  visitar(sf);
  return out;
}

describe('componentes só do laboratório (F5)', () => {
  it.each(ARQUIVOS_DO_LAB.map((a) => [a]))('%s existe', (arq) => {
    expect(fs.existsSync(path.join(RAIZ, arq)) ? arq : `${arq} não existe`).toBe(arq);
  });

  it.each(ARQUIVOS_DO_LAB.map((a) => [a]))('%s: nenhum texto visível com palavra de clínica', (arq) => {
    const p = path.join(RAIZ, arq);
    if (!fs.existsSync(p)) throw new Error(`${arq} não existe`);
    const ruins = textosVisiveis(arq, fs.readFileSync(p, 'utf8'))
      .filter(({ texto }) => temPalavraDeClinica(texto))
      .map(({ texto, linha }) => `${arq}:${linha} ${JSON.stringify(texto)}`);
    expect(ruins).toEqual([]);
  });

  it.each(ARQUIVOS_DO_LAB.map((a) => [a]))('%s: nenhuma chamada a rota só de clínica', (arq) => {
    const p = path.join(RAIZ, arq);
    if (!fs.existsSync(p)) throw new Error(`${arq} não existe`);
    const src = fs.readFileSync(p, 'utf8');
    expect(ROTAS_DE_CLINICA.filter((r) => src.includes(r)).map((r) => `${arq} cita ${r}`)).toEqual([]);
  });

  it('o detector é o mesmo do interceptor (pega o que a trava pega e deixa passar "clínica" cliente)', () => {
    expect(temPalavraDeClinica('Ficha do paciente')).toBe(true);
    expect(temPalavraDeClinica('Próxima consulta')).toBe(true);
    expect(temPalavraDeClinica('Procedimentos do plano')).toBe(true);
    expect(temPalavraDeClinica('Clínica parceira')).toBe(false);
    expect(temPalavraDeClinica('Dentista responsável')).toBe(false);
    expect(temPalavraDeClinica('Paciente do caso')).toBe(false);
  });
});
