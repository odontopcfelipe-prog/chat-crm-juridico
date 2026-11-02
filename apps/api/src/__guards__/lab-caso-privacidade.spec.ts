/**
 * F8 do laboratório — o paciente do caso fica num caminho só.
 *
 * O caso protético guarda o nome do paciente do dentista (patient_ref). Ele só pode
 * ser lido e gravado pelas rotas de fichas (apps/api/src/lab-fichas) e mostrado na
 * ficha do caso da tela. Nunca no PDF, na cobrança, no WhatsApp, no e-mail, no log
 * ou no worker. Este spec é ESTRUTURAL (lista fechada de arquivos):
 *   - 'patient_ref' só aparece no shared das fichas, nas rotas de fichas e no
 *     componente da ficha do caso;
 *   - a tabela do caso (delegate quoteLabCase, relação lab_case) só é lida nas
 *     rotas de fichas — quem precisa de cor, material e entrega no PDF usa
 *     lerCasoParaPdf, que tem select fechado;
 *   - o worker não conhece nenhum dos três.
 * Um include lab_case novo em outro arquivo quebra este spec de propósito.
 */
import * as fs from 'fs';
import * as path from 'path';

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
const PASTAS = ['apps/api/src', 'apps/worker/src', 'packages/shared/src', 'apps/web/src'];
const EXTENSOES = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const FORA = /(^|\/)(node_modules|dist|\.next|__guards__)(\/|$)|\.(spec|test)\.[cm]?[jt]sx?$/;

/** Arquivos de código (caminho a partir da raiz, com /), fora specs e __guards__. */
function arquivos(): string[] {
  const lista: string[] = [];
  const andar = (rel: string) => {
    const abs = path.join(RAIZ, rel);
    if (!fs.existsSync(abs)) return;
    for (const nome of fs.readdirSync(abs)) {
      const filho = `${rel}/${nome}`;
      if (FORA.test(filho)) continue;
      if (fs.statSync(path.join(RAIZ, filho)).isDirectory()) andar(filho);
      else if (EXTENSOES.test(nome)) lista.push(filho);
    }
  };
  PASTAS.forEach(andar);
  return lista;
}

const DAS_ROTAS_DE_FICHAS = (arq: string) => arq.startsWith('apps/api/src/lab-fichas/');

/** Palavra inteira ('patient_referrals' não é 'patient_ref'). */
const PACIENTE_DO_CASO = /\bpatient_ref\b/;
const TABELA_DO_CASO = /\b(?:quoteLabCase|lab_case)\b/;
const QUALQUER_DO_CASO = /\b(?:patient_ref|quoteLabCase|QuoteLabCase|lab_case)\b/;

/** Onde 'patient_ref' pode aparecer. */
const PODE_TER_PACIENTE_DO_CASO = (arq: string) =>
  DAS_ROTAS_DE_FICHAS(arq) ||
  arq === 'packages/shared/src/lab-fichas.ts' ||
  arq === 'apps/web/src/app/atendimento/pacientes/components/LabFichaDoCaso.tsx';

describe('F8 — o paciente do caso não sai das fichas', () => {
  let todos: Array<{ arq: string; src: string }>;

  beforeAll(() => {
    todos = arquivos().map((arq) => ({ arq, src: fs.readFileSync(path.join(RAIZ, arq), 'utf8') }));
  }, 60_000);

  it('a varredura enxerga as quatro pastas (inclusive as rotas de fichas)', () => {
    for (const pasta of PASTAS) expect([pasta, todos.some((a) => a.arq.startsWith(`${pasta}/`))]).toEqual([pasta, true]);
    expect(todos.some((a) => DAS_ROTAS_DE_FICHAS(a.arq) && PACIENTE_DO_CASO.test(a.src))).toBe(true);
  });

  it("'patient_ref' só no shared das fichas, nas rotas de fichas e na ficha do caso da tela", () => {
    const fora = todos.filter((a) => PACIENTE_DO_CASO.test(a.src) && !PODE_TER_PACIENTE_DO_CASO(a.arq)).map((a) => a.arq);
    expect(fora).toEqual([]);
  });

  it("a tabela do caso ('quoteLabCase' e 'lab_case') só é lida nas rotas de fichas", () => {
    const fora = todos
      .filter((a) => TABELA_DO_CASO.test(a.src) && !DAS_ROTAS_DE_FICHAS(a.arq))
      .map((a) => a.arq);
    expect(fora).toEqual([]);
  });

  it('o worker não conhece o caso do laboratório', () => {
    const doWorker = todos
      .filter((a) => a.arq.startsWith('apps/worker/src/'))
      .filter((a) => QUALQUER_DO_CASO.test(a.src))
      .map((a) => a.arq);
    expect(doWorker).toEqual([]);
  });

  it('a leitura do caso para o PDF tem select fechado em cor, material e entrega', () => {
    const src = fs.readFileSync(path.join(RAIZ, 'apps/api/src/lab-fichas/caso-do-orcamento.ts'), 'utf8');
    const corpo = src.slice(src.indexOf('export async function lerCasoParaPdf'));
    expect(corpo).toContain('{ shade: true, material: true, due_date: true }');
    expect(corpo).not.toMatch(/patient_ref|instructions|requested_by_name|external_files_url|received_at/);
  });
});
