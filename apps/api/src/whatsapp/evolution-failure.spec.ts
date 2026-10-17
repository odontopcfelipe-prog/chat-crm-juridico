import { describeEvolutionFailure } from './whatsapp.service';

describe('describeEvolutionFailure', () => {
  it('número sem WhatsApp (exists:false)', () => {
    const res = { statusCode: 400, error: '{"status":400,"error":"Bad Request","response":{"message":[{"jid":"5582@s.whatsapp.net","exists":false,"number":"5582"}]}}' };
    expect(describeEvolutionFailure(res)).toBe('este número não tem WhatsApp');
  });

  it('chip inexistente (404) e timeout (408)', () => {
    expect(describeEvolutionFailure({ statusCode: 404, error: 'not found' })).toMatch(/chip do WhatsApp/);
    expect(describeEvolutionFailure({ statusCode: 408, error: 'Request timeout after 15000ms' })).toMatch(/demorou/);
  });

  it('extrai a mensagem da Evolution v2', () => {
    const res = { statusCode: 400, error: '{"status":400,"error":"Bad Request","response":{"message":["Owned media must be a url or base64"]}}' };
    expect(describeEvolutionFailure(res)).toBe('erro 400: Owned media must be a url or base64');
  });

  it('texto que não é JSON e resposta vazia', () => {
    expect(describeEvolutionFailure({ statusCode: 500, error: 'Internal Server Error' })).toBe('erro 500: Internal Server Error');
    expect(describeEvolutionFailure(null)).toBe('sem resposta do servidor do WhatsApp');
  });
});
