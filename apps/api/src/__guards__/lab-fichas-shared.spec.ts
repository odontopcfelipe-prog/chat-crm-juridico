/**
 * F8 do laboratório — regras puras das fichas (packages/shared/src/lab-fichas.ts),
 * lidas do @crm/shared COMPILADO (o mesmo que API e web importam).
 *
 * Datas do caso: 'AAAA-MM-DD' = dia em UTC; "hoje" = dia de Maceió (UTC-3 fixo).
 * O resultado não pode depender do fuso do servidor nem do navegador.
 */
import {
  CAMPOS_DA_FICHA_TECNICA,
  CAMPOS_DO_CASO,
  CAMPOS_DO_PERFIL,
  CRO_MAX_DIGITOS,
  DIAS_SEM_ORCAMENTO_PARA_INATIVO,
  GARANTIA_MAX_DIAS,
  LIMITES_DA_FICHA,
  LIMITES_DO_CASO,
  LIMITES_DO_PERFIL,
  MAX_DENTISTAS_SOLICITANTES,
  PRAZO_MAX_DIAS,
  TIPOS_DE_CLIENTE,
  UFS_DO_BRASIL,
  UNIDADES_DO_SERVICO,
  dataDoDia,
  dataParaYmd,
  diasAte,
  entregaSugerida,
  formatarYmdBR,
  hojeEmMaceio,
  linkDoEscaneamentoValido,
  normalizarCro,
  normalizarDentistas,
  somarDiasYmd,
  tipoDoCliente,
  validarPerfilDoCliente,
} from '@crm/shared';

/** Roda fn com o fuso do processo trocado (o Node relê process.env.TZ na hora). */
function comFuso<R>(tz: string, fn: () => R): R {
  const antes = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (antes === undefined) delete process.env.TZ;
    else process.env.TZ = antes;
  }
}

describe('F8 — constantes das fichas', () => {
  it('listas e limites do contrato', () => {
    expect([...TIPOS_DE_CLIENTE]).toEqual(['DENTISTA', 'CLINICA']);
    expect([...UNIDADES_DO_SERVICO]).toEqual(['ELEMENTO', 'ARCADA', 'PECA']);
    expect(UFS_DO_BRASIL).toHaveLength(27);
    expect(new Set(UFS_DO_BRASIL).size).toBe(27);
    expect({ DIAS_SEM_ORCAMENTO_PARA_INATIVO, MAX_DENTISTAS_SOLICITANTES, PRAZO_MAX_DIAS, GARANTIA_MAX_DIAS, CRO_MAX_DIGITOS }).toEqual({
      DIAS_SEM_ORCAMENTO_PARA_INATIVO: 90,
      MAX_DENTISTAS_SOLICITANTES: 30,
      PRAZO_MAX_DIAS: 365,
      GARANTIA_MAX_DIAS: 3650,
      CRO_MAX_DIGITOS: 8,
    });
    expect(LIMITES_DO_PERFIL).toEqual({ legal_name: 160, clinic_name: 160, contact_name: 160, contact_phone: 20, dentista: 120, delivery_notes: 1000 });
    expect(LIMITES_DA_FICHA).toEqual({ default_material: 80 });
    expect(LIMITES_DO_CASO).toEqual({ patient_ref: 120, requested_by_name: 120, shade: 40, material: 80, instructions: 2000, external_files_url: 500 });
    for (const o of [LIMITES_DO_PERFIL, LIMITES_DA_FICHA, LIMITES_DO_CASO]) expect(Object.isFrozen(o)).toBe(true);
    expect(CAMPOS_DO_PERFIL).toHaveLength(9);
    expect(CAMPOS_DA_FICHA_TECNICA).toHaveLength(6);
    expect(CAMPOS_DO_CASO).toHaveLength(8);
  });
});

describe('F8 — datas do caso', () => {
  it('dataDoDia faz ida e volta e recusa dia que não existe', () => {
    const d = dataDoDia('2026-11-05');
    expect(d?.toISOString()).toBe('2026-11-05T00:00:00.000Z');
    expect(dataParaYmd(d)).toBe('2026-11-05');
    expect(dataDoDia('2028-02-29')?.toISOString()).toBe('2028-02-29T00:00:00.000Z');
    for (const ruim of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '2026-1-5', '05/11/2026', '', null, undefined, 20261105]) {
      expect([ruim, dataDoDia(ruim)]).toEqual([ruim, null]);
    }
    expect(dataParaYmd(null)).toBeNull();
    expect(dataParaYmd('2026-11-05T00:00:00.000Z')).toBe('2026-11-05');
    expect(dataParaYmd('lixo')).toBeNull();
  });

  it('hojeEmMaceio: às 01:00 UTC ainda é o dia anterior; às 03:00 UTC já virou', () => {
    expect(hojeEmMaceio(Date.parse('2026-11-05T01:00:00.000Z'))).toBe('2026-11-04');
    expect(hojeEmMaceio(Date.parse('2026-11-05T02:59:59.999Z'))).toBe('2026-11-04');
    expect(hojeEmMaceio(Date.parse('2026-11-05T03:00:00.000Z'))).toBe('2026-11-05');
    expect(hojeEmMaceio(Date.parse('2027-01-01T01:00:00.000Z'))).toBe('2026-12-31');
  });

  it('somarDiasYmd e diasAte em dias corridos', () => {
    expect(somarDiasYmd('2026-01-30', 2)).toBe('2026-02-01');
    expect(somarDiasYmd('2026-03-01', -1)).toBe('2026-02-28');
    expect(somarDiasYmd('2026-02-30', 1)).toBeNull();
    expect(somarDiasYmd('2026-02-01', 1.5)).toBeNull();
    expect(diasAte('2026-11-10', '2026-11-05')).toBe(5);
    expect(diasAte('2026-11-01', '2026-11-05')).toBe(-4);
    expect(diasAte('2026-11-05', '2026-11-05')).toBe(0);
    expect(diasAte('2026-02-30', '2026-11-05')).toBeNull();
  });

  it('entregaSugerida: maior prazo > 0, ignora nulo e zero, vira o mês e o ano', () => {
    expect(entregaSugerida([3, null, 7, undefined, 0], '2026-11-05')).toEqual({ data: '2026-11-12', dias: 7 });
    expect(entregaSugerida([5], '2026-01-29')).toEqual({ data: '2026-02-03', dias: 5 });
    expect(entregaSugerida([10], '2026-12-28')).toEqual({ data: '2027-01-07', dias: 10 });
    expect(entregaSugerida([null, 0, undefined], '2026-11-05')).toBeNull();
    expect(entregaSugerida([], '2026-11-05')).toBeNull();
    expect(entregaSugerida([-3, 2.5], '2026-11-05')).toBeNull();
    expect(entregaSugerida([4], '2026-02-30')).toBeNull();
  });

  it('o mesmo resultado com TZ=UTC e TZ=America/Maceio', () => {
    const rodar = () => ({
      hoje: hojeEmMaceio(Date.parse('2026-11-05T01:30:00.000Z')),
      sugerida: entregaSugerida([7, 3], '2026-12-28'),
      dia: dataDoDia('2026-11-05')?.toISOString(),
      ymd: dataParaYmd(new Date('2026-11-05T00:00:00.000Z')),
      soma: somarDiasYmd('2026-10-31', 1),
      ate: diasAte('2026-11-10', '2026-11-05'),
      br: formatarYmdBR('2026-11-05'),
    });
    const utc = comFuso('UTC', rodar);
    const maceio = comFuso('America/Maceio', rodar);
    expect(maceio).toEqual(utc);
    expect(utc).toEqual({
      hoje: '2026-11-04',
      sugerida: { data: '2027-01-04', dias: 7 },
      dia: '2026-11-05T00:00:00.000Z',
      ymd: '2026-11-05',
      soma: '2026-11-01',
      ate: 5,
      br: '05/11/2026',
    });
  });

  it('formatarYmdBR', () => {
    expect(formatarYmdBR('2026-11-05')).toBe('05/11/2026');
    expect(formatarYmdBR('2026-11-05T00:00:00.000Z')).toBe('05/11/2026');
    expect(formatarYmdBR('')).toBe('');
    expect(formatarYmdBR(null)).toBe('');
    expect(formatarYmdBR('2026-02-30')).toBe('');
  });
});

describe('F8 — ficha do cliente', () => {
  it('tipoDoCliente: o gravado vale; senão o documento; senão dentista', () => {
    expect(tipoDoCliente('CLINICA', '111.111.111-11')).toBe('CLINICA');
    expect(tipoDoCliente('DENTISTA', '11.111.111/1111-11')).toBe('DENTISTA');
    expect(tipoDoCliente(null, '111.111.111-11')).toBe('DENTISTA');
    expect(tipoDoCliente(null, '11.111.111/1111-11')).toBe('CLINICA');
    expect(tipoDoCliente(null, '')).toBe('DENTISTA');
    expect(tipoDoCliente('OUTRO', null)).toBe('DENTISTA');
    expect(tipoDoCliente(undefined, undefined)).toBe('DENTISTA');
  });

  it('normalizarCro: só dígitos, de 1 a 8', () => {
    expect(normalizarCro('12.345')).toBe('12345');
    expect(normalizarCro(' 1-2 3 ')).toBe('123');
    expect(normalizarCro('12345678')).toBe('12345678');
    expect(normalizarCro('123456789')).toBeNull();
    expect(normalizarCro('')).toBeNull();
    expect(normalizarCro('.-')).toBeNull();
    expect(normalizarCro(null)).toBeNull();
    expect(normalizarCro(4321)).toBe('4321');
  });

  it('normalizarDentistas: apara, junta espaços, tira vazios e repetidos sem acento nem maiúscula', () => {
    expect(normalizarDentistas(['  Dra.  Ana   Souza ', 'dra. ana souza', 'Dr. José', 'DR. JOSE', '', '   ', 'Dr. João'])).toEqual([
      'Dra. Ana Souza',
      'Dr. José',
      'Dr. João',
    ]);
    expect(normalizarDentistas(null)).toEqual([]);
    expect(normalizarDentistas(['Ana', 7, null, 'Bia'])).toEqual(['Ana', 'Bia']);
  });

  it('validarPerfilDoCliente: tabela-verdade', () => {
    const casos: Array<[Parameters<typeof validarPerfilDoCliente>[0], string | null]> = [
      [{ kind: 'DENTISTA', cro_number: '12345', cro_uf: 'AL' }, null],
      [{ kind: 'DENTISTA', cro_number: null, cro_uf: null }, 'croObrigatorio'],
      [{ kind: 'DENTISTA', cro_number: '12345', cro_uf: null }, 'croObrigatorio'],
      [{ kind: 'DENTISTA', cro_number: null, cro_uf: 'AL' }, 'croObrigatorio'],
      [{ kind: 'DENTISTA', cro_number: '', cro_uf: '' }, 'croObrigatorio'],
      [{ kind: 'CLINICA', cro_number: null, cro_uf: null }, null],
      [{ kind: 'CLINICA', cro_number: '987', cro_uf: 'PE' }, null],
      [{ kind: 'CLINICA', cro_number: '987', cro_uf: null }, 'croEmPar'],
      [{ kind: 'CLINICA', cro_number: null, cro_uf: 'PE' }, 'croEmPar'],
      [{ kind: 'CLINICA', cro_number: '123456789', cro_uf: 'PE' }, 'croInvalido'],
      [{ kind: 'DENTISTA', cro_number: '123', cro_uf: 'XX' }, 'ufInvalida'],
      [{ kind: 'CLINICA', cro_number: null, cro_uf: null, requesting_dentists: Array.from({ length: 30 }, (_, i) => `D${i}`) }, null],
      [{ kind: 'CLINICA', cro_number: null, cro_uf: null, requesting_dentists: Array.from({ length: 31 }, (_, i) => `D${i}`) }, 'dentistasDemais'],
    ];
    for (const [entrada, esperado] of casos) expect([entrada, validarPerfilDoCliente(entrada)]).toEqual([entrada, esperado]);
  });
});

describe('F8 — link do escaneamento', () => {
  it('só http e https', () => {
    expect(linkDoEscaneamentoValido('https://drive.example.com/arquivo?id=1')).toBe(true);
    expect(linkDoEscaneamentoValido('http://exemplo.com.br')).toBe(true);
    for (const ruim of ['javascript:alert(1)', 'ftp://exemplo.com', 'exemplo.com', 'https://', 'https:// exemplo.com', 'data:text/html,x', '', null, 42]) {
      expect([ruim, linkDoEscaneamentoValido(ruim)]).toEqual([ruim, false]);
    }
    expect(linkDoEscaneamentoValido(`https://exemplo.com/${'a'.repeat(500)}`)).toBe(false);
  });
});
