// Campanha MANUAL (Central de Disparos › "Campanha manual" em cada setor) — regras puras.
//
// O ADM escolhe o setor (= o chip que envia), filtra os pacientes, escreve o texto e anexa
// fotos/áudio; manda agora ou agenda. O envio segue as MESMAS travas dos disparos
// automáticos (marca-passo por chip 3–7 min, horário, feriado, opt-out). Fonte única pra
// API (motor + endpoints) e web (tela). Sem banco.

export const CAMPANHA_SETORES = ['CLINICA', 'COMERCIAL', 'FINANCEIRO'] as const;
export type CampanhaSetor = (typeof CAMPANHA_SETORES)[number];

export const CAMPANHA_SETOR_LABEL: Record<CampanhaSetor, string> = {
  CLINICA: 'Clínica',
  COMERCIAL: 'Comercial',
  FINANCEIRO: 'Financeiro',
};

export function isCampanhaSetor(v: unknown): v is CampanhaSetor {
  return typeof v === 'string' && (CAMPANHA_SETORES as readonly string[]).includes(v);
}

export const CAMPANHA_STATUS = ['RASCUNHO', 'AGENDADA', 'ENVIANDO', 'PAUSADA', 'CONCLUIDA', 'CANCELADA'] as const;
export type CampanhaStatus = (typeof CAMPANHA_STATUS)[number];

export const CAMPANHA_STATUS_LABEL: Record<CampanhaStatus, string> = {
  RASCUNHO: 'Rascunho',
  AGENDADA: 'Agendada',
  ENVIANDO: 'Enviando',
  PAUSADA: 'Pausada',
  CONCLUIDA: 'Concluída',
  CANCELADA: 'Cancelada',
};

export type CampanhaItemStatus = 'PENDENTE' | 'ENVIANDO' | 'ENVIADO' | 'FALHOU' | 'PULADO';

/** Limites (o WhatsApp aceita mais; aqui é o que cabe bem num disparo em massa). */
export const CAMPANHA_MAX_MIDIAS = 3;
export const CAMPANHA_MAX_DESTINATARIOS = 1000;
export const CAMPANHA_MAX_TEXTO = 1500;
/** Legenda de foto: até isso o texto vai junto da 1ª foto (1 bolha só); acima, sai antes. */
export const CAMPANHA_MAX_LEGENDA = 1000;
export const CAMPANHA_TETO_DIA = 120; // envios de campanha por clínica por dia
export const CAMPANHA_HORA_INICIO = 9; // 9:00 Maceió
export const CAMPANHA_HORA_FIM = 18; // até 17:59

export type CampanhaMidiaTipo = 'image' | 'audio';

export const CAMPANHA_MIDIA_LIMITE_BYTES: Record<CampanhaMidiaTipo, number> = {
  image: 5 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
};

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const AUDIO_MIME_RE = /^audio\/(mpeg|mp3|ogg|opus|mp4|m4a|x-m4a|aac|wav|x-wav|webm)$/;

/** Tipo do anexo pelo MIME (null = não aceito). Vídeo/documento ficam de fora de propósito. */
export function campanhaMidiaTipo(mime: string | null | undefined): CampanhaMidiaTipo | null {
  const m = (mime || '').toLowerCase().split(';')[0].trim();
  if (IMAGE_MIMES.includes(m)) return 'image';
  if (AUDIO_MIME_RE.test(m) || m === 'video/webm') return 'audio'; // gravação do navegador sai como video/webm
  return null;
}

export const CAMPANHA_VARIAVEIS: { key: string; desc: string }[] = [
  { key: 'nome', desc: 'Primeiro nome do paciente' },
  { key: 'nome_completo', desc: 'Nome completo do paciente' },
  { key: 'clinica', desc: 'Nome da clínica' },
];

/** Troca as {variáveis}; desconhecida vira vazio; não deixa 3+ quebras seguidas. */
export function renderCampanhaTexto(tpl: string, vars: Record<string, string>): string {
  return (tpl || '')
    .replace(/\{(\w+)\}/g, (_m, k) => vars[k] ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Filtros do público (pacientes). Arquivados nunca entram. */
export interface CampanhaFiltros {
  /** Tem QUALQUER uma destas tags. */
  tagIds?: string[];
  /** ACTIVE = atendido nos últimos 12 meses · INACTIVE = há mais de 12 · vazio = todos. */
  atividade?: 'ACTIVE' | 'INACTIVE' | null;
  /** Sem visita há pelo menos N meses (ou nunca veio). */
  semVisitaMeses?: number | null;
  dentistaId?: string | null;
  comTratamentoAtivo?: boolean;
  aniversariantesDoMes?: boolean;
}

/** Normaliza o que vem da tela (ignora lixo, limita valores). */
export function normalizarFiltros(f: any): CampanhaFiltros {
  const out: CampanhaFiltros = {};
  if (Array.isArray(f?.tagIds)) out.tagIds = f.tagIds.filter((x: unknown) => typeof x === 'string' && x).slice(0, 20);
  if (f?.atividade === 'ACTIVE' || f?.atividade === 'INACTIVE') out.atividade = f.atividade;
  const m = Number(f?.semVisitaMeses);
  if (Number.isFinite(m) && m >= 1) out.semVisitaMeses = Math.min(120, Math.floor(m));
  if (typeof f?.dentistaId === 'string' && f.dentistaId) out.dentistaId = f.dentistaId;
  if (f?.comTratamentoAtivo === true) out.comTratamentoAtivo = true;
  if (f?.aniversariantesDoMes === true) out.aniversariantesDoMes = true;
  return out;
}

export type PassoEnvio =
  | { tipo: 'texto'; texto: string }
  | { tipo: 'image'; midiaId: string; legenda?: string }
  | { tipo: 'audio'; midiaId: string };

/**
 * Ordem das bolhas pra UM paciente:
 *  - com foto e texto curto → a 1ª foto leva o texto como legenda (1 bolha), depois as
 *    outras fotos, depois os áudios;
 *  - texto longo (ou sem foto) → texto primeiro, depois fotos, depois áudios.
 * Áudio sai como mensagem de voz (não tem legenda) — por isso fica por último, depois
 * do texto que dá o contexto.
 */
export function planejarEnvio(
  texto: string,
  midias: { id: string; tipo: CampanhaMidiaTipo; posicao?: number }[],
): PassoEnvio[] {
  const ord = [...midias].sort((a, b) => (a.posicao ?? 0) - (b.posicao ?? 0));
  const imagens = ord.filter((m) => m.tipo === 'image');
  const audios = ord.filter((m) => m.tipo === 'audio');
  const t = (texto || '').trim();
  const passos: PassoEnvio[] = [];
  const legendaNaFoto = !!t && imagens.length > 0 && t.length <= CAMPANHA_MAX_LEGENDA;
  if (t && !legendaNaFoto) passos.push({ tipo: 'texto', texto: t });
  imagens.forEach((m, i) => passos.push({ tipo: 'image', midiaId: m.id, ...(i === 0 && legendaNaFoto ? { legenda: t } : {}) }));
  audios.forEach((m) => passos.push({ tipo: 'audio', midiaId: m.id }));
  return passos;
}

/** Quanto tempo leva no ritmo seguro (3–7 min, ~5 em média; janela 9h–18h seg–sáb). */
export function estimativaCampanha(destinatarios: number): string {
  if (destinatarios <= 0) return '—';
  const porDia = Math.floor(((CAMPANHA_HORA_FIM - CAMPANHA_HORA_INICIO) * 60) / 5);
  const dias = Math.ceil(destinatarios / Math.min(porDia, CAMPANHA_TETO_DIA));
  if (dias <= 1) {
    const horas = Math.ceil((destinatarios * 5) / 60);
    return horas <= 1 ? 'cerca de 1 hora' : `cerca de ${horas} horas`;
  }
  return `cerca de ${dias} dias úteis`;
}
