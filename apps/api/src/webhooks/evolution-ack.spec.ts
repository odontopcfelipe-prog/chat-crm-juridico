import { ackSobe, parseEvolutionAck } from './evolution-ack';

describe('tique de entrega do WhatsApp (messages.update)', () => {
  it('Evolution v2 (produção 2.3.7): keyId + status em texto', () => {
    expect(parseEvolutionAck({ keyId: '3EB0ABC', remoteJid: '558299@s.whatsapp.net', status: 'DELIVERY_ACK' }))
      .toEqual({ id: '3EB0ABC', status: 'entregue' });
    expect(parseEvolutionAck({ keyId: '3EB0ABC', status: 'READ' })).toEqual({ id: '3EB0ABC', status: 'lido' });
    expect(parseEvolutionAck({ keyId: '3EB0ABC', status: 'PLAYED' })).toEqual({ id: '3EB0ABC', status: 'lido' });
    expect(parseEvolutionAck({ keyId: '3EB0ABC', status: 'SERVER_ACK' })).toEqual({ id: '3EB0ABC', status: 'enviado' });
  });

  it('Evolution v1: key.id + status numérico (continua funcionando)', () => {
    expect(parseEvolutionAck({ key: { id: 'ABC' }, update: { status: 3 } })).toEqual({ id: 'ABC', status: 'entregue' });
    expect(parseEvolutionAck({ key: { id: 'ABC' }, update: { status: 4 } })).toEqual({ id: 'ABC', status: 'lido' });
  });

  it('ignora erro/pendente/sem id', () => {
    expect(parseEvolutionAck({ keyId: 'X', status: 'ERROR' })).toBeNull();
    expect(parseEvolutionAck({ keyId: 'X', status: 'PENDING' })).toBeNull();
    expect(parseEvolutionAck({ status: 'READ' })).toBeNull();
    expect(parseEvolutionAck(null)).toBeNull();
  });

  it('tique nunca regride; "não enviada" sobe se o WhatsApp confirmar', () => {
    expect(ackSobe('enviado', 'entregue')).toBe(true);
    expect(ackSobe('entregue', 'lido')).toBe(true);
    expect(ackSobe('lido', 'entregue')).toBe(false);
    expect(ackSobe('entregue', 'enviado')).toBe(false);
    expect(ackSobe('erro', 'enviado')).toBe(true);
    expect(ackSobe(null, 'enviado')).toBe(true);
  });
});
