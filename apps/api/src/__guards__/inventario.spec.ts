/**
 * F0a — inventário do que roda sozinho e das rotas (API e worker).
 *
 * Gera o inventário em memória (scripts/ci/inventario.cjs, AST do TypeScript)
 * e compara com os JSON commitados em apps/api/src/__guards__ e
 * apps/worker/src/__guards__:
 *
 *   - automatismos (@Cron, @Processor, onModuleInit, timer de boot, QueueEvents,
 *     fila registrada, job repetível, item herdado de classe base…), handlers
 *     e middleware de socket e globais (ordem dos APP_GUARD, app.useGlobal* e
 *     app.use do main.ts): ESTRITO.
 *     Item novo ou removido FALHA — alguém precisa olhar se aquilo pode rodar
 *     para todos os tenants (base do "o laboratório nega por padrão o que não
 *     foi classificado").
 *   - controllers, rotas, decoradores de acesso e produtores de fila
 *     (queue.add): só console.warn.
 *
 * No GitHub Actions, o que mudou (falha e aviso) vai também para o resumo do
 * job ($GITHUB_STEP_SUMMARY), para o aviso de rota não sumir no log do jest.
 *
 * Atualizar depois de conferir: npm run guards:update (na raiz).
 */
import * as fs from 'fs';
import * as path from 'path';

type Inventario = Record<string, unknown> & { resumo: Record<string, unknown> };
type ModuloInventario = {
  APPS: string[];
  caminhoInventario(app: string): string;
  gerarInventario(app: string): Inventario;
  compararInventarios(
    app: string,
    commitado: Inventario,
    gerado: Inventario,
  ): { estrito: string | null; avisos: string | null };
  escreverResumoDoJob(app: string, resultado: { estrito: string | null; avisos: string | null }): boolean;
};

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const inv = require(path.join(RAIZ, 'scripts', 'ci', 'inventario.cjs')) as ModuloInventario;

describe.each(inv.APPS)('inventário — %s', (app) => {
  let commitado: Inventario | null = null;
  let gerado: Inventario;
  let resultado: { estrito: string | null; avisos: string | null };

  beforeAll(() => {
    gerado = inv.gerarInventario(app);
    const arquivo = inv.caminhoInventario(app);
    if (fs.existsSync(arquivo)) {
      commitado = JSON.parse(fs.readFileSync(arquivo, 'utf8')) as Inventario;
      resultado = inv.compararInventarios(app, commitado, gerado);
      inv.escreverResumoDoJob(app, resultado);
    }
  }, 120_000);

  it('o inventário commitado existe', () => {
    if (!commitado) {
      throw new Error(
        `[inventário ${app}] ${path.relative(RAIZ, inv.caminhoInventario(app))} não existe. ` +
          'Rode "npm run guards:update" na raiz e commite o arquivo.',
      );
    }
  });

  it('o gerador enxerga o app (não voltou vazio)', () => {
    // Se o TypeScript mudar a API de decoradores, o gerador pode voltar vazio
    // e "passar" com tudo removido; este teste pega isso antes.
    const autos = gerado.resumo.automatismos as Record<string, number>;
    expect(Object.values(autos).reduce((s, n) => s + n, 0)).toBeGreaterThan(0);
    if (app === 'api') expect(gerado.resumo.controllers as number).toBeGreaterThan(0);
  });

  it('automatismos, socket e globais (ordem dos APP_GUARD, app.useGlobal*, app.use) iguais ao commitado (estrito)', () => {
    if (!commitado) return; // o teste de existência já falhou
    if (resultado.estrito) throw new Error(resultado.estrito);
  });

  it('controllers, rotas, decoradores de acesso e produtores de fila (só avisa)', () => {
    if (!commitado) return;
    if (resultado.avisos) console.warn(resultado.avisos);
  });
});
