/**
 * F8 do laboratório — validação dos 3 PUT das fichas, com o MESMO ValidationPipe
 * global da API (whitelist + transform + forbidNonWhitelisted, main.ts) e o serviço
 * de verdade sobre um banco simulado.
 *
 * O PUT é parcial: chave ausente mantém, null limpa. As regras que dependem do
 * gravado (CRO do dentista, prazo e unidade na criação) valem no registro mesclado.
 * Toda mensagem é texto do laboratório (LAB_FICHAS_API).
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { PermissionsGuard } from '../auth/decorators/requires-permission.decorator';
import { LabFichasService } from './lab-fichas.service';
import { LAB_FICHAS_API as T } from './lab-fichas-textos';
import { PutPatientLabProfileDto, PutProcedureLabSpecDto, PutQuoteLabCaseDto } from './dto/lab-fichas.dto';

const A = 'lab-a';
type Reg = Record<string, any>;

function montar() {
  const quando = new Date('2026-10-20T12:00:00.000Z');
  const db: Record<string, Reg[]> = {
    user: [
      { id: 'adm-a', sector: 'admin', extra_grants: [], extra_revokes: [] },
      { id: 'sem-contato-a', sector: 'dentista', extra_grants: ['view_all_patients'], extra_revokes: [] },
    ],
    patient: [
      { id: 'cli-cpf', tenant_id: A, cpf: '111.111.111-11' },
      { id: 'cli-cnpj', tenant_id: A, cpf: '11.111.111/1111-11' },
      { id: 'cli-gravado', tenant_id: A, cpf: '11.111.111/1111-11' },
      { id: 'cli-dentista-gravado', tenant_id: A, cpf: '111.111.111-11' },
    ],
    procedure: [
      { id: 'serv-novo', tenant_id: A },
      { id: 'serv-gravado', tenant_id: A },
    ],
    quote: [
      { id: 'orc-a', patient_id: 'cli-cnpj', deleted_at: null, accepted_from_id: null, renegotiated_from_id: null },
      { id: 'orc-gravado', patient_id: 'cli-cnpj', deleted_at: null, accepted_from_id: null, renegotiated_from_id: null },
    ],
    patientLabProfile: [
      {
        patient_id: 'cli-gravado',
        tenant_id: A,
        kind: 'CLINICA',
        cro_number: null,
        cro_uf: null,
        legal_name: 'Razão Gravada',
        clinic_name: 'Clínica Gravada',
        contact_name: 'Contato Gravado',
        contact_phone: '(00) 90000-0000',
        requesting_dentists: ['Dra. Ana'],
        delivery_notes: 'Portaria',
        updated_at: quando,
      },
      {
        patient_id: 'cli-dentista-gravado',
        tenant_id: A,
        kind: 'DENTISTA',
        cro_number: '1234',
        cro_uf: 'AL',
        legal_name: null,
        clinic_name: null,
        contact_name: null,
        contact_phone: null,
        requesting_dentists: [],
        delivery_notes: null,
        updated_at: quando,
      },
    ],
    procedureLabSpec: [
      { procedure_id: 'serv-gravado', tenant_id: A, lead_time_days: 5, warranty_days: 90, unit: 'ELEMENTO', default_material: 'Zircônia', needs_shade: true, has_tryin: false, updated_at: quando },
    ],
    quoteLabCase: [
      {
        quote_id: 'orc-gravado',
        tenant_id: A,
        patient_ref: 'Iniciais do caso',
        requested_by_name: 'Dra. Ana',
        shade: 'A2',
        material: 'Dissilicato',
        due_date: new Date('2026-11-20T00:00:00.000Z'),
        instructions: 'Contato forte',
        external_files_url: 'https://arquivos.example.com/caso/1',
        received_at: new Date('2026-10-18T00:00:00.000Z'),
        updated_at: quando,
      },
    ],
  };
  const casa = (tabela: string, r: Reg, where: Reg = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v === undefined) return true;
      if (k === 'patient' && tabela === 'quote') return db.patient.find((p) => p.id === r.patient_id)?.tenant_id === v.tenant_id;
      return r[k] === v;
    });
  const prisma: any = {};
  for (const tabela of Object.keys(db)) {
    prisma[tabela] = {
      findFirst: jest.fn(async (a: Reg = {}) => db[tabela].find((r) => casa(tabela, r, a.where)) ?? null),
      findUnique: jest.fn(async (a: Reg = {}) => db[tabela].find((r) => casa(tabela, r, a.where)) ?? null),
      findMany: jest.fn(async (a: Reg = {}) => db[tabela].filter((r) => casa(tabela, r, a.where))),
      upsert: jest.fn(async (a: Reg) => {
        const atual = db[tabela].find((r) => casa(tabela, r, a.where));
        if (atual) return Object.assign(atual, a.update, { updated_at: quando });
        const novo = { ...a.create, updated_at: quando };
        db[tabela].push(novo);
        return novo;
      }),
      update: jest.fn(async (a: Reg) => Object.assign(db[tabela].find((r) => casa(tabela, r, a.where))!, a.data)),
    };
  }
  return { db, prisma, service: new LabFichasService(prisma) };
}

const ADM = { id: 'adm-a', roles: ['ADMIN'] };
const SEM_CONTATO = { id: 'sem-contato-a', roles: ['DENTIST'] };

/** Mesmo ValidationPipe global da API (main.ts). */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const perfil = (body: unknown) => pipe.transform(body, { type: 'body', metatype: PutPatientLabProfileDto }) as Promise<PutPatientLabProfileDto>;
const ficha = (body: unknown) => pipe.transform(body, { type: 'body', metatype: PutProcedureLabSpecDto }) as Promise<PutProcedureLabSpecDto>;
const caso = (body: unknown) => pipe.transform(body, { type: 'body', metatype: PutQuoteLabCaseDto }) as Promise<PutQuoteLabCaseDto>;

/** As mensagens do 400 (texto ou lista do ValidationPipe), sem repetição. */
async function erro400(p: Promise<unknown>): Promise<string[]> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    const m = ((e as BadRequestException).getResponse() as { message: string | string[] }).message;
    return [...new Set(Array.isArray(m) ? m : [m])];
  }
  throw new Error('esperava 400');
}

beforeEach(() => {
  PermissionsGuard.invalidate('adm-a');
  PermissionsGuard.invalidate('sem-contato-a');
});

describe('PUT das fichas — corpo (ValidationPipe)', () => {
  it.each([
    ['perfil', { gravado: true }, perfil],
    ['perfil', { tenant_id: 'lab-b' }, perfil],
    ['perfil', { patient_id: 'x' }, perfil],
    ['ficha', { procedure_id: 'x' }, ficha],
    ['ficha', { tenant_id: 'lab-b' }, ficha],
    ['caso', { herdado_de: 'orc-x' }, caso],
    ['caso', { gravado: false }, caso],
    ['caso', { quote_id: 'x', tenant_id: 'lab-b' }, caso],
  ])('%s com campo desconhecido %j → 400', async (_n, body, validar) => {
    await expect(validar(body)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('kind fora da lista, UF inválida e CRO com letra → 400 com o texto do laboratório', async () => {
    expect(await erro400(perfil({ kind: 'OUTRO' }))).toEqual([T.tipoInvalido]);
    expect(await erro400(perfil({ cro_uf: 'XX' }))).toEqual([T.ufInvalida]);
    expect(await erro400(perfil({ cro_uf: 'al' }))).toEqual([T.ufInvalida]);
    expect(await erro400(perfil({ cro_number: '12A45' }))).toEqual([T.croInvalido]);
  });

  it('31 dentistas solicitantes, nome longo ou item que não é texto → 400', async () => {
    const trinta = Array.from({ length: 30 }, (_, i) => `Dr. ${i}`);
    await expect(perfil({ requesting_dentists: trinta })).resolves.toBeInstanceOf(PutPatientLabProfileDto);
    expect(await erro400(perfil({ requesting_dentists: [...trinta, 'Dr. 31'] }))).toContain(T.dentistasDemais);
    expect(await erro400(perfil({ requesting_dentists: ['x'.repeat(121)] }))).toEqual([T.textoLongo(T.campos.dentista, 120)]);
    expect(await erro400(perfil({ requesting_dentists: [7] }))).toContain(T.listaInvalida);
    expect(await erro400(perfil({ requesting_dentists: 'Dr. Um' }))).toContain(T.listaInvalida);
  });

  it('textos acima do limite → 400', async () => {
    expect(await erro400(perfil({ legal_name: 'x'.repeat(161) }))).toEqual([T.textoLongo(T.campos.legal_name, 160)]);
    expect(await erro400(perfil({ delivery_notes: 'x'.repeat(1001) }))).toEqual([T.textoLongo(T.campos.delivery_notes, 1000)]);
    expect(await erro400(caso({ patient_ref: 'x'.repeat(121) }))).toEqual([T.textoLongo(T.campos.patient_ref, 120)]);
    expect(await erro400(caso({ instructions: 'x'.repeat(2001) }))).toEqual([T.textoLongo(T.campos.instructions, 2000)]);
    expect(await erro400(ficha({ default_material: 'x'.repeat(81) }))).toEqual([T.textoLongo(T.campos.default_material, 80)]);
  });

  it('prazo -1, 366, 2.5 ou texto → 400; garantia 3651 → 400; unidade fora da lista → 400', async () => {
    for (const lead_time_days of [-1, 366, 2.5, '5']) {
      expect(await erro400(ficha({ lead_time_days }))).toEqual([T.prazoInvalido]);
    }
    expect(await erro400(ficha({ warranty_days: 3651 }))).toEqual([T.garantiaInvalida]);
    expect(await erro400(ficha({ unit: 'METRO' }))).toEqual([T.unidadeInvalida]);
    expect(await erro400(ficha({ needs_shade: 'sim' }))).toEqual([T.booleano]);
    await expect(ficha({ lead_time_days: 0, warranty_days: null, unit: 'PECA' })).resolves.toBeInstanceOf(PutProcedureLabSpecDto);
    await expect(ficha({ lead_time_days: 365 })).resolves.toBeInstanceOf(PutProcedureLabSpecDto);
  });

  it("link 'javascript:alert(1)', ftp ou sem protocolo → 400; data fora do formato → 400", async () => {
    for (const external_files_url of ['javascript:alert(1)', 'ftp://arquivos.example.com/x', 'arquivos.example.com/x']) {
      expect(await erro400(caso({ external_files_url }))).toEqual([T.linkInvalido]);
    }
    expect(await erro400(caso({ due_date: '05/11/2026' }))).toEqual([T.dataInvalida]);
    expect(await erro400(caso({ received_at: '2026-11-5' }))).toEqual([T.dataInvalida]);
  });

  it('corpo vazio, null e texto vazio passam no corpo (o serviço decide)', async () => {
    await expect(perfil({})).resolves.toBeInstanceOf(PutPatientLabProfileDto);
    await expect(perfil({ kind: '', cro_number: '', cro_uf: '', legal_name: null })).resolves.toBeInstanceOf(PutPatientLabProfileDto);
    await expect(caso({ due_date: '', external_files_url: '', received_at: null })).resolves.toBeInstanceOf(PutQuoteLabCaseDto);
  });

  it('o DTO não inventa chave (sem valor padrão): só vem o que o corpo mandou', async () => {
    const dto = await perfil({ clinic_name: 'Só esta' });
    expect(Object.entries(dto).filter(([, v]) => v !== undefined)).toEqual([['clinic_name', 'Só esta']]);
  });
});

describe('PUT do perfil — regras no registro mesclado', () => {
  it('DENTISTA (pelo CPF) sem CRO ou sem UF → 400 e nada gravado', async () => {
    const m = montar();
    expect(await erro400(m.service.gravarPerfil(ADM, A, 'cli-cpf', await perfil({ legal_name: 'X' })))).toEqual([T.croObrigatorio]);
    expect(await erro400(m.service.gravarPerfil(ADM, A, 'cli-cpf', await perfil({ cro_number: '123' })))).toEqual([T.croObrigatorio]);
    // Gravado com CRO e UF: limpar a UF deixa o dentista sem CRO completo.
    expect(await erro400(m.service.gravarPerfil(ADM, A, 'cli-dentista-gravado', await perfil({ cro_uf: null })))).toEqual([T.croObrigatorio]);
    expect(m.prisma.patientLabProfile.upsert).not.toHaveBeenCalled();
  });

  it('CLINICA com CRO sem UF (ou UF sem CRO) → 400; CRO só com pontos → 400', async () => {
    const m = montar();
    expect(await erro400(m.service.gravarPerfil(ADM, A, 'cli-cnpj', await perfil({ cro_number: '987' })))).toEqual([T.croEmPar]);
    expect(await erro400(m.service.gravarPerfil(ADM, A, 'cli-cnpj', await perfil({ cro_uf: 'PE' })))).toEqual([T.croEmPar]);
    expect(await erro400(m.service.gravarPerfil(ADM, A, 'cli-cnpj', await perfil({ kind: 'CLINICA', cro_number: '.-.', cro_uf: 'PE' })))).toEqual([
      T.croInvalido,
    ]);
    expect(m.prisma.patientLabProfile.upsert).not.toHaveBeenCalled();
  });

  it('CLINICA sem CRO grava; CRO normalizado; dentistas sem repetição; DENTISTA grava a lista vazia', async () => {
    const m = montar();
    const r = await m.service.gravarPerfil(
      ADM,
      A,
      'cli-cnpj',
      await perfil({ cro_number: '12.345', cro_uf: 'AL', requesting_dentists: [' Dra.  Ana ', 'dra. ana', 'Dr. José', 'DR. JOSE', ''] }),
    );
    expect(r).toMatchObject({ gravado: true, kind: 'CLINICA', cro_number: '12345', cro_uf: 'AL', requesting_dentists: ['Dra. Ana', 'Dr. José'] });
    const d = await m.service.gravarPerfil(ADM, A, 'cli-cpf', await perfil({ cro_number: '555', cro_uf: 'SE', requesting_dentists: ['Dr. Fulano'] }));
    expect(d).toMatchObject({ kind: 'DENTISTA', cro_number: '555', cro_uf: 'SE', requesting_dentists: [] });
  });

  it('o tipo gravado vale mais que o documento; kind null ou vazio volta para o documento', async () => {
    const m = montar();
    await expect(m.service.gravarPerfil(ADM, A, 'cli-cpf', await perfil({ kind: 'CLINICA' }))).resolves.toMatchObject({ kind: 'CLINICA' });
    await expect(m.service.lerPerfil(A, 'cli-cpf')).resolves.toMatchObject({ kind: 'CLINICA', gravado: true });
    expect(await erro400(m.service.gravarPerfil(ADM, A, 'cli-cpf', await perfil({ kind: '' })))).toEqual([T.croObrigatorio]);
  });

  it('PUT parcial: o que não veio fica, null limpa', async () => {
    const m = montar();
    const r = await m.service.gravarPerfil(ADM, A, 'cli-gravado', await perfil({ clinic_name: null, delivery_notes: '  Entregar após 14h ' }));
    expect(r).toMatchObject({
      kind: 'CLINICA',
      legal_name: 'Razão Gravada',
      clinic_name: null,
      contact_name: 'Contato Gravado',
      contact_phone: '(00) 90000-0000',
      requesting_dentists: ['Dra. Ana'],
      delivery_notes: 'Entregar após 14h',
    });
    expect(m.prisma.patientLabProfile.upsert.mock.calls[0][0].update).not.toHaveProperty('tenant_id');
  });

  it('sem view_patient_contact o contact_phone do corpo é ignorado (o null reenviado não apaga)', async () => {
    const m = montar();
    const r = await m.service.gravarPerfil(SEM_CONTATO, A, 'cli-gravado', await perfil({ contact_phone: null, contact_name: 'Novo contato' }));
    expect(r).toMatchObject({ contact_phone: '(00) 90000-0000', contact_name: 'Novo contato' });
    await m.service.gravarPerfil(SEM_CONTATO, A, 'cli-gravado', await perfil({ contact_phone: '(00) 91111-1111' }));
    expect(m.db.patientLabProfile.find((p) => p.patient_id === 'cli-gravado')!.contact_phone).toBe('(00) 90000-0000');
    // Quem vê contato grava (texto aparado, só exibição).
    await m.service.gravarPerfil(ADM, A, 'cli-gravado', await perfil({ contact_phone: ' (00) 92222-2222 ' }));
    expect(m.db.patientLabProfile.find((p) => p.patient_id === 'cli-gravado')!.contact_phone).toBe('(00) 92222-2222');
  });
});

describe('PUT da ficha técnica — criação e parcial', () => {
  it('criação sem unidade ou sem prazo → 400; limpar o prazo → 400', async () => {
    const m = montar();
    expect(await erro400(m.service.gravarFicha(A, 'serv-novo', await ficha({ lead_time_days: 5 })))).toEqual([T.prazoEUnidade]);
    expect(await erro400(m.service.gravarFicha(A, 'serv-novo', await ficha({ unit: 'ARCADA' })))).toEqual([T.prazoEUnidade]);
    expect(await erro400(m.service.gravarFicha(A, 'serv-novo', await ficha({ unit: '', lead_time_days: 3 })))).toEqual([T.prazoEUnidade]);
    expect(await erro400(m.service.gravarFicha(A, 'serv-gravado', await ficha({ lead_time_days: null })))).toEqual([T.prazoEUnidade]);
    expect(m.prisma.procedureLabSpec.upsert).not.toHaveBeenCalled();
  });

  it('criação com prazo e unidade grava os padrões; parcial mantém o resto e null limpa', async () => {
    const m = montar();
    await expect(m.service.gravarFicha(A, 'serv-novo', await ficha({ lead_time_days: 0, unit: 'PECA' }))).resolves.toEqual({
      procedure_id: 'serv-novo',
      ficha: { lead_time_days: 0, warranty_days: null, unit: 'PECA', default_material: null, needs_shade: false, has_tryin: false },
    });
    await expect(m.service.gravarFicha(A, 'serv-gravado', await ficha({ has_tryin: true, default_material: null }))).resolves.toEqual({
      procedure_id: 'serv-gravado',
      ficha: { lead_time_days: 5, warranty_days: 90, unit: 'ELEMENTO', default_material: null, needs_shade: true, has_tryin: true },
    });
  });
});

describe('PUT do caso — datas, link e parcial', () => {
  it("'2026-02-30' → 400; entrega antes de 2020 ou depois de hoje + 3 anos → 400; recebido no futuro → 400", async () => {
    const m = montar();
    const gravar = async (body: unknown) => m.service.gravarCaso(ADM, A, 'orc-a', await caso(body));
    expect(await erro400(gravar({ due_date: '2026-02-30' }))).toEqual([T.dataInvalida]);
    expect(await erro400(gravar({ received_at: '2027-02-29' }))).toEqual([T.dataInvalida]);
    expect(await erro400(gravar({ due_date: '2019-12-31' }))).toEqual([T.entregaFora]);
    expect(await erro400(gravar({ due_date: '2099-01-01' }))).toEqual([T.entregaFora]);
    expect(await erro400(gravar({ received_at: '2099-01-01' }))).toEqual([T.recebidoFuturo]);
    // Ano digitado com 2 dígitos vira 00AA no campo de data: barrado pelo piso de 2020.
    expect(await erro400(gravar({ received_at: '0026-11-01' }))).toEqual([T.recebidoAntigo]);
    expect(await erro400(gravar({ received_at: '2019-12-31' }))).toEqual([T.recebidoAntigo]);
    expect(m.prisma.quoteLabCase.upsert).not.toHaveBeenCalled();
  });

  it('datas gravadas em T00:00:00.000Z e devolvidas como AAAA-MM-DD; link aparado', async () => {
    const m = montar();
    const r = await m.service.gravarCaso(
      ADM,
      A,
      'orc-a',
      await caso({ due_date: '2026-12-01', received_at: '2026-10-01', external_files_url: ' https://arquivos.example.com/caso/9 ', shade: ' B1 ' }),
    );
    const gravado = m.prisma.quoteLabCase.upsert.mock.calls[0][0].create;
    expect(gravado.due_date.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(gravado.received_at.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(r).toMatchObject({ gravado: true, herdado_de: null, due_date: '2026-12-01', received_at: '2026-10-01', shade: 'B1', external_files_url: 'https://arquivos.example.com/caso/9' });
  });

  it('PUT parcial do caso: o que não veio fica, null e texto vazio limpam', async () => {
    const m = montar();
    const r = await m.service.gravarCaso(ADM, A, 'orc-gravado', await caso({ shade: 'A3', instructions: null, external_files_url: '' }));
    expect(r).toEqual({
      quote_id: 'orc-gravado',
      gravado: true,
      herdado_de: null,
      updated_at: '2026-10-20T12:00:00.000Z',
      patient_ref: 'Iniciais do caso',
      requested_by_name: 'Dra. Ana',
      shade: 'A3',
      material: 'Dissilicato',
      due_date: '2026-11-20',
      instructions: null,
      external_files_url: null,
      received_at: '2026-10-18',
    });
  });
});
