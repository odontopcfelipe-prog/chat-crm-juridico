import {
  DEFAULT_REATIVACAO_MODELOS,
  REATIVACAO_COLUNAS,
  REATIVACAO_GANCHOS,
  REATIVACAO_OPT_OUT_RE,
  REATIVACAO_TEXTO_MAX,
  precosLiberados,
  renderReativacaoModelo,
  valoresPorProcedimento,
} from '@crm/shared';
import {
  amanhaAsNove,
  avaliarCandidato,
  calcularAgendamentos,
  chaveDiaMaceio,
  chaveDoNumero,
  cicloBloqueiaReciclo,
  classificarEnvio,
  consultaContaComoAgendou,
  cotaNovosCiclos,
  deduplicarPorNumero,
  dentistaDoModelo,
  dentroDaJanela,
  disjuntorAbre,
  dividirBaloes,
  ehNaoPaciente,
  ehMensagemReal,
  emCarenciaDeNutricao,
  escolherHorarios,
  extrairHorarios,
  extrairPercentuais,
  extrairValoresDinheiro,
  inicioDiaNaive,
  interesseDoFunil,
  interpretarWhatsappNumbers,
  intervaloChipMs,
  leadFalouPorUltimo,
  mensagensReais,
  optOutDefinitivo,
  paresDiaHora,
  pedidoDeParar,
  proximoInicioJanela,
  reancorarToques,
  renderizarModeloFallback,
  rotuloHorario,
  sanitizarTextoIA,
  selecionarLote,
  semFraseDeValorVazio,
  semPrecoNaoLiberado,
  textoPrecisaReescrever,
  validarTextoReativacao,
  variantesEnvio,
  type DadosCandidato,
  MOTIVO_COLUNA_DESLIGADA,
  MOTIVO_NAO_PACIENTE,
  MOTIVO_PODE_TER_SAIDO,
  TEXTO_MAX_CHARS,
} from './reativacao-regras';

/** Instante REAL a partir da hora de Maceió (UTC-3). */
const maceio = (iso: string) => new Date(`${iso}-03:00`);
const DIA = 86_400_000;

describe('régua de reativação — relógio e janela (Maceió)', () => {
  // 2026-10-12 é segunda-feira.
  it('janela é seg–sáb 8:00–18:59 de Maceió', () => {
    expect(dentroDaJanela(maceio('2026-10-12T08:00:00'))).toBe(true);
    expect(dentroDaJanela(maceio('2026-10-12T18:59:00'))).toBe(true);
    expect(dentroDaJanela(maceio('2026-10-12T19:00:00'))).toBe(false);
    expect(dentroDaJanela(maceio('2026-10-12T07:59:00'))).toBe(false);
    expect(dentroDaJanela(maceio('2026-10-17T10:00:00'))).toBe(true); // sábado
    expect(dentroDaJanela(maceio('2026-10-18T10:00:00'))).toBe(false); // domingo
  });

  it('dia de Maceió vira à meia-noite local, não à meia-noite UTC', () => {
    expect(chaveDiaMaceio(maceio('2026-10-12T22:30:00'))).toBe('2026-10-12'); // já é dia 13 em UTC
  });

  it('fora da janela, o 1º toque vai pro próximo início (8h, pulando domingo)', () => {
    expect(proximoInicioJanela(maceio('2026-10-12T07:00:00')).toISOString()).toBe(maceio('2026-10-12T08:00:00').toISOString());
    expect(proximoInicioJanela(maceio('2026-10-12T20:00:00')).toISOString()).toBe(maceio('2026-10-13T08:00:00').toISOString());
    expect(proximoInicioJanela(maceio('2026-10-17T19:30:00')).toISOString()).toBe(maceio('2026-10-19T08:00:00').toISOString());
    const dentro = maceio('2026-10-12T10:15:00');
    expect(proximoInicioJanela(dentro)).toBe(dentro);
  });

  it('agendamentos: toque 1 agora; demais = dia do toque 1 + offset às 9h; domingo vai pra segunda', () => {
    const agora = maceio('2026-10-12T10:00:00'); // segunda
    const datas = calcularAgendamentos(agora, [0, 3, 7, 14]);
    expect(datas[0]).toBe(agora);
    expect(datas[1].toISOString()).toBe(maceio('2026-10-15T09:00:00').toISOString());
    expect(datas[2].toISOString()).toBe(maceio('2026-10-19T09:00:00').toISOString());
    expect(datas[3].toISOString()).toBe(maceio('2026-10-26T09:00:00').toISOString());
    // Quinta + 3 = domingo → segunda.
    const quinta = calcularAgendamentos(maceio('2026-10-15T11:00:00'), [0, 3]);
    expect(quinta[1].toISOString()).toBe(maceio('2026-10-19T09:00:00').toISOString());
  });

  it('adiar = amanhã 9h; sábado adia pra segunda', () => {
    expect(amanhaAsNove(maceio('2026-10-12T15:00:00')).toISOString()).toBe(maceio('2026-10-13T09:00:00').toISOString());
    expect(amanhaAsNove(maceio('2026-10-17T15:00:00')).toISOString()).toBe(maceio('2026-10-19T09:00:00').toISOString());
  });

  it('reancora os próximos toques a partir do envio real (nunca puxa pra antes)', () => {
    const offsets = [0, 3, 7];
    const plan = maceio('2026-10-15T09:00:00');
    const sent = maceio('2026-10-14T16:00:00'); // toque 1 saiu 2 dias atrasado
    const r = reancorarToques(
      [
        { id: 'b', toque: 2, agendado_para: plan },
        { id: 'c', toque: 3, agendado_para: maceio('2026-10-19T09:00:00') },
      ],
      1,
      sent,
      offsets,
    );
    expect(r).toEqual([
      { id: 'b', agendado_para: new Date(sent.getTime() + 3 * DIA) },
      { id: 'c', agendado_para: new Date(sent.getTime() + 7 * DIA) },
    ]);
    // Enviado no horário: nada muda.
    expect(reancorarToques([{ id: 'b', toque: 2, agendado_para: plan }], 1, maceio('2026-10-12T08:05:00'), offsets)).toEqual([]);
  });

  it('intervalo entre envios no mesmo chip fica entre 3 e 7 min', () => {
    expect(intervaloChipMs(0)).toBe(3 * 60_000);
    expect(intervaloChipMs(0.999)).toBeLessThan(7 * 60_000);
    expect(intervaloChipMs(0.5)).toBe(5 * 60_000);
  });
});

describe('régua de reativação — quem entra (planejador)', () => {
  const agora = maceio('2026-10-12T10:00:00');
  const base: DadosCandidato = {
    colunaGeral: 'conversa',
    ultimaMsgReal: { direction: 'out', created_at: new Date(agora.getTime() - 3 * DIA) },
    temEventoFuturo: false,
    noShow: null,
    temCicloAtivo: false,
    colunasBloqueadas: new Set(),
  };
  const ligadas = new Set(['novo', 'conversa', 'convite', 'agendado', 'orcamento']);

  it('parado há 3 dias com a clínica falando por último → entra', () => {
    const r = avaliarCandidato(base, ligadas, agora);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.coluna).toBe('conversa');
  });

  it('última mensagem do lead → NÃO entra (a clínica deve responder)', () => {
    const r = avaliarCandidato({ ...base, ultimaMsgReal: { direction: 'in', created_at: base.ultimaMsgReal!.created_at } }, ligadas, agora);
    expect(r).toEqual({ ok: false, motivo: expect.stringContaining('lead') });
  });

  it('respeita mínimo e máximo de dias parado', () => {
    expect(avaliarCandidato({ ...base, ultimaMsgReal: { direction: 'out', created_at: new Date(agora.getTime() - DIA) } }, ligadas, agora).ok).toBe(false);
    expect(avaliarCandidato({ ...base, ultimaMsgReal: { direction: 'out', created_at: new Date(agora.getTime() - 121 * DIA) } }, ligadas, agora).ok).toBe(false);
  });

  it('coluna desligada, fora da régua, ciclo ativo, reciclo e consulta futura barram', () => {
    expect(avaliarCandidato(base, new Set(['novo']), agora).ok).toBe(false);
    expect(avaliarCandidato({ ...base, colunaGeral: 'fechamento' }, ligadas, agora).ok).toBe(false);
    expect(avaliarCandidato({ ...base, temCicloAtivo: true }, ligadas, agora).ok).toBe(false);
    expect(avaliarCandidato({ ...base, colunasBloqueadas: new Set(['conversa']) }, ligadas, agora).ok).toBe(false);
    expect(avaliarCandidato({ ...base, temEventoFuturo: true }, ligadas, agora).ok).toBe(false);
  });

  it('não-paciente (fornecedor/currículo/parceria/negócio/spam) NUNCA entra — nem na coluna faltou', () => {
    expect(avaliarCandidato({ ...base, naoPaciente: true }, ligadas, agora)).toEqual({ ok: false, motivo: MOTIVO_NAO_PACIENTE });
    const falta = { ...base, colunaGeral: 'agendado', noShow: { id: 'ev1', startNaive: new Date('2026-10-11T14:00:00Z') }, naoPaciente: true };
    expect(avaliarCandidato(falta, ligadas, agora)).toEqual({ ok: false, motivo: 'não é paciente' });
    // campo ausente (chamadas antigas) = pode ser paciente
    expect(avaliarCandidato({ ...base, naoPaciente: false }, ligadas, agora).ok).toBe(true);
  });

  it('ehNaoPaciente: só com categoria preenchida', () => {
    expect(ehNaoPaciente({ non_patient_category: 'CURRICULO' })).toBe(true);
    expect(ehNaoPaciente({ non_patient_category: 'FORNECEDOR' })).toBe(true);
    expect(ehNaoPaciente({ non_patient_category: null })).toBe(false);
    expect(ehNaoPaciente({ non_patient_category: '  ' })).toBe(false);
    expect(ehNaoPaciente({})).toBe(false);
    expect(ehNaoPaciente(null)).toBe(false);
  });

  it('faltou: NO_SHOW de ontem entra; de hoje espera; lead que escreveu depois da falta não entra', () => {
    const ontem = { id: 'ev1', startNaive: new Date('2026-10-11T14:00:00Z') }; // 14h de Maceió (naive)
    const falta = { ...base, colunaGeral: 'agendado', noShow: ontem, ultimaMsgReal: { direction: 'in', created_at: maceio('2026-10-10T09:00:00') } };
    const ok = avaliarCandidato(falta, ligadas, agora);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.refEventId).toBe('ev1');
    expect(avaliarCandidato({ ...falta, noShow: { id: 'ev2', startNaive: new Date('2026-10-12T08:00:00Z') } }, ligadas, agora).ok).toBe(false);
    expect(
      avaliarCandidato({ ...falta, ultimaMsgReal: { direction: 'in', created_at: maceio('2026-10-11T18:00:00') } }, ligadas, agora).ok,
    ).toBe(false);
    expect(avaliarCandidato({ ...falta, noShow: null }, ligadas, agora).ok).toBe(false);
  });

  it('mensagens reais ignoram notas e os toques da própria régua', () => {
    const msgs = [
      { direction: 'out', type: 'text', created_at: new Date(3), external_message_id: 'EVO_REGUA' },
      { direction: 'out', type: 'text', created_at: new Date(2), external_message_id: 'sys_reativacao_1' },
      { direction: 'out', type: 'note', created_at: new Date(1), external_message_id: null },
      { direction: 'in', type: 'text', created_at: new Date(0), external_message_id: 'X' },
    ];
    expect(mensagensReais(msgs, new Set(['EVO_REGUA']))[0].direction).toBe('in');
  });

  it('nota interna (internal_note) e transferência (transfer_event) não são mensagem real', () => {
    const msgs = [
      { direction: 'out', type: 'transfer_event', created_at: new Date(3), external_message_id: null },
      { direction: 'out', type: 'internal_note', created_at: new Date(2), external_message_id: null, text: 'dra autorizou 10% e 12x' },
      { direction: 'in', type: 'text', created_at: new Date(1), external_message_id: 'X', text: 'qual o valor do clareamento?' },
    ];
    expect(mensagensReais(msgs, new Set())[0].direction).toBe('in');
    expect(ehMensagemReal(msgs[0], new Set())).toBe(false);
    expect(ehMensagemReal(msgs[1], new Set())).toBe(false);
    // Lead com pergunta sem resposta + nota interna depois → NÃO entra na régua.
    const ult = mensagensReais(msgs, new Set())[0];
    const r = avaliarCandidato({ ...base, ultimaMsgReal: { direction: ult.direction, created_at: new Date(agora.getTime() - 3 * DIA) } }, ligadas, agora);
    expect(r.ok).toBe(false);
  });

  it('saída automática de outra nutrição (sys_followup_/sys_broadcast_) não zera o relógio de parado', () => {
    const msgs = [
      { direction: 'out', type: 'text', created_at: new Date(agora.getTime() - 2 * DIA), external_message_id: 'sys_followup_legacy_1' },
      { direction: 'out', type: 'text', created_at: new Date(agora.getTime() - 4 * DIA), external_message_id: 'sys_broadcast_9' },
      { direction: 'out', type: 'text', created_at: new Date(agora.getTime() - 200 * DIA), external_message_id: 'EVO_HUMANO' },
    ];
    const ult = mensagensReais(msgs, new Set())[0];
    expect(ult.external_message_id).toBe('EVO_HUMANO');
    const r = avaliarCandidato({ ...base, ultimaMsgReal: { direction: ult.direction, created_at: ult.created_at } }, ligadas, agora);
    expect(r).toEqual({ ok: false, motivo: 'parado há tempo demais' });
    // IA de verdade (sys_ai_) continua sendo conversa.
    expect(ehMensagemReal({ direction: 'out', created_at: new Date(), external_message_id: 'sys_ai_1' }, new Set())).toBe(true);
  });

  it('eco do webhook (id real) de um envio automático é reconhecido pelo horário (±3 min)', () => {
    const envioAuto = agora.getTime() - 3 * DIA;
    const eco = { direction: 'out', type: 'text', created_at: new Date(envioAuto + 40_000), external_message_id: '3EB0ECO' };
    const humana = { direction: 'out', type: 'text', created_at: new Date(envioAuto + 10 * 60_000), external_message_id: '3EB0HUMANO' };
    const lead = { direction: 'in', type: 'text', created_at: new Date(envioAuto - 60_000), external_message_id: '3EB0LEAD' };
    expect(ehMensagemReal(eco, new Set(), [envioAuto])).toBe(false);
    expect(ehMensagemReal({ ...eco, created_at: new Date(envioAuto - 2 * 60_000) }, new Set(), [envioAuto])).toBe(false);
    expect(ehMensagemReal(humana, new Set(), [envioAuto])).toBe(true); // fora da janela: continua real
    expect(ehMensagemReal(lead, new Set(), [envioAuto])).toBe(true); // 'in' nunca é automação
    expect(ehMensagemReal(eco, new Set())).toBe(true); // sem os horários, o id real enganava
    // Cutucão legado com id real depois de 200 dias de silêncio não zera o relógio.
    const antiga = { direction: 'out', type: 'text', created_at: new Date(agora.getTime() - 200 * DIA), external_message_id: '3EB0VELHA' };
    const ult = mensagensReais([eco, antiga], new Set(), [envioAuto])[0];
    expect(ult.external_message_id).toBe('3EB0VELHA');
    expect(avaliarCandidato({ ...base, ultimaMsgReal: ult }, ligadas, agora)).toEqual({ ok: false, motivo: 'parado há tempo demais' });
  });

  it('carência pelo horário do envio automático (broadcast não grava last_followup_at)', () => {
    expect(emCarenciaDeNutricao(null, [], agora, [agora.getTime() - DIA])).toBe(true);
    expect(emCarenciaDeNutricao(null, [], agora, [agora.getTime() - 4 * DIA])).toBe(false);
    expect(emCarenciaDeNutricao(null, [], agora, [])).toBe(false);
  });

  it('carência de 3 dias depois de outra nutrição (last_followup_at ou sys_* recente)', () => {
    expect(emCarenciaDeNutricao(new Date(agora.getTime() - DIA), [], agora)).toBe(true);
    expect(emCarenciaDeNutricao(new Date(agora.getTime() - 4 * DIA), [], agora)).toBe(false);
    expect(emCarenciaDeNutricao(null, [], agora)).toBe(false);
    const broadcast = [{ direction: 'out', created_at: new Date(agora.getTime() - DIA), external_message_id: 'sys_broadcast_1' }];
    expect(emCarenciaDeNutricao(null, broadcast, agora)).toBe(true);
    const ia = [{ direction: 'out', created_at: new Date(agora.getTime() - DIA), external_message_id: 'sys_followup_ia_1' }];
    expect(emCarenciaDeNutricao(null, ia, agora)).toBe(true);
    const antigo = [{ direction: 'out', created_at: new Date(agora.getTime() - 5 * DIA), external_message_id: 'sys_followup_ia_1' }];
    expect(emCarenciaDeNutricao(null, antigo, agora)).toBe(false);
  });

  it('recusou no histórico: só mensagem do lead; regra ampla pra pular, ambíguo não casa', () => {
    const m = (direction: string, text: string, type = 'text') => ({ direction, type, text, created_at: new Date(1) });
    expect(pedidoDeParar([m('out', 'Tudo bem, desculpe o incômodo!'), m('in', 'pare de me mandar mensagem')])?.text).toBe(
      'pare de me mandar mensagem',
    );
    expect(pedidoDeParar([m('in', 'Não tenho interesse, obrigado')])).not.toBeNull();
    for (const recusa of [
      'Não tenho interesse no momento',
      'Não tenho interesse 🙏',
      'Sem interesse no momento',
      'Não quero mais receber mensagens',
      'Me tira dessa lista',
      'Não tenho mais interesse',
      'Por favor não me mande mais mensagem',
      'Pode parar de mandar mensagem',
      'Parem de mandar mensagem',
      'Não tenho interesse agora',
    ]) {
      expect({ recusa, pulou: pedidoDeParar([m('in', recusa)]) != null }).toEqual({ recusa, pulou: true });
    }
    for (const ambiguo of ['Cancelar a consulta de amanhã', 'Remover o siso dói?', 'Não quero esperar muito']) {
      expect({ ambiguo, pulou: pedidoDeParar([m('in', ambiguo)]) != null }).toEqual({ ambiguo, pulou: false });
    }
    expect(pedidoDeParar([m('out', 'pare')])).toBeNull(); // a clínica dizendo "pare" não é opt-out
    expect(pedidoDeParar([m('in', 'pare', 'internal_note')])).toBeNull();
    expect(pedidoDeParar([m('in', `pare ${'x'.repeat(80)}`)])).toBeNull();
  });

  it('opt-out PERMANENTE (despachante) exige a regra estrita; recusa só pela ampla não tranca', () => {
    const estrito = (t: string) => REATIVACAO_OPT_OUT_RE.test(t.trim());
    expect(estrito('pare de me mandar mensagem')).toBe(true);
    expect(estrito('Não tenho interesse, obrigado')).toBe(true);
    // "Não tenho interesse em clareamento, mas quero limpeza" pula o ciclo, mas não tranca o contato.
    const misto = 'Não tenho interesse em clareamento, mas quero limpeza';
    expect(pedidoDeParar([{ direction: 'in', type: 'text', text: misto, created_at: new Date(1) }])).not.toBeNull();
    expect(estrito(misto)).toBe(false);
  });

  it('opt-out PERMANENTE só se o pedido veio depois de um toque enviado', () => {
    const pedido = maceio('2026-10-10T10:00:00');
    expect(optOutDefinitivo(pedido, [maceio('2026-10-09T10:00:00')])).toBe(true);
    expect(optOutDefinitivo(pedido, [maceio('2026-10-11T10:00:00')])).toBe(false);
    expect(optOutDefinitivo(pedido, [])).toBe(false);
  });

  it('despachante: última mensagem real do lead = respondeu (faltou compara com o NO_SHOW)', () => {
    const inMsg = (iso: string) => ({ direction: 'in', created_at: maceio(iso) });
    expect(leadFalouPorUltimo(inMsg('2026-10-12T09:00:00'), 'conversa', null)).toBe(true);
    expect(leadFalouPorUltimo({ direction: 'out', created_at: new Date() }, 'conversa', null)).toBe(false);
    expect(leadFalouPorUltimo(null, 'novo', null)).toBe(false);
    const falta = new Date('2026-10-11T14:00:00Z'); // 14h de Maceió (naive)
    expect(leadFalouPorUltimo(inMsg('2026-10-11T09:00:00'), 'agendado', falta)).toBe(false); // "confirmado!" antes da falta
    expect(leadFalouPorUltimo(inMsg('2026-10-11T18:00:00'), 'agendado', falta)).toBe(true);
    expect(leadFalouPorUltimo(inMsg('2026-10-11T09:00:00'), 'agendado', null)).toBe(true); // sem o evento: na dúvida não manda
  });

  it('consulta de HOJE já começada (AGENDADO) ainda conta como agendou; de ontem não', () => {
    const agora1030 = maceio('2026-10-12T10:30:00');
    expect(inicioDiaNaive(agora1030).toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(inicioDiaNaive(maceio('2026-10-12T22:30:00')).toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(consultaContaComoAgendou(new Date('2026-10-12T10:00:00Z'), agora1030)).toBe(true);
    expect(consultaContaComoAgendou(new Date('2026-10-20T08:00:00Z'), agora1030)).toBe(true);
    expect(consultaContaComoAgendou(new Date('2026-10-11T15:00:00Z'), agora1030)).toBe(false);
  });

  it('mesmo número em 2 leads: fica 1 por número; número com gêmeo bloqueado sai', () => {
    const a = { id: 'a', phone: '5582999657814', recencia: 2 };
    const b = { id: 'b', phone: '558299657814', recencia: 1 };
    const c = { id: 'c', phone: '5582988887777', recencia: 3 };
    expect(chaveDoNumero('a', a.phone)).toBe(chaveDoNumero('b', b.phone));
    expect(deduplicarPorNumero([a, b, c], []).map((x) => x.id)).toEqual(['a', 'c']);
    // Gêmeo (fora dos candidatos) virou cliente / pediu pra parar / está em ciclo → o número sai.
    expect(
      deduplicarPorNumero([a, b, c], [{ id: 'z', phone: '82999657814', bloqueado: true }]).map((x) => x.id),
    ).toEqual(['c']);
    // Sem telefone: cada lead é ele mesmo.
    expect(deduplicarPorNumero([{ id: 'x', phone: null, recencia: 1 }, { id: 'y', phone: '', recencia: 1 }], []).map((x) => x.id)).toEqual([
      'x',
      'y',
    ]);
  });

  it('lote: quem esfriou há menos tempo primeiro, até as vagas (cota = teto/3)', () => {
    const l = selecionarLote(
      [
        { id: 'a', paradoDesde: new Date(1000) },
        { id: 'b', paradoDesde: new Date(3000) },
        { id: 'c', paradoDesde: new Date(2000) },
      ],
      2,
    );
    expect(l.map((x) => x.id)).toEqual(['b', 'c']);
    expect(selecionarLote([{ paradoDesde: new Date() }], 0)).toEqual([]);
    expect(cotaNovosCiclos(30)).toBe(10);
    // Teto 1 ou 2 ("começar devagar"): no mínimo 1 ciclo novo por dia, nunca 0.
    expect(cotaNovosCiclos(2)).toBe(1);
    expect(cotaNovosCiclos(1)).toBe(1);
  });

  it('disjuntor do chip: 2 "pode ter saído" seguidos abrem; um ENVIADO no meio não', () => {
    const talvez = { status: 'FALHOU', motivo: `${MOTIVO_PODE_TER_SAIDO} (timeout)` };
    const interno = { status: 'FALHOU', motivo: `erro interno (${MOTIVO_PODE_TER_SAIDO})` };
    expect(disjuntorAbre([talvez, interno])).toBe(true);
    expect(disjuntorAbre([talvez, { status: 'ENVIADO', motivo: null }])).toBe(false);
    expect(disjuntorAbre([talvez, { status: 'FALHOU', motivo: 'recusado pela Evolution (401)' }])).toBe(false);
    expect(disjuntorAbre([talvez])).toBe(false);
  });

  it('reciclo: bloqueia se algo saiu ou se foi parado de propósito; não bloqueia prévia técnica', () => {
    expect(cicloBloqueiaReciclo({ status: 'RESPONDEU', motivo_fim: 'respondeu', teveEnvio: true })).toBe(true);
    expect(cicloBloqueiaReciclo({ status: 'CANCELADA', motivo_fim: 'parado manualmente', teveEnvio: false })).toBe(true);
    expect(cicloBloqueiaReciclo({ status: 'CANCELADA', motivo_fim: MOTIVO_COLUNA_DESLIGADA, teveEnvio: false })).toBe(false);
    expect(cicloBloqueiaReciclo({ status: 'RESPONDEU', motivo_fim: 'respondeu', teveEnvio: false })).toBe(false);
  });
});

describe('régua de reativação — variáveis e horários', () => {
  it('rótulo do horário pro cliente', () => {
    expect(rotuloHorario('2026-10-15', '14:00')).toBe('quinta 15/10 às 14:00');
  });

  it('2 horários: 1º de cada um dos 2 dias mais próximos; 1 dia só → 2 horários dele', () => {
    expect(
      escolherHorarios([
        { diaISO: '2026-10-13', horas: ['08:00', '09:00'] },
        { diaISO: '2026-10-14', horas: ['10:00'] },
      ]),
    ).toEqual([
      { diaISO: '2026-10-13', hora: '08:00' },
      { diaISO: '2026-10-14', hora: '10:00' },
    ]);
    expect(escolherHorarios([{ diaISO: '2026-10-13', horas: ['08:00', '09:00', '10:00'] }])).toHaveLength(2);
    expect(escolherHorarios([])).toEqual([]);
  });

  it('interesse e dentista', () => {
    expect(interesseDoFunil('Odontologia Clínica')).toBe('odontologia clínica');
    expect(interesseDoFunil(null)).toBe('seu atendimento');
    expect(dentistaDoModelo('Dra. SUELLEN Passos')).toBe('Dra. Suellen');
    expect(dentistaDoModelo(null)).toBe('doutora');
    // Orçamentista homem nunca vira "Dra.".
    expect(dentistaDoModelo('Dr. Carlos Lima')).toBe('equipe de avaliação');
  });

  it('preço não liberado sai do modelo cru sem partir "Dra." no meio', () => {
    const modelo = 'O primeiro passo é a avaliação com a {dentista}: fotos e plano, tudo isso por apenas R$ 150.\n\nQuer ver um horário?';
    expect(semPrecoNaoLiberado(modelo, new Set())).toBe('Quer ver um horário?');
    expect(semPrecoNaoLiberado(modelo, new Set([150]))).toBe(modelo); // liberado: texto intacto
    // Texto renderizado sem preço nenhum não é reformatado.
    expect(semPrecoNaoLiberado('Oi, com a Dra. Ana.\nTudo bem?', new Set())).toBe('Oi, com a Dra. Ana.\nTudo bem?');
  });

  it('preço ligado ao procedimento: {valor_*} vem da linha certa da tabela; sem a linha, a frase sai', () => {
    const tabela = 'Consulta de avaliação: R$ 150\nLimpeza completa — R$ 350\nManutenção de aparelho: R$ 150';
    expect(valoresPorProcedimento(tabela, true)).toEqual({ valor_avaliacao: 'R$ 150', valor_limpeza: 'R$ 350' });
    expect(valoresPorProcedimento(tabela, false)).toEqual({ valor_avaliacao: '', valor_limpeza: '' });
    // Gancho 'odonto' sem limpeza na tabela: a frase do preço sai, o resto fica.
    const semLimpeza = semFraseDeValorVazio(REATIVACAO_GANCHOS.odonto, { valor_limpeza: '' });
    expect(semLimpeza).toMatch(/fio dental\.$/);
    expect(semLimpeza).not.toMatch(/\{valor_limpeza\}|R\$/);
    expect(renderReativacaoModelo(semFraseDeValorVazio(REATIVACAO_GANCHOS.odonto, { valor_limpeza: 'R$ 350' }), { valor_limpeza: 'R$ 350' })).toMatch(
      /Tudo isso fica apenas R\$ 350\.$/,
    );
    // Sem {valor_*} vazio o texto não é reformatado (o corte por frase juntaria as linhas).
    expect(semFraseDeValorVazio('Oi, com a {dentista}.\nTudo bem?', {})).toBe('Oi, com a {dentista}.\nTudo bem?');
  });

  it('valor que coincide com OUTRO item da tabela não libera a frase (Clareamento 350, Restauração 150)', () => {
    const tabela = 'Clareamento: R$ 350\nRestauração: R$ 150';
    const valores = valoresPorProcedimento(tabela, true);
    const liberados = precosLiberados(tabela, true);
    expect(valores).toEqual({ valor_avaliacao: '', valor_limpeza: '' });
    const gancho = renderReativacaoModelo(semPrecoNaoLiberado(semFraseDeValorVazio(REATIVACAO_GANCHOS.odonto, valores), liberados), valores);
    const modelo = semPrecoNaoLiberado(semFraseDeValorVazio(DEFAULT_REATIVACAO_MODELOS.conversa[1], valores), liberados);
    const fb = renderizarModeloFallback(modelo, { nome: 'Ana', interesse: 'limpeza', dentista: 'Dra. Ana', gancho, ...valores });
    expect(fb).not.toBeNull();
    expect(extrairValoresDinheiro(fb!)).toEqual([]);
    expect(fb).not.toMatch(/\{|\}/);
  });

  it('a validação compara com o modelo JÁ com os valores: R$ 150 passa com valor_avaliacao, é recusado sem', () => {
    const preparar = (tabela: string) => {
      const valores = valoresPorProcedimento(tabela, true);
      const liberados = precosLiberados(tabela, true);
      const modelo = semPrecoNaoLiberado(semFraseDeValorVazio(DEFAULT_REATIVACAO_MODELOS.conversa[1], valores), liberados);
      const vars = { nome: 'Ana', interesse: 'implantes', dentista: 'Dra. Ana', gancho: 'Gancho.', ...valores };
      return { modeloRenderizado: semPrecoNaoLiberado(renderReativacaoModelo(modelo, vars), liberados), precosLiberados: liberados, horarios: [], datas: [] };
    };
    const ia = 'Ana, a avaliação com a Dra. Ana fica apenas R$ 150.\n\nQuer que eu veja um horário?';
    const com = preparar('Avaliação: R$ 150');
    expect(com.modeloRenderizado).toContain('R$ 150');
    expect(validarTextoReativacao(ia, com)).toEqual({ ok: true });
    // Tabela só com Restauração R$ 150: o número existe, mas não é o da avaliação.
    const sem = preparar('Restauração: R$ 150');
    expect(sem.modeloRenderizado).not.toContain('R$');
    expect(validarTextoReativacao(ia, sem).ok).toBe(false);
  });

  it('fallback sem IA: tira o vocativo sem nome e recusa o que só a IA resolve', () => {
    expect(renderizarModeloFallback('Oi, {nome}! Aqui é da {clinica}.\n\n{nome}, quer ver um horário?', { clinica: 'Clínica X' })).toBe(
      'Oi! Aqui é da Clínica X.\n\nQuer ver um horário?',
    );
    expect(renderizarModeloFallback('Oi, {nome}!\n\n[resposta à dúvida]', { nome: 'Ana' })).toBeNull();
    expect(renderizarModeloFallback('Tenho {horario1} ou {horario2}.', {})).toBeNull();
  });
});

describe('régua de reativação — texto da IA', () => {
  const ctx = {
    modeloRenderizado: 'Oi, Ana!\n\nA avaliação fica apenas R$ 150.\n\nTenho quinta 15/10 às 14:00 ou sexta 16/10 às 09:00.',
    precosLiberados: new Set([150, 350]),
    horarios: ['14:00', '09:00'],
    datas: ['15/10', '16/10'],
  };

  it('limpa assinatura, travessão, emoji extra e balões além de 4', () => {
    const t = sanitizarTextoIA('"*Sophia:* Oi, Ana 😊 — tudo bem? 🙂\n\nB\n\n\n\nC\n\nD\n\nE"');
    expect(t.startsWith('Oi, Ana 😊, tudo bem?')).toBe(true);
    expect(t).not.toContain('🙂');
    expect(dividirBaloes(t)).toHaveLength(4);
  });

  it('aceita texto bom', () => {
    expect(validarTextoReativacao('Oi, Ana!\n\nA avaliação fica apenas R$ 150.\n\nQuinta 15/10 às 14:00 serve?', ctx)).toEqual({ ok: true });
  });

  it('recusa link, colchete, variável, valor/horário/data inventados, frase proibida e "sou IA"', () => {
    const ruim = (t: string) => validarTextoReativacao(t, ctx).ok;
    expect(ruim('Veja https://x.com')).toBe(false);
    expect(ruim('Oi [resposta]')).toBe(false);
    expect(ruim('Oi {nome}')).toBe(false);
    expect(ruim('Fica R$ 99 hoje')).toBe(false);
    expect(ruim('Tenho às 16h amanhã?')).toBe(false);
    expect(ruim('Pode dia 20/10?')).toBe(false);
    expect(ruim('Qualquer coisa, fico à disposição!')).toBe(false);
    expect(ruim('Você sumiu, Ana!')).toBe(false);
    expect(ruim('Sou uma assistente virtual da clínica')).toBe(false);
    expect(ruim('Sou a IA da clínica')).toBe(false);
    expect(ruim('x'.repeat(701))).toBe(false);
    expect(ruim('   ')).toBe(false);
  });

  it('"ia" do verbo ir não é "diz que é IA"', () => {
    expect(validarTextoReativacao('Vi que você ia vir na avaliação. Quer remarcar?', ctx)).toEqual({ ok: true });
    expect(validarTextoReativacao('Eu ia te mandar os horários. Posso?', ctx)).toEqual({ ok: true });
  });

  it('limite de caracteres é o do @crm/shared (o mesmo do editor da API)', () => {
    expect(TEXTO_MAX_CHARS).toBe(REATIVACAO_TEXTO_MAX);
    expect(validarTextoReativacao('x'.repeat(REATIVACAO_TEXTO_MAX), ctx).ok).toBe(true);
    expect(validarTextoReativacao('x'.repeat(REATIVACAO_TEXTO_MAX + 1), ctx).ok).toBe(false);
  });

  it('preço: "N reais", "N mil" e % também são checados; só passa valor liberado E do modelo', () => {
    const ok = (t: string, c = ctx) => validarTextoReativacao(t, c).ok;
    expect(ok('A avaliação sai 120 reais. Quer agendar?')).toBe(false);
    expect(ok('Sai 2 mil reais no total. Quer agendar?')).toBe(false);
    expect(ok('Consigo 10% de desconto à vista. Quer?')).toBe(false);
    expect(ok('Consigo 10 por cento de desconto. Quer?')).toBe(false);
    expect(ok('A avaliação fica 150 reais. Quer agendar?')).toBe(true); // paráfrase do valor do modelo
    // R$ 350 é liberado na tabela, mas não está NESTE modelo (a IA tirou do histórico).
    expect(ok('A limpeza fica R$ 350. Quer agendar?')).toBe(false);
    // Valor no modelo mas a clínica não liberou (tabela vazia / preços desligados).
    expect(ok('A avaliação fica apenas R$ 150. Quer?', { ...ctx, precosLiberados: new Set() })).toBe(false);
    // Percentual que o modelo da clínica já traz passa.
    const comPct = { ...ctx, modeloRenderizado: `${ctx.modeloRenderizado}\n\nÀ vista tem 5% de desconto.` };
    expect(ok('À vista sai com 5% de desconto. Quer?', comPct)).toBe(true);
  });

  it('recusa horário real no dia da semana errado', () => {
    const c = { ...ctx, diasHorarios: [{ dia: 4, hora: '14:00' }, { dia: 5, hora: '09:00' }] };
    expect(validarTextoReativacao('Consigo quinta às 14:00 ou sexta às 9h. Qual prefere?', c)).toEqual({ ok: true });
    expect(validarTextoReativacao('Consigo quarta às 14:00. Pode ser?', c).ok).toBe(false);
    expect(validarTextoReativacao('Consigo quinta às 14:00 ou às 9h. Pode ser?', c).ok).toBe(false); // 9h ficou na quinta
    expect(paresDiaHora('terça-feira, 13/10 às 08:30')).toEqual([{ dia: 2, hora: '08:30' }]);
  });

  it('hora por extenso ("às 15 horas", "às 3 da tarde", "às 14") também é checada', () => {
    const c = { ...ctx, horarios: ['09:00', '10:00'], modeloRenderizado: 'Oi, Ana!\n\nQuer ver um horário?' };
    expect(validarTextoReativacao('Quinta às 15 horas serve?', c).ok).toBe(false);
    expect(validarTextoReativacao('Quinta às 3 da tarde serve?', c).ok).toBe(false);
    expect(validarTextoReativacao('Posso te encaixar às 14', c).ok).toBe(false);
    const comVaga = { ...ctx, horarios: ['14:00'], diasHorarios: [{ dia: 4, hora: '14:00' }] };
    expect(validarTextoReativacao('Quinta às 2 da tarde serve?', comVaga)).toEqual({ ok: true });
    expect(validarTextoReativacao('Quarta às 2 da tarde serve?', comVaga).ok).toBe(false); // dia trocado
    expect(extrairHorarios('às 15 horas, às 3 da tarde, às 9 da manhã, pelas 20h')).toEqual(['15:00', '15:00', '09:00', '20:00']);
    expect(paresDiaHora('quinta às 3 da tarde')).toEqual([{ dia: 4, hora: '15:00' }]);
  });

  it('hora no fim da frase ou sem "às" também é checada', () => {
    const c = { ...ctx, horarios: ['09:00', '10:00'], modeloRenderizado: 'Oi, Ana!\n\nQuer ver um horário?' };
    expect(validarTextoReativacao('Consigo quinta às 15.', c).ok).toBe(false);
    expect(validarTextoReativacao('Pode ser quinta às 15, ok?', c).ok).toBe(false);
    expect(validarTextoReativacao('Tenho quinta, 15 horas.', c).ok).toBe(false);
    expect(validarTextoReativacao('Tenho quinta 3 da tarde.', c).ok).toBe(false);
    expect(extrairHorarios('às 15. às 16, ok? quinta, 17 horas, ou 6 da tarde')).toEqual(['15:00', '16:00', '17:00', '18:00']);
  });

  it('número que não é hora não vira horário', () => {
    expect(extrairHorarios('fica pronto em 2 horas')).toEqual([]);
    expect(extrairHorarios('a consulta dura 1 hora')).toEqual([]);
    expect(extrairHorarios('leva de 2 a 3 horas')).toEqual([]);
    expect(extrairHorarios('às 10 reais')).toEqual([]);
    expect(extrairHorarios('em até 10x sem juros, dura 30 minutos')).toEqual([]);
    expect(extrairHorarios('uma das 2 opções, as 3 etapas, às 2,5 vezes')).toEqual([]);
  });

  it('extrai valores, percentuais e horários em formatos variados', () => {
    expect(extrairValoresDinheiro('apenas R$ 1.500 ou R$150,00')).toEqual([1500, 150]);
    expect(extrairValoresDinheiro('sai 120 reais ou 2 mil')).toEqual([120, 2000]);
    expect(extrairPercentuais('10% ou 5,5 por cento')).toEqual([10, 5.5]);
    expect(extrairHorarios('às 9h, 9h30, 14:00 e 24h por dia, de 20 a 30 minutos')).toEqual(['09:00', '09:30', '14:00']);
  });

  it('texto com horário só vale no dia em que foi escrito; qualquer um vence em 3 dias', () => {
    const agora = maceio('2026-10-13T09:00:00');
    expect(textoPrecisaReescrever('Tenho 14:00', maceio('2026-10-12T18:00:00'), agora)).toBe(true);
    expect(textoPrecisaReescrever('Tenho 14:00', maceio('2026-10-13T08:00:00'), agora)).toBe(false);
    expect(textoPrecisaReescrever('Oi, tudo bem?', maceio('2026-10-12T18:00:00'), agora)).toBe(false);
    expect(textoPrecisaReescrever('Oi, tudo bem?', maceio('2026-10-09T18:00:00'), agora)).toBe(true);
    expect(textoPrecisaReescrever('Oi', null, agora)).toBe(true);
  });
});

describe('régua de reativação — modelos padrão passam na própria validação', () => {
  // Mesmo caminho do redator: tira a frase de {valor_*} sem item na tabela e o preço
  // não liberado no modelo CRU e no gancho, depois preenche. Clínica com avaliação e
  // limpeza na tabela, e clínica sem tabela nenhuma.
  for (const [cenario, tabela] of [
    ['avaliação R$ 150 e limpeza R$ 350 na tabela', 'Avaliação: R$ 150\nLimpeza: R$ 350'],
    ['sem tabela de valores (nenhum preço)', null],
  ] as const) {
    it(`todo modelo padrão preenchido (sem [instrução]) é um fallback válido — ${cenario}`, () => {
      const liberados = precosLiberados(tabela, true);
      const valores = valoresPorProcedimento(tabela, true);
      const vars = {
        nome: 'Ana',
        clinica: 'Instituto',
        dentista: 'Dra. Suellen',
        interesse: 'implantes',
        assunto: 'implantes',
        gancho: renderReativacaoModelo(semPrecoNaoLiberado(semFraseDeValorVazio(REATIVACAO_GANCHOS.odonto, valores), liberados), valores),
        data: '10/10',
        hora: '14:00',
        horario1: 'quinta 15/10 às 14:00',
        horario2: 'sexta 16/10 às 09:00',
        ...valores,
      };
      for (const coluna of REATIVACAO_COLUNAS) {
        DEFAULT_REATIVACAO_MODELOS[coluna].forEach((modeloBruto, i) => {
          const modelo = semPrecoNaoLiberado(semFraseDeValorVazio(modeloBruto, valores), liberados);
          const fb = renderizarModeloFallback(modelo, vars);
          if (modelo.includes('[')) {
            expect(fb).toBeNull();
            return;
          }
          const ctxV = { modeloRenderizado: fb ?? '', precosLiberados: liberados, horarios: [], datas: [] };
          expect({ coluna, toque: i + 1, ok: fb ? validarTextoReativacao(fb, ctxV).ok : false }).toEqual({ coluna, toque: i + 1, ok: true });
          expect(dividirBaloes(fb!).length).toBeLessThanOrEqual(4);
          if (!liberados.size) {
            expect(extrairValoresDinheiro(fb!)).toEqual([]);
            expect(fb).not.toMatch(/Dra\.$|Dra\.\n/); // o corte nunca parte "Dra. Suellen"
          } else if (modeloBruto.includes('{valor_avaliacao}')) {
            expect(fb).toContain(`apenas ${valores.valor_avaliacao}`); // o valor do item certo entra
          }
        });
      }
    });
  }
});

describe('régua de reativação — respostas da Evolution', () => {
  it('sucesso só com key.id', () => {
    expect(classificarEnvio({ httpStatus: 201, data: { key: { id: 'ABC' } } })).toEqual({ tipo: 'ok', id: 'ABC' });
    expect(classificarEnvio({ httpStatus: 201, data: {} }).tipo).toBe('talvez_saiu');
  });

  it('exists:false (2xx ou 400) = sem WhatsApp', () => {
    expect(classificarEnvio({ httpStatus: 201, data: { exists: false, key: { id: 'x' } } }).tipo).toBe('sem_whatsapp');
    expect(classificarEnvio({ httpStatus: 400, data: { response: { message: [{ exists: false, number: '55' }] } } }).tipo).toBe('sem_whatsapp');
  });

  it('chip caído: 428 / Connection Closed / Evolution inalcançável', () => {
    expect(classificarEnvio({ httpStatus: 428, data: {} }).tipo).toBe('chip_caido');
    expect(classificarEnvio({ httpStatus: 500, data: { error: 'Connection Closed' } }).tipo).toBe('chip_caido');
    expect(classificarEnvio({ erroCodigo: 'ECONNREFUSED' }).tipo).toBe('chip_caido');
  });

  it('timeout/5xx = pode ter saído (nunca reenviar); outro 4xx = recusado', () => {
    expect(classificarEnvio({ erroCodigo: 'ECONNABORTED', erroMensagem: 'timeout of 30000ms exceeded' }).tipo).toBe('talvez_saiu');
    expect(classificarEnvio({ httpStatus: 502, data: 'Bad Gateway' }).tipo).toBe('talvez_saiu');
    expect(classificarEnvio({ httpStatus: 401, data: { error: 'Unauthorized' } }).tipo).toBe('recusado');
  });

  it('whatsappNumbers: acha a variante que existe, ou diz que nenhuma existe', () => {
    const nums = ['558299657814', '5582999657814'];
    expect(interpretarWhatsappNumbers([{ exists: false, number: nums[0] }, { exists: true, jid: `${nums[1]}@s.whatsapp.net` }], nums)).toEqual({
      estado: 'existe',
      numero: nums[1],
    });
    expect(interpretarWhatsappNumbers([{ exists: false }, { exists: false }], nums)).toEqual({ estado: 'nao_existe' });
    expect(interpretarWhatsappNumbers({}, nums)).toEqual({ estado: 'indisponivel' });
    expect(interpretarWhatsappNumbers([], nums)).toEqual({ estado: 'indisponivel' });
  });

  it('variantes: cadastrada primeiro, só formatos com DDI 55', () => {
    expect(variantesEnvio('558299657814', ['558299657814', '8299657814', '5582999657814', '82999657814'])).toEqual([
      '558299657814',
      '5582999657814',
    ]);
  });
});
