jest.mock('axios');
import axios from 'axios';
import { enviarAnexosDoDisparoWorker } from './disparo-anexos';

const post = axios.post as jest.Mock;
const row = (id: string, kind: string, position: number) => ({
  id, kind, position, mime_type: kind === 'audio' ? 'audio/ogg' : 'image/jpeg', original_name: `${id}.bin`, data: Buffer.from(id),
});
const prismaCom = (rows: any[]) => ({ disparoAnexo: { findMany: jest.fn(async () => rows) } }) as any;
const EVO = { apiUrl: 'http://evo', apiKey: 'k' };

describe('anexos dos disparos — envio (worker)', () => {
  beforeAll(() => jest.spyOn(global, 'setTimeout').mockImplementation(((fn: any) => { fn(); return 0 as any; }) as any));
  afterAll(() => (global.setTimeout as any).mockRestore?.());
  beforeEach(() => post.mockReset());

  it('foto por sendMedia e áudio por sendWhatsAppAudio, no chip do texto, número com 55', async () => {
    post.mockResolvedValue({ data: { key: { id: 'X' } } });
    const r = await enviarAnexosDoDisparoWorker(prismaCom([row('a', 'audio', 0), row('f', 'image', 1)]), EVO, {
      tenantId: 'T1', disparoId: 'confirmacao', phone: '82999990001', instance: 'clin',
    });
    expect(r.enviados).toBe(2);
    expect(post.mock.calls[0][0]).toBe('http://evo/message/sendMedia/clin');
    expect(post.mock.calls[0][1]).toMatchObject({ number: '5582999990001', mediatype: 'image', media: Buffer.from('f').toString('base64'), mimetype: 'image/jpeg' });
    expect(post.mock.calls[0][2].headers.apikey).toBe('k');
    expect(post.mock.calls[1][0]).toBe('http://evo/message/sendWhatsAppAudio/clin');
    expect(post.mock.calls[1][1]).toMatchObject({ number: '5582999990001', audio: Buffer.from('a').toString('base64') });
  });

  it('vídeo MP4 vai por sendMedia com mediatype video e prazo maior; falha aparece como vídeo', async () => {
    post.mockResolvedValueOnce({ data: { key: { id: 'V' } } });
    const video = { ...row('v', 'video', 0), mime_type: 'video/mp4', original_name: 'v.mp4' };
    const r = await enviarAnexosDoDisparoWorker(prismaCom([video]), EVO, {
      tenantId: 'T5', disparoId: 'confirmacao', phone: '82999990001', instance: 'clin',
    });
    expect(r).toEqual({ enviados: 1, falhas: [] });
    expect(post.mock.calls[0][0]).toBe('http://evo/message/sendMedia/clin');
    expect(post.mock.calls[0][1]).toMatchObject({ number: '5582999990001', mediatype: 'video', mimetype: 'video/mp4', fileName: 'v.mp4' });
    expect(post.mock.calls[0][2].timeout).toBe(120000);
    post.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: 413 } }));
    const r2 = await enviarAnexosDoDisparoWorker(prismaCom([video]), EVO, {
      tenantId: 'T6', disparoId: 'confirmacao', phone: '82999990001', instance: 'clin',
    });
    expect(r2).toEqual({ enviados: 0, falhas: ['vídeo: 413'] });
  });

  it('nunca lança (erro HTTP, sem config, sem anexo)', async () => {
    post.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 500 } }));
    const r = await enviarAnexosDoDisparoWorker(prismaCom([row('f', 'image', 0)]), EVO, {
      tenantId: 'T2', disparoId: 'recall_preventivo', phone: '82999990001', instance: 'clin',
    });
    expect(r).toEqual({ enviados: 0, falhas: ['foto: 500'] });
    expect(await enviarAnexosDoDisparoWorker(prismaCom([row('f', 'image', 0)]), { apiUrl: null }, { tenantId: 'T3', disparoId: 'x', phone: '82', instance: 'c' }))
      .toEqual({ enviados: 0, falhas: [] });
    post.mockClear();
    expect(await enviarAnexosDoDisparoWorker(prismaCom([]), EVO, { tenantId: 'T4', disparoId: 'x', phone: '82', instance: 'c' }))
      .toEqual({ enviados: 0, falhas: [] });
    expect(post).not.toHaveBeenCalled();
  });
});
