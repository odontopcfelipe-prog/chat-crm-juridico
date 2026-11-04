/**
 * Trava da tela ao vivo: nas telas que podem ser acompanhadas, campo de senha ou
 * chave que aparece (ou pode aparecer) como texto precisa de `data-rr-is-password`.
 * Sem o atributo, o rrweb manda o valor em claro: ele só mascara `type="password"`,
 * e um campo em "mostrar" antes de a gravação começar já está como texto.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const WEB = path.resolve(__dirname, '..', '..', '..', 'web', 'src');
const SENSIVEL = /senha|password|secret|api_?key|token/i;
/** Parece sensível pelo nome, mas não é. */
const NAO_SENSIVEL = /maxTokens/;

function acusar(codigo: string, nome = 'tela.tsx'): string[] {
  const fonte = ts.createSourceFile(nome, codigo, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const achados: string[] = [];
  const visitar = (no: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(no) || ts.isJsxOpeningElement(no)) && no.tagName.getText() === 'input') {
      const props = new Map<string, string>();
      for (const p of no.attributes.properties) {
        if (ts.isJsxAttribute(p)) props.set(p.name.getText(), p.initializer?.getText() ?? 'true');
      }
      const tipo = props.get('type') ?? '';
      const valor = props.get('value') ?? '';
      const alterna = tipo.startsWith('{') && tipo.includes('password');
      const textoSensivel = (tipo === '' || tipo === '"text"') && SENSIVEL.test(valor) && !NAO_SENSIVEL.test(valor);
      if ((alterna || textoSensivel) && !props.has('data-rr-is-password')) {
        const { line } = fonte.getLineAndCharacterOfPosition(no.getStart());
        achados.push(`${nome}:${line + 1}`);
      }
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonte);
  return achados;
}

function telasDe(pasta: string): string[] {
  return fs.readdirSync(pasta, { withFileTypes: true }).flatMap((item) => {
    const caminho = path.join(pasta, item.name);
    if (item.isDirectory()) return telasDe(caminho);
    return item.name.endsWith('.tsx') ? [caminho] : [];
  });
}

describe('campos sensíveis na tela ao vivo', () => {
  it('a própria trava acusa o que vaza e deixa passar o que mascara', () => {
    expect(acusar(`<input type={ver ? 'text' : 'password'} value={chave} />`)).toEqual(['tela.tsx:1']);
    expect(acusar(`<input type="text" value={senha} />`)).toEqual(['tela.tsx:1']);
    expect(acusar(`<input value={form.apiKey} />`)).toEqual(['tela.tsx:1']);
    expect(acusar(`<input type={ver ? 'text' : 'password'} data-rr-is-password value={chave} />`)).toEqual([]);
    expect(acusar(`<input type="text" data-rr-is-password value={senha} />`)).toEqual([]);
    expect(acusar(`<input type="password" value={senha} />`)).toEqual([]);
    expect(acusar(`<input type="text" value={nome} />`)).toEqual([]);
  });

  it('nas telas de verdade, nenhum campo sensível sai em claro', () => {
    const telas = [...telasDe(path.join(WEB, 'app', 'atendimento')), ...telasDe(path.join(WEB, 'components'))];
    expect(telas.length).toBeGreaterThan(100);
    const achados = telas.flatMap((t) => acusar(fs.readFileSync(t, 'utf8'), path.relative(WEB, t)));
    expect(achados).toEqual([]);
  });

  it('o token do MCP fica bloqueado na tela ao vivo', () => {
    const codigo = fs.readFileSync(path.join(WEB, 'app', 'atendimento', 'settings', 'mcp', 'page.tsx'), 'utf8');
    expect(codigo).toMatch(/<code className="rr-block[^"]*"[^>]*>\s*\{token\}/);
    expect(codigo).toMatch(/<pre className="rr-block[^"]*"[^>]*>\s*\{configJson\}/);
  });
});
