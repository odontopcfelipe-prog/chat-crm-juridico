/**
 * Texto GLOBAL da IA adaptado à clínica da conversa.
 *
 * As skills (PromptSkill), as referências (SkillAsset) e o modelo de venda do guia
 * são do produto, iguais para todas as clínicas, mas foram escritos para o Instituto
 * Odonto Passos: citam o nome dele ("Aqui é a Sophia do Instituto Odonto Passos"),
 * os valores dele (avaliação R$ 150, limpeza R$ 350) e a avaliadora dele. Em outra
 * clínica a IA copiava esses dados, mesmo com a regra de identidade no fim do prompt.
 *
 * Aqui o texto é adaptado ANTES de entrar no prompt (antes das {{variáveis}}, então
 * os dados da própria clínica — tabela de valores, endereço — não são tocados):
 *   - nome do Instituto → nome desta clínica, com a preposição concordando;
 *   - a avaliadora do Instituto (Dra. Suellen) → a avaliadora desta clínica;
 *   - valor em R$ / "350 reais" → aviso para usar só a orientação de VALORES da clínica;
 *   - telefone e link/@ do Instituto → aviso para usar só os DADOS DA CLÍNICA.
 * No próprio Instituto (ou conversa legada sem clínica, que é dele) o texto passa intacto.
 */

/** O Instituto Odonto Passos: a clínica para a qual o texto global foi escrito. */
export const TENANT_DO_TEXTO_GLOBAL = '00000000-0000-0000-0000-000000000000';

export interface ClinicaDoTextoGlobal {
  tenantId: string | null | undefined;
  /** Tenant.name ('' se não cadastrado). */
  firmName: string | null | undefined;
  /** Dentista avaliador(a) desta clínica (orçamentista resolvido), se houver. */
  doctorName?: string | null;
}

const VALOR = 'R$ [valor da orientação de VALORES]';
const VALOR_SEM_RS = '[valor da orientação de VALORES]';
const TELEFONE = '[telefone: use só o dos DADOS DA CLÍNICA]';
const LINK = '[link/@ de outra clínica: não informe]';

/** Primeira palavra de nome masculino ("do Instituto X", "no Consultório Y"). */
const MASCULINOS = new Set([
  'instituto', 'consultorio', 'centro', 'espaco', 'estudio', 'studio', 'grupo', 'nucleo',
  'complexo', 'hospital', 'ambulatorio', 'laboratorio', 'sorriso', 'odontocentro',
]);

function semAcento(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function nomeMasculino(nome: string): boolean {
  const primeira = semAcento(nome).toLowerCase().trim().split(/\s+/)[0] || '';
  return MASCULINOS.has(primeira);
}

function mesmaCaixa(modelo: string, palavra: string): string {
  return modelo[0] === modelo[0].toUpperCase() ? palavra[0].toUpperCase() + palavra.slice(1) : palavra;
}

/** O texto global é desta clínica (o Instituto)? Então não adapta nada. */
export function textoGlobalEhDaClinica(c: ClinicaDoTextoGlobal): boolean {
  if (!c.tenantId || c.tenantId === TENANT_DO_TEXTO_GLOBAL) return true;
  return /odonto\s*passos/i.test(c.firmName || '');
}

/**
 * Devolve a função que adapta um texto global (skill, referência, guia) à clínica.
 * No Instituto é a identidade.
 */
export function adaptadorDoTextoGlobal(c: ClinicaDoTextoGlobal): (texto: string) => string {
  if (textoGlobalEhDaClinica(c)) return (t) => t;

  const nome = String(c.firmName || '').trim() || 'nossa clínica';
  const masc = nomeMasculino(nome);
  const prep: Record<string, string> = masc
    ? { do: 'do', no: 'no', pelo: 'pelo', ao: 'ao', o: 'o' }
    : { do: 'da', no: 'na', pelo: 'pela', ao: 'à', o: 'a' };
  const doutor = String(c.doctorName || '').trim();
  // Sem avaliador(a) definido: "com a Dra. Suellen" → "com a dentista avaliadora".
  const avaliadora = doutor || 'dentista avaliadora';

  return (texto: string): string => {
    if (!texto) return texto;
    return (
      texto
        // "do Instituto Odonto Passos" → "da Clínica X" (preposição concorda com o nome novo)
        .replace(/(\b(?:do|no|pelo|ao|o)\s+)?Instituto\s+Odonto\s+Passos\b/gi, (_m, p?: string) => {
          if (!p) return nome;
          const original = p.trim();
          return `${mesmaCaixa(original, prep[original.toLowerCase()] ?? original)} ${nome}`;
        })
        .replace(/\b(?:Instituto\s+Passos|Odonto\s+Passos)\b/gi, nome)
        // Avaliadora do Instituto → a desta clínica
        .replace(/\bDra?\.?\s+Suellen(?:\s+Passos)?\b/gi, avaliadora)
        // Site, e-mail e @ do Instituto
        .replace(/\S*odontopassos\S*/gi, LINK)
        // Telefone com DDD: (82) 99999-9999, 82 3333-4444, +55 82 9 9999-9999
        .replace(/(?:\+?55\s?)?\(?\b[1-9]{2}\)?\s?9?\s?\d{4}[-\s]\d{4}\b/g, TELEFONE)
        // Valores: "R$ 150", "R$150,00", "R$ 1.200" (o "R$ 1.234,56" é só exemplo de formato)
        .replace(/R\$\s?\d+(?:\.\d{3})*(?:,\d{2})?/g, (m) => (/1\.234,56/.test(m) ? m : VALOR))
        // "350 reais", "350,00 reais"
        .replace(/\b\d+(?:\.\d{3})*(?:,\d{2})?\s+reais\b/gi, VALOR_SEM_RS)
    );
  };
}
