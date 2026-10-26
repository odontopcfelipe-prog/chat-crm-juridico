/**
 * Chat do operador: texto recusado pela Evolution responde com o MOTIVO no aviso
 * (antes era só "Falha ao enviar mensagem via WhatsApp" e número errado no cadastro
 * parecia chip caído). A mensagem continua gravada com status 'erro', como antes.
 *
 * Repositório público: ids e números fictícios.
 */
import { BadRequestException, Logger } from '@nestjs/common';
import { MessagesService } from './messages.service';

const TEL = '558290000001';

function montar(sendText: jest.Mock) {
  const criadas: any[] = [];
  const prisma: any = {
    conversation: {
      findUnique: jest.fn(async () => ({
        id: 'conv-1', lead_id: 'lead-1', instance_name: 'chip-clinica', tenant_id: 'clinica-exemplo', inbox_id: null,
        assigned_user_id: null, lead: { phone: TEL, is_client: true },
      })),
      update: jest.fn(async () => ({})),
    },
    instance: { findFirst: jest.fn(async () => ({ name: 'chip-clinica' })) },
    message: {
      create: jest.fn(async ({ data }: any) => {
        criadas.push(data);
        return { id: 'msg-1', ...data };
      }),
    },
  };
  const gateway: any = { emitNewMessage: jest.fn(), emitConversationsUpdate: jest.fn() };
  const messages = new MessagesService(prisma, { sendText } as any, gateway, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { messages, criadas, gateway };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('MessagesService.sendMessage: motivo da recusa no aviso', () => {
  it('número sem WhatsApp (exists:false) → "Mensagem não enviada: este número não tem WhatsApp"', async () => {
    const sendText = jest.fn(async () => ({
      statusCode: 400,
      error: '{"status":400,"error":"Bad Request","response":{"message":[{"jid":"x@s.whatsapp.net","exists":false,"number":"x"}]}}',
    }));
    const { messages, criadas, gateway } = montar(sendText);

    await expect(messages.sendMessage('conv-1', 'oi')).rejects.toThrow(
      new BadRequestException('Mensagem não enviada: este número não tem WhatsApp'),
    );
    expect(sendText).toHaveBeenCalledWith(TEL, 'oi', 'chip-clinica', undefined);
    expect(criadas).toEqual([expect.objectContaining({ status: 'erro', text: 'oi', direction: 'out' })]);
    expect(gateway.emitNewMessage).toHaveBeenCalled();
  });

  it('exceção no envio (sem resposta) → motivo "sem resposta do servidor do WhatsApp"', async () => {
    const { messages, criadas } = montar(jest.fn(async () => { throw new Error('socket hang up'); }));

    await expect(messages.sendMessage('conv-1', 'oi')).rejects.toThrow(
      new BadRequestException('Mensagem não enviada: sem resposta do servidor do WhatsApp'),
    );
    expect(criadas).toEqual([expect.objectContaining({ status: 'erro' })]);
  });

  it('envio aceito → nada muda (grava "enviado", sem exceção)', async () => {
    const { messages, criadas } = montar(jest.fn(async () => ({ key: { id: 'ext-1' } })));

    const msg = await messages.sendMessage('conv-1', 'oi');
    expect(msg).toMatchObject({ status: 'enviado', external_message_id: 'ext-1' });
    expect(criadas).toHaveLength(1);
  });
});
