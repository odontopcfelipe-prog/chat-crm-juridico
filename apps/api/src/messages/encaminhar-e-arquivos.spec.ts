/**
 * Nov/2026 — arquivos no chat:
 *   - STL e outros arquivos de escaneamento/radiografia são aceitos pela extensão (o
 *     navegador manda tipos variados: application/vnd.ms-pki.stl no Windows, vazio...);
 *   - encaminhar documento/imagem/vídeo/áudio manda o ARQUIVO (antes ia só o texto, o nome).
 *
 * Repositório público: ids fictícios.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ACCEPT_ARQUIVOS_DO_CHAT, arquivoDoChatPermitido, tipoDoArquivoDoChat } from '@crm/shared';
import { MessagesService } from './messages.service';

describe('arquivos aceitos no chat', () => {
  it('STL, PLY, OBJ, 3MF, DICOM, RAR e 7z pela extensão, com qualquer tipo que o navegador mande', () => {
    expect(arquivoDoChatPermitido('application/vnd.ms-pki.stl', '002_002-UpperJaw.stl')).toBe(true);
    expect(arquivoDoChatPermitido('', 'arcada.STL')).toBe(true);
    expect(arquivoDoChatPermitido('application/octet-stream', 'scan.ply')).toBe(true);
    expect(arquivoDoChatPermitido('application/octet-stream', 'modelo.obj')).toBe(true);
    expect(arquivoDoChatPermitido('', 'peca.3mf')).toBe(true);
    expect(arquivoDoChatPermitido('application/octet-stream', 'tomografia.dcm')).toBe(true);
    expect(arquivoDoChatPermitido('application/octet-stream', 'casos.rar')).toBe(true);
    expect(arquivoDoChatPermitido('application/octet-stream', 'casos.7z')).toBe(true);
  });

  it('o que já era aceito continua; executável e tipo desconhecido continuam fora', () => {
    expect(arquivoDoChatPermitido('application/pdf', 'orcamento.pdf')).toBe(true);
    expect(arquivoDoChatPermitido('image/jpeg', 'foto.jpg')).toBe(true);
    expect(arquivoDoChatPermitido('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx')).toBe(true);
    expect(arquivoDoChatPermitido('application/x-msdownload', 'programa.exe')).toBe(false);
    expect(arquivoDoChatPermitido('application/octet-stream', 'arquivo.bin')).toBe(false);
    expect(arquivoDoChatPermitido('', 'sem-extensao')).toBe(false);
  });

  it('tipo gravado e enviado: o da extensão de escaneamento; o resto como veio', () => {
    expect(tipoDoArquivoDoChat('application/vnd.ms-pki.stl', 'x.STL')).toBe('model/stl');
    expect(tipoDoArquivoDoChat('', 't.dcm')).toBe('application/dicom');
    expect(tipoDoArquivoDoChat('application/pdf', 'a.pdf')).toBe('application/pdf');
    expect(tipoDoArquivoDoChat('', 'sem-extensao')).toBe('application/octet-stream');
  });

  it('o seletor de arquivos do chat oferece as extensões novas', () => {
    for (const ext of ['.stl', '.ply', '.obj', '.3mf', '.dcm', '.rar', '.7z', '.pdf', 'image/*']) {
      expect(ACCEPT_ARQUIVOS_DO_CHAT.split(',')).toContain(ext);
    }
  });
});

describe('MessagesService.forwardMessage', () => {
  const CONTA = 'conta-exemplo';
  const ORIGEM = 'conversa-origem';
  const DESTINO = 'conversa-destino';

  function montar(origem: any, arquivo: Buffer | null = Buffer.from('solid stl')) {
    const prisma: any = { message: { findUnique: jest.fn(async () => origem) } };
    const fileStorage: any = { tryRead: jest.fn(async () => arquivo) };
    const s3: any = { getFileBuffer: jest.fn(async () => null) };
    const svc = new MessagesService(prisma, {} as any, {} as any, s3, fileStorage, {} as any, {} as any, {} as any);
    const conta = jest.spyOn(svc as any, 'assertConvTenant').mockResolvedValue(undefined);
    const sendFile = jest.spyOn(svc, 'sendFile').mockResolvedValue({ id: 'nova' } as any);
    const sendAudio = jest.spyOn(svc, 'sendAudio').mockResolvedValue({ id: 'nova' } as any);
    const sendMessage = jest.spyOn(svc, 'sendMessage').mockResolvedValue({ id: 'nova' } as any);
    return { svc, conta, sendFile, sendAudio, sendMessage, fileStorage };
  }

  const stl = {
    id: 'm1',
    conversation_id: ORIGEM,
    type: 'document',
    text: '002_002-UpperJaw.stl',
    media: { file_path: '2026/11/m1.bin', s3_key: null, mime_type: 'model/stl', original_name: '002_002-UpperJaw.stl' },
  };

  it('documento vai como ARQUIVO, com o nome original e sem repetir o nome como legenda', async () => {
    const { svc, conta, sendFile, sendMessage } = montar(stl);
    await svc.forwardMessage('m1', DESTINO, 'u1', CONTA);
    expect(conta).toHaveBeenCalledWith(ORIGEM, CONTA);
    expect(conta).toHaveBeenCalledWith(DESTINO, CONTA);
    expect(sendMessage).not.toHaveBeenCalled();
    const [destino, arquivo, legenda, usuario, conta2] = sendFile.mock.calls[0];
    expect(destino).toBe(DESTINO);
    expect(arquivo).toMatchObject({ originalname: '002_002-UpperJaw.stl', mimetype: 'model/stl', size: 9 });
    expect(arquivo.buffer.toString()).toBe('solid stl');
    expect(legenda).toBeUndefined();
    expect([usuario, conta2]).toEqual(['u1', CONTA]);
  });

  it('imagem com legenda de verdade leva a legenda junto', async () => {
    const { svc, sendFile } = montar({
      ...stl,
      type: 'image',
      text: 'Foto do sorriso',
      media: { ...stl.media, mime_type: 'image/jpeg', original_name: null },
    });
    await svc.forwardMessage('m1', DESTINO, 'u1', CONTA);
    expect(sendFile.mock.calls[0][2]).toBe('Foto do sorriso');
    expect(sendFile.mock.calls[0][1].originalname).toBe('arquivo.jpg');
  });

  it('áudio vai como áudio', async () => {
    const { svc, sendAudio, sendFile } = montar({ ...stl, type: 'audio', text: null, media: { ...stl.media, mime_type: 'audio/ogg' } });
    await svc.forwardMessage('m1', DESTINO, 'u1', CONTA);
    expect(sendAudio).toHaveBeenCalledTimes(1);
    expect(sendFile).not.toHaveBeenCalled();
  });

  it('texto vai como antes: "Mensagem encaminhada"', async () => {
    const { svc, sendMessage, sendFile } = montar({ id: 'm2', conversation_id: ORIGEM, type: 'text', text: 'Bom dia!', media: null });
    await svc.forwardMessage('m2', DESTINO, 'u1', CONTA);
    expect(sendFile).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(DESTINO, '↪️ *Mensagem encaminhada:*\nBom dia!', undefined, 'u1', false, CONTA);
  });

  it('arquivo que não está mais no armazenamento: avisa em vez de mandar só o nome', async () => {
    const { svc, sendFile, sendMessage } = montar(stl, null);
    await expect(svc.forwardMessage('m1', DESTINO, 'u1', CONTA)).rejects.toBeInstanceOf(BadRequestException);
    expect(sendFile).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('arquivo acima de 50 MB (o teto do envio) não é carregado nem encaminhado', async () => {
    const { svc, fileStorage, sendFile } = montar({ ...stl, media: { ...stl.media, size: 60 * 1024 * 1024 } });
    await expect(svc.forwardMessage('m1', DESTINO, 'u1', CONTA)).rejects.toThrow('limite de 50 MB');
    expect(fileStorage.tryRead).not.toHaveBeenCalled();
    expect(sendFile).not.toHaveBeenCalled();
  });

  it('mídia antiga só no armazenamento S3 também encaminha', async () => {
    const { svc, sendFile, fileStorage } = montar({ ...stl, media: { ...stl.media, file_path: null, s3_key: 'antigo/m1' } }, null);
    (svc as any).s3.getFileBuffer = jest.fn(async () => Buffer.from('do s3'));
    await svc.forwardMessage('m1', DESTINO, 'u1', CONTA);
    expect(fileStorage.tryRead).not.toHaveBeenCalled();
    expect(sendFile.mock.calls[0][1].buffer.toString()).toBe('do s3');
  });

  it('mensagem apagada ou inexistente não encaminha', async () => {
    await expect(montar({ ...stl, type: 'deleted' }).svc.forwardMessage('m1', DESTINO, 'u1', CONTA)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(montar(null).svc.forwardMessage('m1', DESTINO, 'u1', CONTA)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('conversa de outra conta (origem ou destino) barra antes de ler o arquivo', async () => {
    const { svc, conta, fileStorage, sendFile } = montar(stl);
    conta.mockImplementation(async (id: string) => {
      if (id === DESTINO) throw new Error('Acesso negado a este recurso');
    });
    await expect(svc.forwardMessage('m1', DESTINO, 'u1', CONTA)).rejects.toThrow('Acesso negado');
    expect(fileStorage.tryRead).not.toHaveBeenCalled();
    expect(sendFile).not.toHaveBeenCalled();
  });
});
