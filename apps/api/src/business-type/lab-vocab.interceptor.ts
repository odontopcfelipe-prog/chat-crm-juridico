import { createHash } from 'crypto';
import { CallHandler, ExecutionContext, HttpException, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { isLab } from '@crm/shared';
import { Observable, catchError, map, throwError } from 'rxjs';
import { MENSAGENS_API_CLINICA, MOLDES_API_CLINICA } from './mensagens-api-clinica';
import { LAB_API_MESSAGES, LAB_API_MOLDES } from './lab-api-messages';
import { chaveDoHandler } from './lab-route-policy';

const UMA_HORA_MS = 3600_000;
const LIMITE_DO_REGISTRO = 5000;
const CORTE_DO_LOG = 120;

type ChaveMensagem = keyof typeof MENSAGENS_API_CLINICA;
type ChaveMolde = keyof typeof MOLDES_API_CLINICA;

/** Texto da clínica → texto do laboratório (mensagem inteira igual). */
const EXATAS: ReadonlyMap<string, string> = new Map(
  (Object.keys(MENSAGENS_API_CLINICA) as ChaveMensagem[]).map((k) => [MENSAGENS_API_CLINICA[k], LAB_API_MESSAGES[k]]),
);

type Molde = { re: RegExp; lab: string; ordem: number[] };

/** 'Sua clinica ja tem {1} ("{2}").' → /^Sua clinica ja tem ([\s\S]*?) \("([\s\S]*?)"\)\.$/ */
function compilarMolde(clinica: string, lab: string): Molde {
  const ordem: number[] = [];
  const corpo = clinica
    .split(/(\{\d+\})/)
    .map((parte) => {
      const n = /^\{(\d+)\}$/.exec(parte);
      if (n) {
        ordem.push(Number(n[1]));
        return '([\\s\\S]*?)';
      }
      return parte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return { re: new RegExp(`^${corpo}$`), lab, ordem };
}

const MOLDES: readonly Molde[] = (Object.keys(MOLDES_API_CLINICA) as ChaveMolde[]).map((k) =>
  compilarMolde(MOLDES_API_CLINICA[k], LAB_API_MOLDES[k]),
);

/** Texto do laboratório para uma mensagem; a MESMA string quando não há troca. */
export function trocarTexto(msg: string): string {
  const exata = EXATAS.get(msg);
  if (exata !== undefined) return exata;
  for (const m of MOLDES) {
    const achou = m.re.exec(msg);
    if (!achou) continue;
    const valores = new Map<number, string>();
    m.ordem.forEach((n, i) => {
      const v = achou[i + 1];
      valores.set(n, EXATAS.get(v) ?? v);
    });
    return m.lab.replace(/\{(\d+)\}/g, (todo: string, n: string) => valores.get(Number(n)) ?? todo);
  }
  return msg;
}

/** message string ou string[] (ValidationPipe). Sem troca → a MESMA referência. */
function trocarMensagem(m: unknown): unknown {
  if (typeof m === 'string') return trocarTexto(m);
  if (!Array.isArray(m)) return m;
  let mudou = false;
  const novo = m.map((item: unknown) => {
    if (typeof item !== 'string') return item;
    const t = trocarTexto(item);
    if (t !== item) mudou = true;
    return t;
  });
  return mudou ? novo : m;
}

// Vocabulário de clínica que sobrou numa mensagem (sem acento, minúsculas, palavra
// inteira). "clínica" sozinha passa (o cliente do laboratório pode ser uma clínica);
// "sua/nesta/... clínica" fala da própria conta e não passa.
const PALAVRA_DE_CLINICA =
  /(?<![\p{L}\p{N}])(?:pacientes?|consultas?|prontuarios?|anamneses?|odontogramas?|planos? de tratamentos?|tratamentos? odontologicos?|tcle|procedimentos?|(?:sua|nesta|desta|esta|outra|da) clinica)(?![\p{L}\p{N}])/u;
const FRASES_DO_LABORATORIO = /(?<![\p{L}\p{N}])(?:pacientes? do caso|consultas? de credito)(?![\p{L}\p{N}])/gu;

export function temPalavraDeClinica(texto: string): boolean {
  const t = texto
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(FRASES_DO_LABORATORIO, ' ');
  return PALAVRA_DE_CLINICA.test(t);
}

function ehObjetoPlano(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const CHAVES_DO_CORPO = ['message', 'error'] as const;

/**
 * F4 do laboratório — textos que a API devolve. Na conta de LABORATÓRIO (claim bt
 * do token), troca pelo texto do laboratório:
 *   - a message de HttpException (string ou string[]), mantendo status e code;
 *   - message e error do 1º nível de um corpo de sucesso que é objeto plano.
 * Troca só mensagem inteira: o mapa exato primeiro, depois os moldes ^…$.
 * Mensagem que sobra com palavra de clínica vira log [LAB-VOCAB] (no máximo 1 por
 * handler × mensagem × hora), para entrar no mapa.
 *
 * CLÍNICA: sai na 1ª linha, síncrona, com o MESMO Observable de next.handle() —
 * sem operador rxjs, sem custo. Erro lançado por guard não passa por interceptor.
 * Sem dependência no construtor (não entra em ciclo de DI).
 */
@Injectable()
export class LabVocabInterceptor implements NestInterceptor {
  private readonly logger = new Logger('LabVocabInterceptor');
  private readonly avisados = new Map<string, number>();

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http' || !isLab(context.switchToHttp().getRequest()?.user?.bt)) return next.handle();

    const chave = chaveDoHandler(context.getClass(), context.getHandler());
    return next.handle().pipe(
      map((corpo: unknown) => this.trocarCorpo(corpo, chave, context)),
      catchError((e: unknown) => throwError(() => this.trocarErro(e, chave))),
    );
  }

  /** Só HttpException; o resto volta IGUAL. Sem troca → o MESMO erro. */
  trocarErro(e: unknown, chave: string): unknown {
    if (!(e instanceof HttpException)) return e;
    const r = e.getResponse();
    const atual: unknown = typeof r === 'string' ? r : ehObjetoComMensagem(r) ? r.message : undefined;
    const novo = trocarMensagem(atual);
    if (novo === atual) {
      this.vigiar(chave, e.getStatus(), atual);
      return e;
    }
    const troca = new HttpException(
      typeof r === 'string' ? (novo as string) : { ...(r as Record<string, unknown>), message: novo },
      e.getStatus(),
      { cause: e },
    );
    troca.stack = e.stack;
    return troca;
  }

  /** Só objeto plano, só message/error do 1º nível, cópia rasa. Sem troca → a MESMA referência. */
  trocarCorpo(corpo: unknown, chave: string, context?: ExecutionContext): unknown {
    if (!ehObjetoPlano(corpo)) return corpo;
    let saida: Record<string, unknown> | null = null;
    for (const k of CHAVES_DO_CORPO) {
      if (!Object.prototype.hasOwnProperty.call(corpo, k)) continue;
      const atual = corpo[k];
      const novo = trocarMensagem(atual);
      if (novo === atual) {
        this.vigiar(chave, statusDaResposta(context), atual);
        continue;
      }
      saida ??= { ...corpo };
      saida[k] = novo;
    }
    return saida ?? corpo;
  }

  /** Log [LAB-VOCAB] da mensagem que sobrou com palavra de clínica. Nunca lança. */
  private vigiar(chave: string, status: number | string, m: unknown): void {
    const textos = typeof m === 'string' ? [m] : Array.isArray(m) ? m.filter((x): x is string => typeof x === 'string') : [];
    for (const texto of textos) {
      if (!temPalavraDeClinica(texto)) continue;
      // O texto pode levar nome de pessoa: no log vai só um id curto da mensagem.
      const id = createHash('sha1').update(texto.slice(0, CORTE_DO_LOG)).digest('hex').slice(0, 8);
      const marca = `${chave}|${id}`;
      const agora = Date.now();
      const ultima = this.avisados.get(marca);
      if (ultima !== undefined && agora - ultima < UMA_HORA_MS) continue;
      if (this.avisados.size > LIMITE_DO_REGISTRO) this.avisados.clear();
      this.avisados.set(marca, agora);
      this.logger.warn(`[LAB-VOCAB] ${chave} ${status} mensagem de clínica sem tradução (${texto.length} caracteres, id ${id})`);
    }
  }
}

function ehObjetoComMensagem(r: unknown): r is { message: unknown } {
  return r !== null && typeof r === 'object' && 'message' in r;
}

function statusDaResposta(context?: ExecutionContext): number | string {
  try {
    const s = context?.switchToHttp().getResponse()?.statusCode;
    return typeof s === 'number' ? s : '-';
  } catch {
    return '-';
  }
}
