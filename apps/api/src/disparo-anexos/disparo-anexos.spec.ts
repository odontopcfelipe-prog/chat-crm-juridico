import { DISPARO_ANEXO_CACHE_MAX_BYTES, DISPARO_ANEXO_IDS, disparoAnexoTipo, isDisparoComAnexo, lembreteIdFor, ordenarAnexos } from '@crm/shared';
import { anexosDoDisparo, enviarAnexosDoDisparo, limparCacheAnexos } from './disparo-anexos-envio';

describe('anexos dos disparos — regras', () => {
  it('cards ligados ao envio aceitam; financeiros/internos não', () => {
    for (const id of ['lembrete_1dia', 'confirmacao', 'confirmacao_48h', 'comercial_lembrete_1dia', 'reagendamento',
      'lembrete_orto_1h', 'aniversario_presente', 'recall_preventivo', 'retorno_limpeza_antes']) {
      expect(isDisparoComAnexo(id)).toBe(true);
    }
    for (const id of ['boleto_no_dia', 'negociacao_aprovada', 'resumo_dentista', 'venda_feita', 'nps', '', null]) {
      expect(isDisparoComAnexo(id as any)).toBe(false);
    }
    expect(new Set(DISPARO_ANEXO_IDS).size).toBe(DISPARO_ANEXO_IDS.length); // sem repetido
  });

  it('card do lembrete pela antecedência (mesmas faixas do EventReminder)', () => {
    expect(lembreteIdFor(2880, false)).toBe('confirmacao_48h');
    expect(lembreteIdFor(1440, false)).toBe('lembrete_1dia');
    expect(lembreteIdFor(120, false)).toBe('lembrete_1h');
    expect(lembreteIdFor(15, false)).toBe('lembrete_15min');
    expect(lembreteIdFor(1440, true)).toBe('comercial_lembrete_1dia');
    expect(lembreteIdFor(15, true)).toBe('comercial_lembrete_15min');
  });

  it('fotos primeiro, áudio por último', () => {
    const r = ordenarAnexos([
      { kind: 'audio', position: 0, id: 'a' },
      { kind: 'image', position: 2, id: 'f2' },
      { kind: 'image', position: 1, id: 'f1' },
    ]);
    expect(r.map((x) => x.id)).toEqual(['f1', 'f2', 'a']);
    // vídeo fica junto com as fotos, na ordem anexada
    expect(ordenarAnexos([
      { kind: 'audio', position: 0, id: 'a' },
      { kind: 'video', position: 2, id: 'v' },
      { kind: 'image', position: 1, id: 'f' },
    ]).map((x) => x.id)).toEqual(['f', 'v', 'a']);
  });

  it('aceita vídeo MP4; .MOV não', () => {
    expect(disparoAnexoTipo('video/mp4')).toBe('video');
    expect(disparoAnexoTipo('video/quicktime')).toBeNull();
  });
});

describe('anexos dos disparos — envio (API)', () => {
  beforeAll(() => jest.spyOn(global, 'setTimeout').mockImplementation(((fn: any) => { fn(); return 0 as any; }) as any));
  afterAll(() => (global.setTimeout as any).mockRestore?.());

  const prismaCom = (rows: any[]) => ({ disparoAnexo: { findMany: jest.fn(async () => rows) } }) as any;
  const row = (id: string, kind: string, position: number) => ({
    id, kind, position, mime_type: kind === 'audio' ? 'audio/mpeg' : 'image/png', original_name: `${id}.bin`, data: Buffer.from(id),
  });

  it('sem anexo: não chama a Evolution', async () => {
    const whatsapp: any = { sendMedia: jest.fn() };
    const r = await enviarAnexosDoDisparo(prismaCom([]), whatsapp, { tenantId: 'T0', disparoId: 'lembrete_1dia', phone: '82', instance: 'clin' });
    expect(r).toEqual({ enviados: 0, falhas: [] });
    expect(whatsapp.sendMedia).not.toHaveBeenCalled();
  });

  it('manda foto e depois áudio, pelo chip e número do texto, com a config da clínica', async () => {
    const whatsapp: any = { sendMedia: jest.fn(async () => ({ key: { id: 'X' } })) };
    const r = await enviarAnexosDoDisparo(prismaCom([row('a', 'audio', 0), row('f', 'image', 1)]), whatsapp, {
      tenantId: 'T1', disparoId: 'lembrete_1dia', phone: '82999990001', instance: 'clin',
    });
    expect(r.enviados).toBe(2);
    const [c1, c2] = (whatsapp.sendMedia as jest.Mock).mock.calls;
    expect(c1.slice(0, 2)).toEqual(['82999990001', 'image']);
    expect(c1[2]).toBe(Buffer.from('f').toString('base64'));
    expect(c1[4]).toBe('clin');
    expect(c1[8]).toBe('T1'); // tenantId (config da Evolution da clínica)
    expect(c2.slice(0, 2)).toEqual(['82999990001', 'audio']);
  });

  it('vídeo sai por sendMedia tipo vídeo, com nome/MIME e prazo maior, antes do áudio', async () => {
    const whatsapp: any = { sendMedia: jest.fn().mockResolvedValueOnce({ key: { id: 'V' } }).mockResolvedValueOnce({ statusCode: 500, error: 'x' }) };
    const video = { ...row('v', 'video', 1), mime_type: 'video/mp4', original_name: 'v.mp4' };
    const r = await enviarAnexosDoDisparo(prismaCom([row('a', 'audio', 0), video]), whatsapp, {
      tenantId: 'T5', disparoId: 'lembrete_1dia', phone: '82999990001', instance: 'clin',
    });
    const [c1, c2] = (whatsapp.sendMedia as jest.Mock).mock.calls;
    expect(c1.slice(0, 2)).toEqual(['82999990001', 'video']);
    expect(c1.slice(4, 9)).toEqual(['clin', 'v.mp4', 'video/mp4', 120000, 'T5']);
    expect(c2[1]).toBe('audio');
    expect(r).toEqual({ enviados: 1, falhas: ['áudio: x'] });
  });

  it('nunca lança: Evolution recusando ou estourando vira falha no retorno', async () => {
    const whatsapp: any = {
      sendMedia: jest.fn()
        .mockResolvedValueOnce({ statusCode: 500, error: 'ffmpeg' })
        .mockRejectedValueOnce(new Error('rede')),
    };
    const r = await enviarAnexosDoDisparo(prismaCom([row('f', 'image', 0), row('a', 'audio', 1)]), whatsapp, {
      tenantId: 'T2', disparoId: 'recall_preventivo', phone: '82', instance: 'clin',
    });
    expect(r.enviados).toBe(0);
    expect(r.falhas).toHaveLength(2);
    // banco quebrado também não lança
    const r2 = await enviarAnexosDoDisparo({} as any, whatsapp, { tenantId: 'T3', disparoId: 'x', phone: '82', instance: 'clin' });
    expect(r2).toEqual({ enviados: 0, falhas: [] });
  });

  it('cache por clínica+card; a tela limpa ao mudar', async () => {
    const p = prismaCom([row('f', 'image', 0)]);
    await anexosDoDisparo(p, 'T4', 'lembrete_1h');
    await anexosDoDisparo(p, 'T4', 'lembrete_1h');
    expect(p.disparoAnexo.findMany).toHaveBeenCalledTimes(1);
    limparCacheAnexos('T4', 'lembrete_1h');
    await anexosDoDisparo(p, 'T4', 'lembrete_1h');
    expect(p.disparoAnexo.findMany).toHaveBeenCalledTimes(2);
    // escopado por clínica
    await anexosDoDisparo(p, 'OUTRA', 'lembrete_1h');
    expect(p.disparoAnexo.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { tenant_id: 'OUTRA', disparo_id: 'lembrete_1h' } }));
  });

  it('anexo grande (vídeo) não fica no cache — volta do banco a cada envio', async () => {
    const noTeto = prismaCom([{ ...row('v', 'video', 0), data: Buffer.alloc(DISPARO_ANEXO_CACHE_MAX_BYTES) }]);
    await anexosDoDisparo(noTeto, 'T6', 'lembrete_1h');
    await anexosDoDisparo(noTeto, 'T6', 'lembrete_1h');
    expect(noTeto.disparoAnexo.findMany).toHaveBeenCalledTimes(1); // no limite: ainda cabe
    const acima = prismaCom([{ ...row('v', 'video', 0), data: Buffer.alloc(DISPARO_ANEXO_CACHE_MAX_BYTES + 3) }]);
    await anexosDoDisparo(acima, 'T7', 'lembrete_1h');
    await anexosDoDisparo(acima, 'T7', 'lembrete_1h');
    expect(acima.disparoAnexo.findMany).toHaveBeenCalledTimes(2);
  });
});
