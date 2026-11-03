/**
 * Aceite dos termos: a versão gravada no cadastro é a mesma data que as páginas
 * /termos e /privacidade mostram, e as duas telas do /cadastrar mandam a caixa.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { VERSAO_POLITICA_DE_PRIVACIDADE, VERSAO_TERMOS_DE_USO, versaoPorExtenso } from '@crm/shared';
import { aceitouOsTermos, dadosDoAceite } from './aceite-dos-termos';

const WEB = join(__dirname, '..', '..', '..', 'web', 'src');
const ler = (rel: string) => readFileSync(join(WEB, rel), 'utf8');

describe('versão dos textos legais', () => {
  it('as duas versões são datas AAAA-MM-DD e viram data por extenso', () => {
    for (const v of [VERSAO_TERMOS_DE_USO, VERSAO_POLITICA_DE_PRIVACIDADE]) {
      expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(versaoPorExtenso(v)).toMatch(/^\d{1,2} de [a-zç]+ de \d{4}$/);
    }
    expect(versaoPorExtenso('2026-11-02')).toBe('2 de novembro de 2026');
    expect(versaoPorExtenso('2027-03-15')).toBe('15 de março de 2027');
    expect(versaoPorExtenso('2026-13-01')).toBe('2026-13-01');
  });

  it('as páginas mostram a data da versão do pacote compartilhado (nada escrito à mão)', () => {
    const termos = ler('components/legal/termos-de-uso.ts');
    const privacidade = ler('components/legal/politica-de-privacidade.ts');
    expect(termos).toContain('atualizadoEm: versaoPorExtenso(VERSAO_TERMOS_DE_USO)');
    expect(privacidade).toContain('atualizadoEm: versaoPorExtenso(VERSAO_POLITICA_DE_PRIVACIDADE)');
  });
});

describe('aceite no cadastro', () => {
  it('só o booleano true vale', () => {
    expect(aceitouOsTermos(true)).toBe(true);
    for (const v of [false, undefined, null, 'true', 1, {}]) expect(aceitouOsTermos(v)).toBe(false);
  });

  it('a linha gravada leva as versões do servidor e a origem do pedido', () => {
    expect(
      dadosDoAceite('conta-1', { id: 'admin-1', email: 'adm@clinica.teste' }, { source: 'CADASTRO_CLINICA', ip: null, user_agent: null }),
    ).toEqual({
      tenant_id: 'conta-1',
      user_id: 'admin-1',
      email: 'adm@clinica.teste',
      source: 'CADASTRO_CLINICA',
      terms_version: VERSAO_TERMOS_DE_USO,
      privacy_version: VERSAO_POLITICA_DE_PRIVACIDADE,
      ip: null,
      user_agent: null,
    });
  });

  it('as telas da clínica e do laboratório mandam a caixa marcada no corpo do cadastro', () => {
    expect(ler('app/cadastrar/CadastroPage.tsx')).toMatch(/'\/signup', \{[\s\S]*?aceite_termos: accepted,[\s\S]*?\}\);/);
    expect(ler('app/cadastrar/CadastroLaboratorio.tsx')).toMatch(/'\/signup\/laboratorio', \{[\s\S]*?aceite_termos: aceite,[\s\S]*?\}\);/);
  });
});
