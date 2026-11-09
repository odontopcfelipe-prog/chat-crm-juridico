import {
  ESTADO_INICIAL,
  ESPERA_REENVIO_MS,
  TETO_AVISOS_DIA,
  TENTATIVAS_ENVIO,
  VALIDADE_EPISODIO_MS,
  aberturaDoDia,
  avaliarConexao,
  avaliarSilencio,
  decidir,
  diaMaceio,
  duracao,
  ehHorarioDeAtendimento,
  estadoAposFalhaDeEnvio,
  lerEstado,
  medeSilencioAgora,
  minutosUteis,
  numeroDoChip,
  textoDoProblema,
  textoNormalizado,
  type EstadoVigia,
  type Observacao,
  type SinaisConexao,
} from './chip-vigia-regras';
import { ordenarChipsDoAviso } from './admin-alert';

const MIN = 60_000;
/** Hora de Maceió (UTC−3) em novembro de 2026. 09/11 = segunda. */
const m = (dia: number, h: number, min = 0) => Date.UTC(2026, 10, dia, h + 3, min);

/** Leituras de minuto em minuto: `padrao` = 'o' (ok) ou 'x' (fora), da mais antiga à atual. */
function leituras(padrao: string, agora: number): Observacao[] {
  const n = padrao.length;
  return padrao.split('').map((c, i) => ({ t: agora - (n - 1 - i) * MIN, ok: c === 'o' }));
}

/** Mensagens de `de` em diante, de `passo` em `passo` minutos. */
const serie = (de: number, n: number, passo: number) => Array.from({ length: n }, (_, i) => de + i * passo * MIN);

const CONEXAO_OK: SinaisConexao = {
  desconectadoDesde: null,
  desdeExato: true,
  quedas: 0,
  estavel: true,
  agoraOk: true,
  voltouEm: null,
};
/** Chip que a vigia já viu conectado. */
const VISTO: EstadoVigia = { ...ESTADO_INICIAL, vistoOpen: true };

describe('horário de atendimento (Maceió)', () => {
  it('seg–sex 8h–18h, sábado 8h–12h, domingo fechado', () => {
    expect(ehHorarioDeAtendimento(m(9, 7, 59))).toBe(false);
    expect(ehHorarioDeAtendimento(m(9, 8, 0))).toBe(true);
    expect(ehHorarioDeAtendimento(m(9, 17, 59))).toBe(true);
    expect(ehHorarioDeAtendimento(m(9, 18, 0))).toBe(false);
    expect(ehHorarioDeAtendimento(m(14, 11, 59))).toBe(true);
    expect(ehHorarioDeAtendimento(m(14, 12, 0))).toBe(false);
    expect(ehHorarioDeAtendimento(m(15, 10, 0))).toBe(false);
  });

  it('o silêncio só é medido de segunda a sexta', () => {
    expect(medeSilencioAgora(m(13, 10, 0))).toBe(true); // sexta
    expect(medeSilencioAgora(m(14, 10, 0))).toBe(false); // sábado
    expect(medeSilencioAgora(m(9, 19, 0))).toBe(false);
  });

  it('minutos úteis só contam o horário de atendimento', () => {
    expect(minutosUteis(m(9, 7, 0), m(9, 9, 0))).toBe(60);
    // sexta 17:30 → segunda 08:30: 30 (sexta) + 240 (sábado) + 0 (domingo) + 30 (segunda)
    expect(minutosUteis(m(13, 17, 30), m(16, 8, 30))).toBe(300);
    expect(minutosUteis(m(15, 0, 0), m(15, 23, 0))).toBe(0);
    expect(minutosUteis(m(9, 10, 0), m(9, 9, 0))).toBe(0);
  });

  it('abertura do dia e data local', () => {
    expect(aberturaDoDia(m(9, 15, 0))).toBe(m(9, 8, 0));
    expect(aberturaDoDia(m(15, 15, 0))).toBeNull();
    expect(diaMaceio(m(9, 23, 30))).toBe('2026-11-09'); // 02:30 UTC do dia 10
  });
});

describe('avaliarConexao', () => {
  const agora = m(9, 10, 30);

  it('10 minutos de leituras ruins depois de uma boa = desconectado desde a 1ª ruim (horário exato)', () => {
    const s = avaliarConexao(leituras('ooooo' + 'xxxxxxxxxxx', agora), agora);
    expect(s.desconectadoDesde).toBe(agora - 10 * MIN);
    expect(s.desdeExato).toBe(true);
    expect(s.agoraOk).toBe(false);
    expect(s.estavel).toBe(false);
    expect(s.voltouEm).toBeNull();
  });

  it('só leituras ruins (worker acabou de subir): desconectado, mas sem horário exato', () => {
    const s = avaliarConexao(leituras('x'.repeat(11), agora), agora);
    expect(s.desconectadoDesde).toBe(agora - 10 * MIN);
    expect(s.desdeExato).toBe(false);
  });

  it('menos de 10 minutos ruins ainda não é desconectado', () => {
    expect(avaliarConexao(leituras('oooooooo' + 'xxxxxxx', agora), agora).desconectadoDesde).toBeNull();
  });

  it('cai e volta = quedas contadas; não é desconectado', () => {
    const s = avaliarConexao(leituras('oxoxoxoxoxoxoxo', agora), agora);
    expect(s.quedas).toBe(7);
    expect(s.desconectadoDesde).toBeNull();
  });

  it('15 minutos ok = estável; voltouEm = início da sequência boa', () => {
    // A leitura ruim de 15 min atrás ainda está na janela: estável só no minuto seguinte.
    expect(avaliarConexao(leituras('xx' + 'o'.repeat(15), agora), agora).estavel).toBe(false);
    const s = avaliarConexao(leituras('xx' + 'o'.repeat(16), agora), agora);
    expect(s.estavel).toBe(true);
    expect(s.voltouEm).toBe(agora - 15 * MIN);
  });

  it('poucas leituras (worker acabou de subir) não é estável nem desconectado', () => {
    const s = avaliarConexao(leituras('oooo', agora), agora);
    expect(s.estavel).toBe(false);
    expect(s.desconectadoDesde).toBeNull();
  });
});

describe('avaliarSilencio', () => {
  // 41 mensagens de 2 em 2 min entre 08:00 e 09:20 de segunda (30 por hora).
  const movimentado = serie(m(9, 8, 0), 41, 2);

  it('chip movimentado que recebeu hoje e ficou 2 h sem nada = sem receber', () => {
    const s = avaliarSilencio(movimentado, m(9, 11, 20))!;
    expect(Math.round(s.porHora)).toBe(30);
    expect(s.ultima).toBe(m(9, 9, 20));
    expect(s.silencioMin).toBe(120);
    expect(s.semReceber).toBe(true);
    expect(avaliarSilencio(movimentado, m(9, 11, 15))!.semReceber).toBe(false);
  });

  it('não mede se o chip ainda não recebeu nada hoje (manhã calma, recesso)', () => {
    const sexta = serie(m(13, 15, 0), 41, 2);
    expect(avaliarSilencio(sexta, m(16, 11, 0))).toBeNull(); // segunda 11h
  });

  it('não mede no sábado nem fora do horário', () => {
    const sabado = serie(m(14, 8, 0), 41, 2);
    expect(avaliarSilencio(sabado, m(14, 11, 50))).toBeNull();
    expect(avaliarSilencio(movimentado, m(9, 18, 30))).toBeNull();
  });

  it('chip calmo, amostra pequena ou rajada curta: não mede', () => {
    expect(avaliarSilencio(serie(m(9, 8, 0), 31, 10), m(9, 15, 0))).toBeNull(); // 6 por hora
    expect(avaliarSilencio(movimentado.slice(0, 20), m(9, 15, 0))).toBeNull();
    // 40 respostas de campanha em 20 minutos não fazem o chip parecer movimentado.
    const rajada = Array.from({ length: 40 }, (_, i) => m(9, 8, 10) + i * 30_000);
    expect(avaliarSilencio(rajada, m(9, 15, 0))).toBeNull();
  });

  it('mensagem fora do horário não infla a média', () => {
    // 30 mensagens de madrugada + 10 durante o dia: só 10 em horário de atendimento.
    const madrugada = serie(m(9, 2, 0), 30, 2);
    expect(avaliarSilencio([...madrugada, ...serie(m(9, 8, 0), 10, 6)], m(9, 15, 0))).toBeNull();
  });
});

describe('decidir', () => {
  const agora = m(9, 14, 0);
  const desconectado: SinaisConexao = {
    desconectadoDesde: m(9, 13, 45),
    desdeExato: true,
    quedas: 1,
    estavel: false,
    agoraOk: false,
    voltouEm: null,
  };

  it('chip normal que desconecta → avisa uma vez', () => {
    const d = decidir(VISTO, desconectado, agora);
    expect(d.acao).toBe('avisar');
    if (d.acao !== 'avisar') return;
    expect(d.problema).toBe('desconectado');
    expect(d.desde).toBe(m(9, 13, 45));
    expect(d.novo).toMatchObject({ problema: 'desconectado', avisadoEm: agora, dia: '2026-11-09', avisosNoDia: 1, vistoOpen: true });
    // Mesmo problema na rodada seguinte: nada (o episódio já foi avisado).
    expect(decidir(d.novo, desconectado, agora + MIN).acao).toBe('nada');
  });

  it('chip que a vigia nunca viu conectado não vira aviso de queda', () => {
    expect(decidir({ ...ESTADO_INICIAL }, desconectado, agora).acao).toBe('nada');
    const instavel: SinaisConexao = { ...desconectado, desconectadoDesde: null, quedas: 5 };
    expect(decidir({ ...ESTADO_INICIAL }, instavel, agora).acao).toBe('nada');
  });

  it('episódio aberto + 15 min estável → normalizado com a hora em que voltou', () => {
    const aberto: EstadoVigia = { ...VISTO, problema: 'desconectado', desde: m(9, 13, 45), avisadoEm: m(9, 13, 55) };
    const d = decidir(aberto, { ...CONEXAO_OK, voltouEm: m(9, 14, 2) }, m(9, 14, 17));
    expect(d.acao).toBe('normalizou');
    if (d.acao !== 'normalizou') return;
    expect(d.voltouEm).toBe(m(9, 14, 2));
    expect(d.novo.problema).toBeNull();
    expect(decidir(aberto, { ...CONEXAO_OK, estavel: false }, agora).acao).toBe('nada');
  });

  it('instável respeita a pausa de 2 h entre avisos', () => {
    const instavel: SinaisConexao = { ...CONEXAO_OK, estavel: false, quedas: 4, voltouEm: agora };
    expect(decidir({ ...VISTO, instavelEm: agora - 60 * MIN }, instavel, agora).acao).toBe('nada');
    expect(decidir({ ...VISTO, instavelEm: agora - 3 * 60 * MIN }, instavel, agora).acao).toBe('avisar');
    expect(decidir(VISTO, { ...instavel, quedas: 2 }, agora).acao).toBe('nada');
  });

  it('instável que piora para desconectado avisa de novo; o episódio guarda o começo', () => {
    const aberto: EstadoVigia = {
      ...VISTO,
      problema: 'instavel',
      desde: m(9, 13, 0),
      avisadoEm: m(9, 13, 0),
      instavelEm: m(9, 13, 0),
      dia: '2026-11-09',
      avisosNoDia: 1,
    };
    const d = decidir(aberto, desconectado, agora);
    expect(d.acao).toBe('avisar');
    if (d.acao !== 'avisar') return;
    expect(d.problema).toBe('desconectado');
    expect(d.desde).toBe(m(9, 13, 45));
    expect(d.novo).toMatchObject({ desde: m(9, 13, 0), avisosNoDia: 2 });
  });

  it('teto de avisos por dia; zera no dia seguinte', () => {
    const cheio: EstadoVigia = { ...VISTO, dia: '2026-11-09', avisosNoDia: TETO_AVISOS_DIA };
    expect(decidir(cheio, desconectado, agora).acao).toBe('nada');
    expect(decidir({ ...cheio, dia: '2026-11-08' }, desconectado, agora).acao).toBe('avisar');
  });

  it('episódio de mais de 24 h é reavaliado do zero', () => {
    const velho: EstadoVigia = { ...VISTO, problema: 'desconectado', desde: agora - 30 * 60 * MIN, avisadoEm: agora - VALIDADE_EPISODIO_MS - MIN };
    // Ainda caído: avisa de novo. Normal: não manda "normalizado" de um episódio de ontem.
    expect(decidir(velho, desconectado, agora).acao).toBe('avisar');
    expect(decidir(velho, CONEXAO_OK, agora).acao).toBe('nada');
  });

  it('depois de um aviso que ninguém recebeu, espera 10 min para tentar de novo', () => {
    const falhou: EstadoVigia = { ...VISTO, falhasEnvio: 1, envioFalhouEm: agora - 5 * MIN };
    expect(decidir(falhou, desconectado, agora).acao).toBe('nada');
    const d = decidir(falhou, desconectado, agora + ESPERA_REENVIO_MS);
    expect(d.acao).toBe('avisar');
    if (d.acao === 'avisar') expect(d.novo).toMatchObject({ falhasEnvio: 0, envioFalhouEm: null });
  });

  it('sem receber: só com o chip conectado; fecha quando chega mensagem nova', () => {
    const silencio = { porHora: 24, ultima: m(9, 12, 0), silencioMin: 120, limiteMin: 120, semReceber: true };
    expect(decidir(VISTO, { ...CONEXAO_OK, agoraOk: false, estavel: false }, agora, silencio).acao).toBe('nada');
    const d = decidir({ ...ESTADO_INICIAL }, CONEXAO_OK, agora, silencio);
    expect(d.acao).toBe('avisar');
    if (d.acao !== 'avisar') return;
    expect(d.problema).toBe('sem_receber');
    expect(d.desde).toBe(m(9, 12, 0));
    expect(d.novo.vistoOpen).toBe(true);
    expect(decidir(d.novo, CONEXAO_OK, agora + 5 * MIN, null, m(9, 12, 0)).acao).toBe('nada');
    const fim = decidir(d.novo, CONEXAO_OK, agora + 5 * MIN, null, m(9, 14, 3));
    expect(fim.acao).toBe('normalizou');
    if (fim.acao === 'normalizou') expect(fim.voltouEm).toBe(m(9, 14, 3));
  });
});

describe('aviso que ninguém recebeu', () => {
  it('volta ao estado de antes para tentar de novo; desiste na 3ª', () => {
    const antes: EstadoVigia = { ...VISTO };
    const novo: EstadoVigia = { ...VISTO, problema: 'desconectado', desde: 1, avisadoEm: 2, dia: '2026-11-09', avisosNoDia: 1 };
    const t1 = estadoAposFalhaDeEnvio(antes, novo, 100);
    expect(t1).toMatchObject({ problema: null, avisosNoDia: 0, falhasEnvio: 1, envioFalhouEm: 100 });
    const t2 = estadoAposFalhaDeEnvio(t1, novo, 200);
    expect(t2).toMatchObject({ problema: null, falhasEnvio: 2, envioFalhouEm: 200 });
    expect(TENTATIVAS_ENVIO).toBe(3);
    expect(estadoAposFalhaDeEnvio(t2, novo, 300)).toEqual({ ...novo, falhasEnvio: 0, envioFalhouEm: null });
  });
});

describe('estado gravado', () => {
  it('lê valor quebrado ou velho como chip normal', () => {
    expect(lerEstado(null)).toEqual(ESTADO_INICIAL);
    expect(lerEstado('{oops')).toEqual(ESTADO_INICIAL);
    expect(lerEstado(JSON.stringify({ problema: 'xpto', avisosNoDia: 'a' }))).toEqual(ESTADO_INICIAL);
    const e: EstadoVigia = {
      problema: 'instavel',
      desde: 1,
      avisadoEm: 2,
      instavelEm: 2,
      dia: '2026-11-09',
      avisosNoDia: 1,
      vistoOpen: true,
      falhasEnvio: 1,
      envioFalhouEm: 3,
    };
    expect(lerEstado(JSON.stringify(e))).toEqual(e);
  });
});

describe('textos', () => {
  const clinica = { purpose: 'CLINICA', ownerJid: '558299273423@s.whatsapp.net' };

  it('número do chip', () => {
    expect(numeroDoChip('558299273423@s.whatsapp.net')).toBe('(82) 9927-3423');
    expect(numeroDoChip('5582999273423:12@s.whatsapp.net')).toBe('(82) 99927-3423');
    expect(numeroDoChip(null)).toBe('');
    expect(numeroDoChip('123')).toBe('');
  });

  it('duração', () => {
    expect(duracao(45 * MIN)).toBe('45 min');
    expect(duracao(120 * MIN)).toBe('2h');
    expect(duracao(150 * MIN)).toBe('2h30');
  });

  it('desconectado diz o chip, desde quando e como reconectar', () => {
    const t = textoDoProblema('desconectado', clinica, m(9, 14, 5), m(9, 14, 15));
    expect(t).toContain('*WhatsApp desconectado*');
    expect(t).toContain('*Clínica* (82) 9927-3423');
    expect(t).toContain('desde as 14:05');
    expect(t).toContain('*Conectar*');
    expect(textoDoProblema('desconectado', clinica, m(8, 18, 40), m(9, 8, 0))).toContain('desde ontem, às 18:40');
    expect(textoDoProblema('desconectado', clinica, m(9, 14, 5), m(9, 14, 15), { desdeExato: false })).toContain(
      'está desconectado há pelo menos 10 minutos',
    );
  });

  it('instável e sem receber', () => {
    expect(textoDoProblema('instavel', clinica, 0, m(9, 14, 0), { quedas: 5 })).toContain('caiu e voltou 5 vezes');
    const s = textoDoProblema('sem_receber', clinica, m(9, 12, 0), m(9, 14, 0), { porHora: 23.6 });
    expect(s).toContain('desde as 12:00');
    expect(s).toContain('umas 24 por hora');
  });

  it('normalizado diz quando voltou e quanto tempo ficou com problema', () => {
    const t = textoNormalizado('desconectado', clinica, m(9, 14, 5), m(9, 16, 48));
    expect(t).toContain('voltou ao normal às 16:48, depois de 2h43 com problema');
    expect(textoNormalizado('sem_receber', clinica, m(9, 12, 0), m(9, 14, 3))).toContain('voltou a receber mensagens às 14:03');
  });
});

describe('ordem dos chips do aviso', () => {
  it('o chip com problema vai por último; sem a opção, a ordem não muda', () => {
    expect(ordenarChipsDoAviso(['fin', 'cli', 'com'], ['fin'])).toEqual(['cli', 'com', 'fin']);
    expect(ordenarChipsDoAviso(['fin', 'cli'], null)).toEqual(['fin', 'cli']);
    expect(ordenarChipsDoAviso(['fin'], ['fin'])).toEqual(['fin']);
  });
});
