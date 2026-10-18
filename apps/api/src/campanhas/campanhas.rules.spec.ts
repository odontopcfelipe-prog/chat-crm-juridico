import {
  CAMPANHA_MAX_LEGENDA,
  campanhaMidiaTipo,
  estimativaCampanha,
  normalizarFiltros,
  planejarEnvio,
  renderCampanhaTexto,
} from '@crm/shared';
import { aniversarianteDoMes, motivoFora, wherePublico } from './campanhas-publico';

describe('campanha manual — regras puras', () => {
  it('ordem das bolhas: legenda na 1ª foto, depois fotos, áudio por último', () => {
    const m = [
      { id: 'a1', tipo: 'audio' as const, posicao: 0 },
      { id: 'f1', tipo: 'image' as const, posicao: 1 },
      { id: 'f2', tipo: 'image' as const, posicao: 2 },
    ];
    expect(planejarEnvio('Oi!', m)).toEqual([
      { tipo: 'image', midiaId: 'f1', legenda: 'Oi!' },
      { tipo: 'image', midiaId: 'f2' },
      { tipo: 'audio', midiaId: 'a1' },
    ]);
    // texto longo não cabe como legenda → sai antes
    const longo = 'x'.repeat(CAMPANHA_MAX_LEGENDA + 1);
    expect(planejarEnvio(longo, m)[0]).toEqual({ tipo: 'texto', texto: longo });
    // só áudio → texto primeiro (dá o contexto), depois a voz
    expect(planejarEnvio('Escuta esse recado', [{ id: 'a1', tipo: 'audio' }])).toEqual([
      { tipo: 'texto', texto: 'Escuta esse recado' },
      { tipo: 'audio', midiaId: 'a1' },
    ]);
    // só texto / só mídia
    expect(planejarEnvio('Oi', [])).toEqual([{ tipo: 'texto', texto: 'Oi' }]);
    expect(planejarEnvio('  ', [{ id: 'f1', tipo: 'image' }])).toEqual([{ tipo: 'image', midiaId: 'f1' }]);
    expect(planejarEnvio('', [])).toEqual([]);
  });

  it('anexos aceitos: fotos e áudio (gravação do navegador inclusa); vídeo/documento não', () => {
    expect(campanhaMidiaTipo('image/jpeg')).toBe('image');
    expect(campanhaMidiaTipo('image/png')).toBe('image');
    expect(campanhaMidiaTipo('audio/ogg; codecs=opus')).toBe('audio');
    expect(campanhaMidiaTipo('audio/mpeg')).toBe('audio');
    expect(campanhaMidiaTipo('audio/x-m4a')).toBe('audio');
    expect(campanhaMidiaTipo('video/webm')).toBe('audio');
    expect(campanhaMidiaTipo('video/mp4')).toBeNull();
    expect(campanhaMidiaTipo('application/pdf')).toBeNull();
    expect(campanhaMidiaTipo('image/gif')).toBeNull();
  });

  it('filtros da tela são normalizados (lixo some, valores limitados)', () => {
    expect(normalizarFiltros({ tagIds: ['t1', '', 3], atividade: 'X', semVisitaMeses: '6', dentistaId: '', comTratamentoAtivo: 'sim' }))
      .toEqual({ tagIds: ['t1'], semVisitaMeses: 6 });
    expect(normalizarFiltros({ atividade: 'INACTIVE', semVisitaMeses: 999, aniversariantesDoMes: true }))
      .toEqual({ atividade: 'INACTIVE', semVisitaMeses: 120, aniversariantesDoMes: true });
    expect(normalizarFiltros(null)).toEqual({});
  });

  it('variáveis e estimativa', () => {
    expect(renderCampanhaTexto('Oi, {nome}! Aqui é da equipe {clinica}. {xyz}', { nome: 'Ana', clinica: 'Instituto' }))
      .toBe('Oi, Ana! Aqui é da equipe Instituto.');
    expect(estimativaCampanha(0)).toBe('—');
    expect(estimativaCampanha(10)).toBe('cerca de 1 hora');
    expect(estimativaCampanha(60)).toBe('cerca de 5 horas');
    expect(estimativaCampanha(300)).toBe('cerca de 3 dias úteis');
  });

  it('público: arquivado nunca entra, sempre na clínica; filtros viram WHERE', () => {
    const agora = new Date('2027-01-13T13:00:00Z');
    const w: any = wherePublico('T1', { tagIds: ['a', 'b'], atividade: 'INACTIVE', dentistaId: 'd1', comTratamentoAtivo: true }, agora);
    expect(w.AND).toEqual(expect.arrayContaining([
      { tenant_id: 'T1' },
      { status: { not: 'ARCHIVED' } },
      { tags: { some: { tag_id: { in: ['a', 'b'] } } } },
      { primary_dentist_id: 'd1' },
      { treatment_plans: { some: { status: 'ACTIVE' } } },
    ]));
    const inativo = w.AND.find((x: any) => x.OR && x.OR[0].last_visit_at?.lt);
    expect(inativo.OR[0].last_visit_at.lt.toISOString().slice(0, 10)).toBe('2026-01-13'); // 12 meses
    expect((wherePublico('T1', {}, agora) as any).AND).toHaveLength(2);
  });

  it('quem fica de fora e por quê', () => {
    const base = { id: 'p', name: 'Ana', birth_date: null, lead: null };
    expect(motivoFora({ ...base, phone: null })).toBe('sem_telefone');
    expect(motivoFora({ ...base, phone: '8299' })).toBe('sem_telefone');
    expect(motivoFora({ ...base, phone: '82999990000', lead: { contact_opt_out_at: new Date(), whatsapp_invalid_at: null, non_patient_category: null } })).toBe('nao_recebe');
    expect(motivoFora({ ...base, phone: '82999990000', lead: { contact_opt_out_at: null, whatsapp_invalid_at: null, non_patient_category: 'FORNECEDOR' } })).toBe('nao_recebe');
    expect(motivoFora({ ...base, phone: '82999990000', lead: { contact_opt_out_at: null, whatsapp_invalid_at: new Date(), non_patient_category: null } })).toBe('numero_invalido');
    expect(motivoFora({ ...base, phone: '(82) 99999-0000' })).toBeNull();
    // aniversário: mês de Maceió (01/02 00:30 UTC ainda é 31/01 em Maceió)
    expect(aniversarianteDoMes(new Date('1990-01-20T00:00:00Z'), new Date('2027-02-01T00:30:00Z'))).toBe(true);
    expect(aniversarianteDoMes(new Date('1990-02-20T00:00:00Z'), new Date('2027-02-01T00:30:00Z'))).toBe(false);
    expect(aniversarianteDoMes(null, new Date())).toBe(false);
  });
});
