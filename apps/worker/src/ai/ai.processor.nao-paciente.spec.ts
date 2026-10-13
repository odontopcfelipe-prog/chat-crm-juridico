import { Logger } from '@nestjs/common';
import { AiProcessor } from './ai.processor';

// Fiação do "nao_paciente" no parser da resposta da IA (os dois caminhos: JSON e
// JSON malformado) — a decisão em si é testada em non-patient-rules.spec.ts.
describe('AiProcessor.parseAiResponse — nao_paciente', () => {
  const proc: any = new AiProcessor({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  it('JSON do contrato: nao_paciente no topo + scheduling_action null', () => {
    const r = proc.parseAiResponse(
      JSON.stringify({
        reply: 'Obrigada! Vou repassar ao responsável.',
        updates: {},
        nao_paciente: { categoria: 'CURRICULO', resumo: 'quer vaga de ASB' },
        scheduling_action: null,
      }),
    );
    expect(r.reply).toBe('Obrigada! Vou repassar ao responsável.');
    expect(r.nao_paciente).toEqual({ categoria: 'CURRICULO', resumo: 'quer vaga de ASB' });
    expect(r.scheduling_action).toBeUndefined();
  });

  it('paciente: nao_paciente null não marca nada e o confirm_slot segue', () => {
    const r = proc.parseAiResponse(
      '{"reply":"Perfeito, deixei agendado","updates":{},"nao_paciente":null,"scheduling_action":{"action":"confirm_slot","date":"2026-10-14","time":"09:00"}}',
    );
    expect(r.nao_paciente).toBeNull();
    expect(r.scheduling_action).toEqual({ action: 'confirm_slot', date: '2026-10-14', time: '09:00' });
  });

  it('dentro de updates e em bloco ```json', () => {
    const r = proc.parseAiResponse(
      '```json\n{"reply":"Vou encaminhar","updates":{"nao_paciente":{"categoria":"vendedor","resumo":"vende sistema"}}}\n```',
    );
    expect(r.nao_paciente).toEqual({ categoria: 'FORNECEDOR', resumo: 'vende sistema' });
  });

  it('JSON truncado: reply por regex e nao_paciente recuperado', () => {
    const r = proc.parseAiResponse(
      '{"reply":"Vou repassar ao responsável","nao_paciente":{"categoria":"NEGOCIO","resumo":"reunião com o dono"},"scheduling_action":{"act',
    );
    expect(r.reply).toBe('Vou repassar ao responsável');
    expect(r.nao_paciente).toEqual({ categoria: 'NEGOCIO', resumo: 'reunião com o dono' });
  });

  it('texto puro: sem nao_paciente', () => {
    const r = proc.parseAiResponse('Oi! Tudo bem?');
    expect(r.nao_paciente).toBeUndefined();
  });
});
