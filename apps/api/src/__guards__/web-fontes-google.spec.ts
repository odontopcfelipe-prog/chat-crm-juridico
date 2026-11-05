/**
 * Fonte do Google com lista de pesos derruba o build de vez em quando.
 *
 * Em 04/11/2026, 5 de 25 builds falharam com "next/font/google queries have exactly one entry"
 * (Next 16.1.6, Turbopack), e o erro veio só das duas fontes declaradas com `weight: [...]`.
 * Sem a lista, nenhum falhou. Como a falha é intermitente, quem recolocar a lista pode passar no CI
 * e só descobrir depois, com a imagem do deploy vermelha: por isso a trava é no texto.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '..', '..', '..', 'web', 'src');

function arquivos(pasta: string): string[] {
  return fs.readdirSync(pasta, { withFileTypes: true }).flatMap((item) => {
    const caminho = path.join(pasta, item.name);
    if (item.isDirectory()) return arquivos(caminho);
    return /\.tsx?$/.test(item.name) ? [caminho] : [];
  });
}

const usaFonteDoGoogle = arquivos(SRC).filter((arq) => /from\s+['"]next\/font\/google['"]/.test(fs.readFileSync(arq, 'utf8')));

describe('fontes do Google no web', () => {
  it('o spec achou os arquivos que usam next/font/google', () => {
    expect(usaFonteDoGoogle.length).toBeGreaterThan(0);
  });

  it.each(usaFonteDoGoogle.map((arq) => [path.relative(SRC, arq)]))('%s: sem lista de pesos', (rel) => {
    expect(fs.readFileSync(path.join(SRC, rel), 'utf8')).not.toMatch(/weight:\s*\[/);
  });
});
