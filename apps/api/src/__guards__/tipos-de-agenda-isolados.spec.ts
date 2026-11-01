/**
 * F7 do laboratório — COLETA, PROVA e ENTREGA são tipos SÓ do laboratório e moram em
 * um lugar só: packages/shared/src/agenda-laboratorio.ts (TIPOS_SO_DO_LABORATORIO,
 * TIPOS_AVISO_LAB, TIPOS_DE_AGENDA_DO_LABORATORIO).
 *
 * Nenhum arquivo de código da API e do worker (fora os specs) escreve esses tipos
 * entre aspas. Assim nenhuma lista de tipos de atendimento da clínica (pesquisa pós-
 * atendimento, lista de espera, retorno, comissão, promoção a paciente, última visita,
 * confirmação e aviso da clínica) passa a enxergá-los por engano: quem precisa dos
 * tipos do laboratório importa a lista do shared.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SRC, '..', '..', '..');
const PASTAS = ['apps/api/src', 'apps/worker/src'];
const ENTRE_ASPAS = /(['"`])(COLETA|PROVA|ENTREGA)\1/g;

function arquivosDeCodigo(dir: string, saida: string[] = []): string[] {
  for (const nome of fs.readdirSync(dir)) {
    const p = path.join(dir, nome);
    if (fs.statSync(p).isDirectory()) {
      if (nome !== 'node_modules' && nome !== '__guards__' && nome !== 'dist') arquivosDeCodigo(p, saida);
    } else if (/\.ts$/.test(nome) && !/\.(spec|test)\.ts$/.test(nome) && !/\.d\.ts$/.test(nome)) {
      saida.push(p);
    }
  }
  return saida;
}

describe('Tipos de agenda do laboratório isolados no shared', () => {
  it('nenhum .ts da API e do worker (fora specs) tem COLETA, PROVA ou ENTREGA entre aspas', () => {
    const arquivos = PASTAS.flatMap((p) => arquivosDeCodigo(path.join(RAIZ, p)));
    expect(arquivos.length).toBeGreaterThan(100);
    const achados: string[] = [];
    for (const arq of arquivos) {
      const src = fs.readFileSync(arq, 'utf8');
      for (const m of src.matchAll(ENTRE_ASPAS)) {
        const linha = src.slice(0, m.index).split('\n').length;
        achados.push(`${path.relative(RAIZ, arq).replace(/\\/g, '/')}:${linha} ${m[0]}`);
      }
    }
    expect(achados).toEqual([]);
  });

  it('no shared, os tipos entre aspas só aparecem na lista da agenda do laboratório', () => {
    const dir = path.join(RAIZ, 'packages', 'shared', 'src');
    const comTipo = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.ts'))
      .filter((n) => (fs.readFileSync(path.join(dir, n), 'utf8').match(ENTRE_ASPAS) ?? []).length > 0);
    expect(comTipo).toEqual(['agenda-laboratorio.ts']);
  });

  it('o detector pega as três formas de aspas e só a palavra exata', () => {
    const casos = ["type: 'COLETA'", 'tipo === "PROVA"', 'x = `ENTREGA`', "'COLETAS'", "'coleta'", '// ENTREGA a mensagem'];
    expect(casos.map((c) => (c.match(ENTRE_ASPAS) ?? []).length)).toEqual([1, 1, 1, 0, 0, 0]);
  });
});
