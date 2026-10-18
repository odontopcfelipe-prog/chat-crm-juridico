import axios from 'axios';
import { invalidAlertPhoneParts, parseAlertPhones } from '@crm/shared';
import { adminAlertPhones, evolutionEntregou, sendAdminAlert } from './admin-alert';
import {
  adminAgendamentoKey,
  inicioJanelaAviso,
  montarTextoNovoAgendamento,
  rotuloQuandoAgendamento,
  rotuloTipoAgendamento,
  togglesPorClinica,
} from './admin-agendamento-regras';

jest.mock('axios');
const mockedPost = (axios as unknown as { post: jest.Mock }).post;

describe('parseAlertPhones (shared)', () => {
  it('aceita vários números separados por vírgula, ; e quebra de linha', () => {
    expect(parseAlertPhones('5582999998888, 82988887777;\n(82) 3333-4444')).toEqual([
      '5582999998888',
      '5582988887777',
      '558233334444',
    ]);
  });
  it('dedup pelo assinante (com/sem 9, com/sem 55) e descarta lixo', () => {
    expect(parseAlertPhones('5582999998888, 82999998888, 558299998888, 123')).toEqual(['5582999998888']);
    expect(parseAlertPhones('')).toEqual([]);
    expect(parseAlertPhones(null)).toEqual([]);
  });
  it('número único (formato antigo) continua funcionando', () => {
    expect(parseAlertPhones('5582999998888')).toEqual(['5582999998888']);
  });
  it('invalidAlertPhoneParts aponta os trechos curtos', () => {
    expect(invalidAlertPhoneParts('5582999998888, 8299999, ,')).toEqual(['8299999']);
    expect(invalidAlertPhoneParts('5582999998888')).toEqual([]);
  });
  it('recusa dois números colados, local de 9 dígitos com 55 e 55 repetido', () => {
    // dois números no mesmo campo (a tela tira vírgula/espaço) → 24 dígitos
    expect(invalidAlertPhoneParts('558299999888882988887777')).toEqual(['558299999888882988887777']);
    // local de 9 dígitos + 55 da tela → toBrazilWhatsappNumber viraria 5555829999988
    expect(invalidAlertPhoneParts('55829999988')).toEqual(['55829999988']);
    // 55 digitado no campo que já tem o 55 fixo
    expect(invalidAlertPhoneParts('555582999998888')).toEqual(['555582999998888']);
    expect(parseAlertPhones('558299999888882988887777, 55829999988, 5582988887777')).toEqual(['5582988887777']);
  });
  it('aceita DDD 55 (RS) e fixo de 8 dígitos', () => {
    expect(invalidAlertPhoneParts('5555991234567, 555532221111, 8233334444')).toEqual([]);
    expect(parseAlertPhones('55991234567')).toEqual(['5555991234567']);
  });
});

describe('regras do aviso de novo agendamento', () => {
  const agora = new Date('2026-10-12T15:00:00Z');

  it('key do toggle por origem/clínica', () => {
    expect(adminAgendamentoKey('IA', 't1')).toBe('ADMIN_AGENDAMENTO_IA_ENABLED_t1');
    expect(adminAgendamentoKey('EQUIPE', 't1')).toBe('ADMIN_AGENDAMENTO_EQUIPE_ENABLED_t1');
  });

  it('janela = max(toggle ligado, agora-2h): nunca avisa backlog', () => {
    expect(inicioJanelaAviso(new Date('2026-10-01T00:00:00Z'), agora).toISOString()).toBe('2026-10-12T13:00:00.000Z');
    expect(inicioJanelaAviso(new Date('2026-10-12T14:30:00Z'), agora).toISOString()).toBe('2026-10-12T14:30:00.000Z');
    expect(inicioJanelaAviso(null, agora).toISOString()).toBe('2026-10-12T13:00:00.000Z');
  });

  it('agrupa os toggles ligados por clínica', () => {
    const m = togglesPorClinica([
      { key: 'ADMIN_AGENDAMENTO_IA_ENABLED_t1', value: 'true', updated_at: agora },
      { key: 'ADMIN_AGENDAMENTO_EQUIPE_ENABLED_t1', value: 'true', updated_at: agora },
      { key: 'ADMIN_AGENDAMENTO_EQUIPE_ENABLED_t2', value: 'false', updated_at: agora },
      { key: 'ADMIN_AGENDAMENTO_EQUIPE_ENABLED_t3', value: 'true', updated_at: agora },
    ]);
    expect([...m.keys()].sort()).toEqual(['t1', 't3']);
    expect(Object.keys(m.get('t1')!).sort()).toEqual(['EQUIPE', 'IA']);
    expect(Object.keys(m.get('t3')!)).toEqual(['EQUIPE']);
  });

  it('formata a data naive-UTC com getUTC* (hora de Maceió gravada como UTC)', () => {
    // 2026-10-13 é terça-feira
    expect(rotuloQuandoAgendamento(new Date('2026-10-13T14:30:00Z'))).toBe('terça-feira 13/10 às 14:30');
    expect(rotuloQuandoAgendamento(new Date('2026-10-13T00:00:00Z'), true)).toBe('terça-feira 13/10 (dia inteiro)');
  });

  it('tipo legível (com o tipo de atendimento cadastrado)', () => {
    expect(rotuloTipoAgendamento('CONSULTA')).toBe('Consulta');
    expect(rotuloTipoAgendamento('CONSULTA', 'Avaliação')).toBe('Consulta · Avaliação');
    expect(rotuloTipoAgendamento('ORTODONTIA', 'ortodontia')).toBe('Ortodontia');
  });

  it('texto: marcado pela IA (nome da assistente) e pela equipe', () => {
    const base = {
      pacienteNome: 'Maria Souza',
      telefone: '5582999998888',
      startNaive: new Date('2026-10-13T14:30:00Z'),
      tipo: 'CONSULTA',
      tipoNome: 'Avaliação',
      dentista: 'Dra. Ana',
    };
    expect(montarTextoNovoAgendamento({ ...base, origem: 'IA', assistente: 'Sophia' })).toBe(
      '📅 *Novo agendamento*\n' +
        'Paciente: Maria Souza (5582999998888)\n' +
        'Quando: terça-feira 13/10 às 14:30\n' +
        'Tipo: Consulta · Avaliação\n' +
        'Com: Dra. Ana\n' +
        'Marcado por: IA (Sophia)',
    );
    const equipe = montarTextoNovoAgendamento({ ...base, dentista: null, origem: 'EQUIPE', criadoPor: 'Recepção Joana', recorrencia: 'WEEKLY' });
    expect(equipe).toContain('Com: sem dentista definido');
    expect(equipe).toContain('Marcado por: Recepção Joana');
    expect(equipe).toContain('Repete: semanal (aviso só da 1ª)');
  });
});

describe('sendAdminAlert (helper puro)', () => {
  const evo = { apiUrl: 'https://evo.local', apiKey: 'k' };
  const mkPrisma = (settings: Record<string, string>, chips: { name: string; purpose: string | null }[]) => {
    const logs: any[] = [];
    return {
      logs,
      globalSetting: { findUnique: jest.fn(async ({ where }: any) => (settings[where.key] != null ? { value: settings[where.key] } : null)) },
      instance: { findMany: jest.fn(async () => chips) },
      dispatchLog: { create: jest.fn(async ({ data }: any) => { logs.push(data); return data; }) },
    };
  };

  beforeEach(() => mockedPost.mockReset());

  it('lê VENDA_FEITA_PHONE (vários) e cai pro DAILY_SUMMARY_PHONE', async () => {
    const p1 = mkPrisma({ VENDA_FEITA_PHONE_t1: '82999998888, 82988887777', DAILY_SUMMARY_PHONE_t1: '82911112222' }, []);
    expect(await adminAlertPhones(p1 as any, 't1')).toEqual(['5582999998888', '5582988887777']);
    const p2 = mkPrisma({ VENDA_FEITA_PHONE_t1: '', DAILY_SUMMARY_PHONE_t1: '82911112222' }, []);
    expect(await adminAlertPhones(p2 as any, 't1')).toEqual(['5582911112222']);
  });

  it('sem número: não envia nada', async () => {
    const p = mkPrisma({}, [{ name: 'fin', purpose: 'FINANCEIRO' }]);
    const r = await sendAdminAlert(p as any, evo, 't1', { text: 'oi', type: 'x' });
    expect(r).toEqual({ sent: 0, failed: 0, phones: [], noPhone: true });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('ordem FINANCEIRO → CLINICA → resto, para no 1º que entregou, 1 DispatchLog por número', async () => {
    const p = mkPrisma({ VENDA_FEITA_PHONE_t1: '82999998888, 82988887777' }, [
      { name: 'b-com', purpose: 'COMERCIAL' },
      { name: 'a-cli', purpose: 'CLINICA' },
      { name: 'z-fin', purpose: 'FINANCEIRO' },
    ]);
    mockedPost.mockImplementation(async (url: string) => {
      if (url.includes('z-fin')) return { data: { status: 428, error: 'Connection Closed' } }; // chip caído
      return { data: { key: { id: 'MSG1' } } };
    });
    const r = await sendAdminAlert(p as any, evo, 't1', { text: 'aviso', type: 'admin_agendamento', refEventId: 'ev1' });
    expect(r.sent).toBe(2);
    expect(r.failed).toBe(0);
    const chamadas = mockedPost.mock.calls.map((c) => c[0]);
    expect(chamadas[0]).toContain('/message/sendText/z-fin');
    expect(chamadas[1]).toContain('/message/sendText/a-cli');
    expect(chamadas.some((u: string) => u.includes('b-com'))).toBe(false);
    expect(p.logs).toHaveLength(2);
    expect(p.logs.every((l) => l.type === 'admin_agendamento' && l.status === 'SENT' && l.ref_event_id === 'ev1')).toBe(true);
  });

  it('com arquivo: manda sendMedia com legenda; se nenhum chip entregar o arquivo, cai pro texto', async () => {
    const p = mkPrisma({ VENDA_FEITA_PHONE_t1: '82999998888' }, [{ name: 'fin', purpose: 'FINANCEIRO' }]);
    mockedPost.mockImplementation(async (url: string) => {
      if (url.includes('sendMedia')) throw Object.assign(new Error('413'), { response: { status: 413 } });
      return { data: { key: { id: 'TXT' } } };
    });
    const r = await sendAdminAlert(p as any, evo, 't1', {
      text: 'currículo',
      type: 'nao_paciente_handoff',
      media: { data: 'QUJD', mediatype: 'document', mimetype: 'application/pdf', fileName: 'cv.pdf' },
    });
    expect(r.sent).toBe(1);
    expect(mockedPost.mock.calls[0][0]).toContain('/message/sendMedia/fin');
    expect(mockedPost.mock.calls[0][1]).toMatchObject({ number: '5582999998888', mediatype: 'document', caption: 'currículo', fileName: 'cv.pdf' });
    expect(mockedPost.mock.calls[1][0]).toContain('/message/sendText/fin');
    expect(mockedPost.mock.calls[1][1].text).toContain('o arquivo não pôde ser anexado');
  });

  it('nenhum chip entregou: failed + DispatchLog FAILED; nunca lança', async () => {
    const p = mkPrisma({ DAILY_SUMMARY_PHONE_t1: '82999998888' }, [{ name: 'fin', purpose: 'FINANCEIRO' }]);
    mockedPost.mockResolvedValue({ data: { exists: false } });
    const r = await sendAdminAlert(p as any, { getEvolutionConfig: async () => evo }, 't1', { text: 'x' });
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(p.logs[0]).toMatchObject({ type: 'admin_alert', status: 'FAILED' });
  });

  it('clínica sem chip: NÃO usa o chip legado global (é de outra clínica) — FAILED "clínica sem chip"', async () => {
    const antes = process.env.EVOLUTION_INSTANCE_NAME;
    process.env.EVOLUTION_INSTANCE_NAME = 'chip-legado-de-outra-clinica';
    try {
      const p = mkPrisma({ VENDA_FEITA_PHONE_t2: '82999998888' }, []);
      mockedPost.mockResolvedValue({ data: { key: { id: 'X' } } });
      const r = await sendAdminAlert(p as any, evo, 't2', { text: 'paciente X agendado', type: 'admin_agendamento' });
      expect(r).toMatchObject({ sent: 0, failed: 1, noPhone: false });
      expect(mockedPost).not.toHaveBeenCalled();
      expect(p.logs[0]).toMatchObject({ status: 'FAILED', error: 'clínica sem chip' });
    } finally {
      if (antes === undefined) delete process.env.EVOLUTION_INSTANCE_NAME;
      else process.env.EVOLUTION_INSTANCE_NAME = antes;
    }
  });

  it('com `disparo`: Central + ADMs com o aviso marcado, menos quem desligou (cadastro da equipe)', async () => {
    const p: any = mkPrisma({ VENDA_FEITA_PHONE_t1: '82988887777, 82911112222' }, [{ name: 'fin', purpose: 'FINANCEIRO' }]);
    const users = [
      { id: 'u-ana', name: 'Ana', phone: '82999998888', roles: ['ADMIN'], disparos_off: [], disparos_on: ['admin_agendamento_ia'] },
      { id: 'u-bia', name: 'Bia', phone: '5582988887777', roles: ['ADMIN'], disparos_off: ['admin_agendamento_ia'], disparos_on: [] },
      { id: 'u-davi', name: 'Davi', phone: '82966665555', roles: ['ADMIN'], disparos_off: [], disparos_on: [] },
    ];
    p.user = { findMany: jest.fn(async () => users) };
    mockedPost.mockResolvedValue({ data: { key: { id: 'M' } } });

    const r = await sendAdminAlert(p, evo, 't1', { text: 'novo', type: 'admin_agendamento', disparo: 'admin_agendamento_ia' });
    // Bia desligou: o número dela sai mesmo estando na Central; Ana marcou e entra pelo
    // cadastro; Davi é ADM mas não marcou (opt-in) → não recebe.
    expect(r.phones).toEqual(['5582911112222', '5582999998888']);
    expect(p.logs.map((l: any) => l.ref_user_id)).toEqual([null, 'u-ana']);
    expect(p.user.findMany.mock.calls[0][0].where).toMatchObject({ tenant_id: 't1' });

    // Sem `disparo` (chamada antiga): só os números da Central, nem lê a equipe.
    mockedPost.mockClear();
    const p2: any = mkPrisma({ VENDA_FEITA_PHONE_t1: '82988887777' }, [{ name: 'fin', purpose: 'FINANCEIRO' }]);
    p2.user = { findMany: jest.fn(async () => users) };
    expect((await sendAdminAlert(p2, evo, 't1', { text: 'x' })).phones).toEqual(['5582988887777']);
    expect(p2.user.findMany).not.toHaveBeenCalled();
  });

  it('com `disparo` e equipe ilegível (erro): valem só os números da Central', async () => {
    const p: any = mkPrisma({ VENDA_FEITA_PHONE_t1: '82988887777' }, [{ name: 'fin', purpose: 'FINANCEIRO' }]);
    p.user = { findMany: jest.fn(async () => { throw new Error('column disparos_off does not exist'); }) };
    mockedPost.mockResolvedValue({ data: { key: { id: 'M' } } });
    const r = await sendAdminAlert(p, evo, 't1', { text: 'x', disparo: 'venda_feita' });
    expect(r).toMatchObject({ sent: 1, phones: ['5582988887777'] });
  });

  it('evolutionEntregou: só com id e sem exists:false', () => {
    expect(evolutionEntregou({ key: { id: 'a' } })).toBe(true);
    expect(evolutionEntregou({ exists: false, key: { id: 'a' } })).toBe(false);
    expect(evolutionEntregou({ statusCode: 400, error: 'x' })).toBe(false);
    expect(evolutionEntregou({})).toBe(false);
  });
});
