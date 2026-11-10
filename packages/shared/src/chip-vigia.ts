/**
 * Vigia dos chips de WhatsApp (nov/2026): avisa os ADMs quando um chip da clínica fica
 * desconectado, instável ou "conectado mas sem receber", e de novo quando normaliza.
 *
 * O motor fica no worker (admin-alerts/chip-vigia.service). A API só liga e desliga o
 * aviso na Central de Disparos (followup.service). As duas pontas leem as mesmas chaves
 * daqui, para não divergirem.
 */

/** Id do aviso no catálogo DISPAROS_EQUIPE e do card na Central de Disparos. */
export const CHIP_VIGIA_DISPARO = 'chip_whatsapp';

/** DispatchLog.type dos avisos da vigia (histórico da Central). */
export const CHIP_VIGIA_DISPATCH_TYPE = 'chip_whatsapp';

/** Chave do liga/desliga por clínica (GlobalSetting). */
export function chipVigiaToggleKey(tenantId: string): string {
  return `CHIP_VIGIA_ENABLED_${tenantId}`;
}

/** Padrão LIGADO: só o valor 'false' desliga. */
export function chipVigiaLigada(valor: string | null | undefined): boolean {
  return valor !== 'false';
}

/** Chave do estado de cada chip (GlobalSetting), que evita aviso repetido entre réplicas. */
export function chipVigiaEstadoKey(chip: string): string {
  return `CHIP_VIGIA_ESTADO_${chip}`;
}

// ─── Situação do chip na tela (aviso no topo e na barra de envio) ─────────────

/** Problema que a vigia (worker) registrou para o chip. */
export type ProblemaDaVigia = 'desconectado' | 'instavel' | 'sem_receber';

/** Episódio da vigia com mais que isto é velho (mesma validade do worker). */
const VALIDADE_EPISODIO_MS = 24 * 60 * 60_000;

/**
 * Lê o estado gravado pela vigia (CHIP_VIGIA_ESTADO_<chip>) só no que a tela precisa:
 * o problema aberto e desde quando. null = sem episódio aberto (ou valor quebrado/velho).
 */
export function problemaDaVigia(
  valor: string | null | undefined,
  agora: number = Date.now(),
): { problema: ProblemaDaVigia; desde: number | null } | null {
  if (!valor) return null;
  try {
    const v = JSON.parse(valor);
    const problema = v?.problema;
    if (problema !== 'desconectado' && problema !== 'instavel' && problema !== 'sem_receber') return null;
    const avisadoEm = typeof v?.avisadoEm === 'number' ? v.avisadoEm : null;
    if (avisadoEm !== null && agora - avisadoEm > VALIDADE_EPISODIO_MS) return null;
    return { problema, desde: typeof v?.desde === 'number' ? v.desde : null };
  } catch {
    return null;
  }
}

/**
 * Situação de um chip para a tela:
 *   - desconectado: o servidor do WhatsApp diz "close";
 *   - reconectando: o servidor diz "connecting" (sem conexão, tentando voltar);
 *   - instavel: conectado agora, mas a vigia viu cair e voltar várias vezes (conexão baixa);
 *   - sem_receber: conectado, mas a vigia viu ficar horas sem receber mensagem;
 *   - ok: conectado e sem episódio aberto;
 *   - desconhecido: o servidor não respondeu (a tela não alarma).
 */
export type SituacaoChip = 'ok' | 'desconectado' | 'reconectando' | 'instavel' | 'sem_receber' | 'desconhecido';

export function situacaoDoChip(
  estadoAoVivo: string | null | undefined,
  vigia: { problema: ProblemaDaVigia } | null | undefined,
): SituacaoChip {
  const s = String(estadoAoVivo || '').trim().toLowerCase();
  if (!s || s === 'unknown') return 'desconhecido';
  if (s === 'connecting') return 'reconectando';
  if (s !== 'open') return 'desconectado';
  if (vigia?.problema === 'instavel') return 'instavel';
  if (vigia?.problema === 'sem_receber') return 'sem_receber';
  return 'ok';
}

/** Situação de um chip como a API devolve em GET /whatsapp/situacao-chips. */
export interface SituacaoDoChip {
  instanceName: string;
  purpose: string | null;
  /** Número do chip (55 + DDD + número), quando o servidor informa. */
  numero: string | null;
  situacao: SituacaoChip;
  /** Desde quando (ms), para "instável" e "sem receber". */
  desde: number | null;
}

/**
 * Chip por onde sai a resposta numa conversa (a mesma regra de resolveDispatchInstance da
 * API): setor Financeiro → chip Financeiro; senão paciente/cliente → Clínica, lead →
 * Comercial. Sem chip dessa função, a conta com um chip só usa esse chip.
 */
export function chipDaConversa<T extends { purpose: string | null }>(
  chips: readonly T[],
  conversa: { inboxPurpose?: string | null; isClient?: boolean | null },
): T | null {
  const funcao = conversa.inboxPurpose === 'FINANCEIRO' ? 'FINANCEIRO' : conversa.isClient ? 'CLINICA' : 'COMERCIAL';
  return chips.find((c) => c.purpose === funcao) ?? (chips.length === 1 ? chips[0] : null);
}
