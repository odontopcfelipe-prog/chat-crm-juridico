/**
 * F5 do laboratório — documento do cliente (packages/shared/src/documento-br.ts).
 *
 * O cliente do laboratório é um dentista (CPF, opcional) ou uma clínica (CNPJ,
 * obrigatório); o tipo sai do tamanho do documento (11 = dentista, 14 = clínica).
 *   - o CPF dá o MESMO resultado do isValidCPF do web (apps/web/src/lib/utils.ts), que
 *     é lido do próprio fonte aqui (se um dos dois mudar, este spec avisa);
 *   - o CNPJ aceita o formato numérico e o alfanumérico (letras nas 12 primeiras
 *     posições; os 2 dígitos verificadores são sempre números);
 *   - vCpfCnpj devolve '' quando está certo ou vazio, e o motivo quando não está.
 *
 * O spec lê o @crm/shared COMPILADO (dist): depois de mexer no shared, rode
 * `npm run build -w @crm/shared` antes.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { formatCpfCnpj, isValidCnpj, maskCpfCnpjInput, soDocumento, tipoDoDocumento, vCpfCnpj } from '@crm/shared';

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');

/** isValidCPF do web, compilado a partir do fonte (sem importar o app web). */
function isValidCPFDoWeb(): (cpf: string) => boolean {
  const src = fs.readFileSync(path.join(RAIZ, 'apps', 'web', 'src', 'lib', 'utils.ts'), 'utf8').replace(/\r\n/g, '\n');
  // onlyDigits é de uma linha só; se um dia virar bloco, pega até a chave que fecha no começo da linha.
  const auxiliar = /^function onlyDigits\(.*\}[ \t]*$/m.exec(src)?.[0] ?? /^function onlyDigits\([\s\S]*?\n\}/m.exec(src)?.[0];
  const principal = /export function isValidCPF\([\s\S]*?\n\}/.exec(src)?.[0];
  if (!auxiliar || !principal) throw new Error('não achei onlyDigits/isValidCPF em apps/web/src/lib/utils.ts');
  const js = ts.transpileModule(`${auxiliar}\n${principal}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const modulo: { exports: Record<string, unknown> } = { exports: {} };
  new Function('exports', 'module', js)(modulo.exports, modulo);
  return modulo.exports.isValidCPF as (cpf: string) => boolean;
}

/** Gerador determinístico (sem Math.random): os mesmos casos em toda execução. */
function* sequencia(semente: number, n: number): Generator<string> {
  let x = semente;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    yield String(x).padStart(11, '0').slice(-11);
  }
}

/** CPF válido a partir de 9 dígitos (dígitos verificadores calculados). */
function comDigitos(nove: string): string {
  const dv = (base: string, peso: number) => {
    let s = 0;
    for (let i = 0; i < base.length; i++) s += Number(base[i]) * (peso - i);
    const r = (s * 10) % 11;
    return r >= 10 ? 0 : r;
  };
  const d1 = dv(nove, 10);
  return `${nove}${d1}${dv(`${nove}${d1}`, 11)}`;
}

describe('documento-br — CPF igual ao isValidCPF do web', () => {
  const isValidCPF = isValidCPFDoWeb();

  it.each([
    ['529.982.247-25', true],
    ['52998224725', true],
    ['111.444.777-35', true],
    ['123.456.789-09', true],
    ['529.982.247-24', false],
    ['123.456.789-00', false],
    ['111.111.111-11', false],
    ['000.000.000-00', false],
  ])('%s → válido=%s (e o web concorda)', (cpf, valido) => {
    expect(isValidCPF(cpf)).toBe(valido);
    expect(vCpfCnpj(cpf, 'DENTISTA') === '').toBe(valido);
    expect(vCpfCnpj(cpf) === '').toBe(valido);
    if (!valido) expect(vCpfCnpj(cpf, 'DENTISTA')).toBe('CPF inválido');
  });

  it('300 números quaisquer e 300 CPFs válidos: o mesmo resultado do web em todos', () => {
    const diferentes: string[] = [];
    const casos = [...sequencia(7, 300), ...[...sequencia(11, 300)].map((s) => comDigitos(s.slice(0, 9)))];
    for (const cpf of casos) {
      if ((vCpfCnpj(cpf, 'DENTISTA') === '') !== isValidCPF(cpf)) diferentes.push(cpf);
    }
    expect(diferentes).toEqual([]);
    // Os gerados com dígito verificador são de fato válidos (o teste compara os dois lados).
    expect(casos.slice(300).filter((c) => !/^(\d)\1{10}$/.test(c)).every((c) => isValidCPF(c))).toBe(true);
  });
});

describe('documento-br — CNPJ numérico e alfanumérico', () => {
  it.each([
    ['11.222.333/0001-81', true],
    ['11222333000181', true],
    ['11.444.777/0001-61', true],
    ['12.ABC.345/01DE-35', true],
    ['12abc34501de35', true],
    ['A1.B2C.3D4/E5F6-68', true],
    ['11.222.333/0001-80', false],
    ['12.ABC.345/01DE-36', false],
    ['00.000.000/0000-00', false],
    ['11.111.111/1111-11', false],
    ['12.ABC.345/01DE-3X', false],
    ['1122233300018', false],
    ['112223330001811', false],
    ['', false],
  ])('%s → válido=%s', (cnpj, valido) => {
    expect(isValidCnpj(cnpj)).toBe(valido);
  });

  it('vCpfCnpj com o tipo da clínica', () => {
    expect(vCpfCnpj('11.222.333/0001-81', 'CLINICA')).toBe('');
    expect(vCpfCnpj('12.ABC.345/01DE-35', 'CLINICA')).toBe('');
    expect(vCpfCnpj('11.222.333/0001-80', 'CLINICA')).toBe('CNPJ inválido');
    expect(vCpfCnpj('11.222.333/0001', 'CLINICA')).toBe('Faltam 2 dígito(s)');
    expect(vCpfCnpj('112223330001811', 'CLINICA')).toBe('CNPJ inválido');
  });
});

describe('documento-br — vCpfCnpj, máscara, exibição e tipo', () => {
  it("vazio é '' (o CPF do dentista é opcional) e falta de dígito diz quantos", () => {
    expect(vCpfCnpj('')).toBe('');
    expect(vCpfCnpj('', 'CLINICA')).toBe('');
    expect(vCpfCnpj('  ', 'DENTISTA')).toBe('');
    expect(vCpfCnpj('123', 'DENTISTA')).toBe('Faltam 8 dígito(s)');
    expect(vCpfCnpj('5299822472')).toBe('Faltam 1 dígito(s)');
    // Sem tipo: até 11 posições é CPF; acima disso, CNPJ.
    expect(vCpfCnpj('112223330001')).toBe('Faltam 2 dígito(s)');
    expect(vCpfCnpj('11222333000181')).toBe('');
  });

  it('soDocumento: maiúsculas e só [0-9A-Z]', () => {
    expect(soDocumento(' ab.c-1/2 ')).toBe('ABC12');
    expect(soDocumento(null)).toBe('');
    expect(soDocumento(undefined)).toBe('');
  });

  it('máscara do CPF conforme digita (só números)', () => {
    expect(maskCpfCnpjInput('529', 'DENTISTA')).toBe('529');
    expect(maskCpfCnpjInput('5299', 'DENTISTA')).toBe('529.9');
    expect(maskCpfCnpjInput('5299822', 'DENTISTA')).toBe('529.982.2');
    expect(maskCpfCnpjInput('52998224725', 'DENTISTA')).toBe('529.982.247-25');
    expect(maskCpfCnpjInput('529.982.247-2599', 'DENTISTA')).toBe('529.982.247-25');
    expect(maskCpfCnpjInput('52a99', 'DENTISTA')).toBe('529.9');
  });

  it('máscara do CNPJ conforme digita (letra só nas 12 primeiras posições)', () => {
    expect(maskCpfCnpjInput('12A', 'CLINICA')).toBe('12.A');
    expect(maskCpfCnpjInput('12ABC', 'CLINICA')).toBe('12.ABC');
    expect(maskCpfCnpjInput('12ABC345', 'CLINICA')).toBe('12.ABC.345');
    expect(maskCpfCnpjInput('12ABC34501', 'CLINICA')).toBe('12.ABC.345/01');
    expect(maskCpfCnpjInput('12abc34501de35', 'CLINICA')).toBe('12.ABC.345/01DE-35');
    expect(maskCpfCnpjInput('11222333000181', 'CLINICA')).toBe('11.222.333/0001-81');
    // Letra nos dígitos verificadores não entra.
    expect(maskCpfCnpjInput('12ABC34501DEXY', 'CLINICA')).toBe('12.ABC.345/01DE');
  });

  it('formatCpfCnpj: 11 → CPF, 14 → CNPJ, outro tamanho como veio, vazio → ""', () => {
    expect(formatCpfCnpj('52998224725')).toBe('529.982.247-25');
    expect(formatCpfCnpj('529.982.247-25')).toBe('529.982.247-25');
    expect(formatCpfCnpj('11222333000181')).toBe('11.222.333/0001-81');
    expect(formatCpfCnpj('12abc34501de35')).toBe('12.ABC.345/01DE-35');
    expect(formatCpfCnpj('12345')).toBe('12345');
    expect(formatCpfCnpj('')).toBe('');
    expect(formatCpfCnpj(null)).toBe('');
    expect(formatCpfCnpj(undefined)).toBe('');
  });

  it('tipoDoDocumento: 11 → DENTISTA, 14 → CLINICA, outro → null', () => {
    expect(tipoDoDocumento('529.982.247-25')).toBe('DENTISTA');
    expect(tipoDoDocumento('11.222.333/0001-81')).toBe('CLINICA');
    expect(tipoDoDocumento('12.ABC.345/01DE-35')).toBe('CLINICA');
    expect(tipoDoDocumento('123')).toBeNull();
    expect(tipoDoDocumento('')).toBeNull();
    expect(tipoDoDocumento(null)).toBeNull();
  });

  it('o módulo é puro: sem pickBt, sem const LAB_, sem Prisma e sem Nest', () => {
    const src = fs.readFileSync(path.join(RAIZ, 'packages', 'shared', 'src', 'documento-br.ts'), 'utf8');
    expect(src).not.toMatch(/\bpickBt\s*\(/);
    expect(src).not.toMatch(/\b(const|let|var)\s+LAB_/);
    expect(src).not.toMatch(/from ['"](@prisma|@nestjs|react)/);
  });
});
