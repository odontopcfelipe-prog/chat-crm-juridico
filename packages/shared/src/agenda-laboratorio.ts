/**
 * F7 do laboratório — tipos da agenda e regras puras da agenda do laboratório
 * (coleta, prova e entrega no consultório do cliente). API, worker e web importam
 * daqui; os textos ficam em lab-agenda-textos.ts.
 *
 * COLETA, PROVA e ENTREGA são tipos SÓ do laboratório: ficam fora de toda lista de
 * tipos de atendimento da clínica (TIPOS_CLINICOS e as cópias), então nenhum
 * automatismo de paciente (pesquisa, lista de espera, retorno, comissão, promoção,
 * última visita, validação) os enxerga. A clínica continua recusando estes tipos com
 * a mesma resposta de antes.
 *
 * Agenda naive-UTC: start_at guarda a hora de Maceió gravada como UTC, então data e
 * hora saem por getUTC* (nunca toLocale*).
 *
 * Módulo puro (sem Prisma, sem Nest).
 */
import { formatTenantAddress, type TenantAddressParts } from './address.util';
import {
  applyTemplate,
  DEFAULT_BIRTHDAY_GREETING,
  DEFAULT_DENTIST_DAILY_SUMMARY,
  type BirthdayGreetingConfig,
  type DentistDailySummaryConfig,
  type ReminderConfig,
} from './reminder-config';
import { LAB_AGENDA_TEXTOS, LAB_AGENDA_TIPO, LAB_AGENDA_TIPO_FRASE } from './lab-agenda-textos';

/**
 * Tipos de evento da clínica, na MESMA ordem de calendar.dto.ts e do EVENT_TYPES de
 * calendar.service.ts (a mensagem do 400 da clínica lista nesta ordem).
 */
export const TIPOS_DE_AGENDA_DA_CLINICA: readonly string[] = Object.freeze([
  'CONSULTA',
  'PROCEDIMENTO',
  'RETORNO',
  'ORTODONTIA',
  'BLOQUEIO',
  'TAREFA',
  'OUTRO',
  'AUDIENCIA',
  'PERICIA',
  'PRAZO',
]);

/** Tipos que só existem na agenda do laboratório. */
export type TipoDoLaboratorio = 'COLETA' | 'PROVA' | 'ENTREGA';

export const TIPOS_SO_DO_LABORATORIO: readonly TipoDoLaboratorio[] = Object.freeze(['COLETA', 'PROVA', 'ENTREGA'] as TipoDoLaboratorio[]);

/** Tipos que avisam o cliente (aviso na hora, remarcação, confirmação e lembretes). */
export const TIPOS_AVISO_LAB: readonly TipoDoLaboratorio[] = TIPOS_SO_DO_LABORATORIO;

/**
 * Tipos que a agenda do laboratório aceita. Os outros (consulta, procedimento,
 * retorno, ortodontia, audiência, perícia, prazo) são de clínica: a agenda recusa no
 * laboratório e a vigia diária conta se aparecer algum.
 */
export const TIPOS_DE_AGENDA_DO_LABORATORIO: readonly string[] = Object.freeze(['TAREFA', 'OUTRO', 'BLOQUEIO', ...TIPOS_SO_DO_LABORATORIO]);

/** Tudo o que a validação do corpo aceita (a conta decide depois). */
export const TODOS_OS_TIPOS_DE_AGENDA: readonly string[] = Object.freeze([...TIPOS_DE_AGENDA_DA_CLINICA, ...TIPOS_SO_DO_LABORATORIO]);

/** Antecedências (minutos) dos lembretes do laboratório pelo WhatsApp: 48 h e 24 h. */
export const ANTECEDENCIAS_DO_LABORATORIO: readonly number[] = Object.freeze([2880, 1440]);

/** É COLETA, PROVA ou ENTREGA? */
export function tipoSoDoLaboratorio(tipo: unknown): tipo is TipoDoLaboratorio {
  return typeof tipo === 'string' && (TIPOS_SO_DO_LABORATORIO as readonly string[]).includes(tipo);
}

/**
 * Filtro dos lembretes de um evento do laboratório. Sem canal, vale o `padrao`.
 * PUSH (lembrete da equipe) passa sempre; WHATSAPP só com 48 h ou 24 h; EMAIL e
 * qualquer outro canal ficam fora.
 */
export function lembreteDoLaboratorio(
  padrao: 'PUSH' | 'WHATSAPP',
): (r: { minutes_before: number; channel?: string | null }) => boolean {
  return (r) => {
    const canal = r?.channel ?? padrao;
    if (canal === 'PUSH') return true;
    if (canal === 'WHATSAPP') return ANTECEDENCIAS_DO_LABORATORIO.includes(Number(r?.minutes_before));
    return false;
  };
}

// Dr, Dr., Dra, Dra., Drª, Doutor e Doutora no começo do nome (seguidos de ponto ou espaço).
const TITULO_NO_COMECO = /^(?:doutora|doutor|drª|dra|dr)(?:\.\s*|\s+)/iu;

/** Primeiro nome sem o título (Dr./Dra./Doutor(a)); '' quando não há nome. */
export function primeiroNomeSemTitulo(nome: string | null | undefined): string {
  const limpo = String(nome ?? '').trim().replace(TITULO_NO_COMECO, '').trim();
  return limpo.split(/\s+/)[0] || '';
}

const doisDigitos = (n: number) => String(n).padStart(2, '0');

function dataValida(d: Date | string | null | undefined): Date | null {
  if (d === null || d === undefined || d === '') return null;
  const data = d instanceof Date ? d : new Date(d);
  return Number.isNaN(data.getTime()) ? null : data;
}

/** 'DD/MM' da agenda naive-UTC; '' quando a data é inválida. */
export function dataCurtaNaive(d: Date | string | null | undefined): string {
  const data = dataValida(d);
  return data ? `${doisDigitos(data.getUTCDate())}/${doisDigitos(data.getUTCMonth() + 1)}` : '';
}

/** 'HH:MM' da agenda naive-UTC; '' quando a data é inválida. */
export function horaCurtaNaive(d: Date | string | null | undefined): string {
  const data = dataValida(d);
  return data ? `${doisDigitos(data.getUTCHours())}:${doisDigitos(data.getUTCMinutes())}` : '';
}

/**
 * Endereço da visita: o local digitado no evento ou, sem ele, o endereço do cadastro
 * do cliente (o Patient tem os mesmos campos do endereço da conta). Nunca o endereço
 * do laboratório. '' quando não há nenhum (a linha {local_line} some).
 */
export function enderecoDoCliente(local: string | null | undefined, cadastro: TenantAddressParts | null | undefined): string {
  return String(local ?? '').trim() || formatTenantAddress(cadastro);
}

/** 'Coleta' / 'Prova' / 'Entrega'; outro tipo volta como veio. */
export function rotuloTipoDoLaboratorio(tipo: string | null | undefined): string {
  const t = String(tipo ?? '');
  return Object.prototype.hasOwnProperty.call(LAB_AGENDA_TIPO, t) ? LAB_AGENDA_TIPO[t as TipoDoLaboratorio] : t;
}

/** 'coleta' / 'prova' / 'entrega'; '' para outro tipo. */
function fraseDoTipo(tipo: string | null | undefined): string {
  const t = String(tipo ?? '');
  return Object.prototype.hasOwnProperty.call(LAB_AGENDA_TIPO_FRASE, t) ? LAB_AGENDA_TIPO_FRASE[t as TipoDoLaboratorio] : '';
}

export interface DadosTextoDoLaboratorio {
  /** Nome do cadastro do cliente (dentista ou consultório). */
  nomeDoCliente?: string | null;
  /** COLETA, PROVA ou ENTREGA. */
  tipo?: string | null;
  /** start_at do evento (naive-UTC). */
  inicio?: Date | string | null;
  /** Endereço da visita (enderecoDoCliente). */
  local?: string | null;
  /** Nome da conta do laboratório. */
  laboratorio?: string | null;
  /** Responsável pela visita. */
  protetico?: string | null;
}

/**
 * Monta a mensagem do laboratório: troca {tipo} e {protetico} e passa o resto ao
 * applyTemplate (o mesmo da clínica, sem mudança). {nome} é o primeiro nome sem
 * Dr./Dra.; {nome_completo}, {dentista} e {dentista_completo} são o nome do cadastro;
 * {data} é DD/MM e {hora} é HH:MM; {clinica} é o nome do laboratório; {local_line}
 * é a linha do endereço (some sem endereço).
 */
export function aplicarTextoDoLaboratorio(tpl: string, d: DadosTextoDoLaboratorio): string {
  const n = String(d.nomeDoCliente ?? '').trim();
  const frase = fraseDoTipo(d.tipo);
  const protetico = String(d.protetico ?? '').trim();
  const comTipo = String(tpl ?? '')
    .replace(/\{tipo\}/g, () => frase)
    .replace(/\{protetico\}/g, () => protetico);
  return applyTemplate(comTipo, {
    nome: primeiroNomeSemTitulo(n) || LAB_AGENDA_TEXTOS.nomePadrao,
    nome_completo: n,
    dentista: n,
    dentista_completo: n,
    data: dataCurtaNaive(d.inicio),
    hora: horaCurtaNaive(d.inicio),
    local: String(d.local ?? '').trim(),
    clinica: String(d.laboratorio ?? '').trim() || LAB_AGENDA_TEXTOS.laboratorioSemNome,
  });
}

/** Chave do texto do lembrete do laboratório: 48 h (ou mais) e 24 h. */
export function chaveDoLembreteDoLaboratorio(min: number): 'consulta_confirmacao' | 'consulta_24h' {
  return min >= 2880 ? 'consulta_confirmacao' : 'consulta_24h';
}

/** Lembretes do laboratório: ligados, só 48 h e 24 h pelo WhatsApp, com os textos do laboratório. */
export const REMINDER_CONFIG_PADRAO_DO_LABORATORIO: ReminderConfig = {
  enabled: true,
  default_antecedencias: [
    { minutes_before: 2880, channel: 'WHATSAPP' },
    { minutes_before: 1440, channel: 'WHATSAPP' },
  ],
  templates: {
    consulta_confirmacao: LAB_AGENDA_TEXTOS.lembrete48h,
    consulta_24h: LAB_AGENDA_TEXTOS.lembrete24h,
    consulta_1h: '',
    consulta_15min: '',
  },
};

/** Resumo do dia de quem tem coleta, prova ou entrega (desligado até a conta ligar). */
export const DENTIST_DAILY_SUMMARY_PADRAO_DO_LABORATORIO: DentistDailySummaryConfig = {
  ...DEFAULT_DENTIST_DAILY_SUMMARY,
  template: LAB_AGENDA_TEXTOS.resumoProtetico,
};

/** Aniversário do cliente: só a mensagem clássica, com o texto do laboratório (desligado). */
export const BIRTHDAY_GREETING_PADRAO_DO_LABORATORIO: BirthdayGreetingConfig = {
  ...DEFAULT_BIRTHDAY_GREETING,
  template: LAB_AGENDA_TEXTOS.aniversario,
  message2_enabled: false,
  message2_template: '',
  message3_enabled: false,
  message3_template: '',
};

/** Dados do aviso aos administradores de novo agendamento (LAB_NOVO_AGENDAMENTO.montar). */
export interface DadosNovoAgendamentoDoLaboratorio {
  nome?: string | null;
  telefone?: string | null;
  /** Ex.: "segunda-feira 13/10 às 14:30" (pronto de quem chama). */
  quando: string;
  /** Rótulo do tipo (rotuloTipoDoLaboratorio). */
  tipo: string;
  protetico?: string | null;
  marcadoPor?: string | null;
  /** Rótulo da repetição (ex.: "semanal"); vazio = não repete. */
  repete?: string | null;
}
