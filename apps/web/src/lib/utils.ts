import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatPhone(phone: string | null | undefined) {
  if (!phone) return '-';

  // Limpa tudo que não for número
  let cleaned = phone.replace(/\D/g, '');

  // Remove o prefixo 55 se existir
  if (cleaned.startsWith('55') && cleaned.length > 10) {
    cleaned = cleaned.substring(2);
  }

  // Formata DDD + Número (Brasil)
  if (cleaned.length === 11) {
    // Celular com 9 dígitos: (XX) 9 XXXX-XXXX
    return `(${cleaned.substring(0, 2)}) ${cleaned.substring(2, 3)} ${cleaned.substring(3, 7)}-${cleaned.substring(7)}`;
  } else if (cleaned.length === 10) {
    // Armazenado sem nono dígito: exibe como (XX) XXXX-XXXX
    return `(${cleaned.substring(0, 2)}) ${cleaned.substring(2, 6)}-${cleaned.substring(6)}`;
  }

  // Fallback para outros formatos ou internacional sem 55
  return cleaned;
}

/**
 * Formata CPF (000.000.000-00). Aceita string com ou sem mascara, com
 * espacos/letras — limpa antes. Retorna '-' se vazio, ou o input original
 * se nao tem 11 digitos (fallback seguro pra dados legados/corrompidos).
 * Onda 17.7.
 */
export function formatCPF(cpf: string | null | undefined) {
  if (!cpf) return '-';
  const cleaned = String(cpf).replace(/\D/g, '');
  if (cleaned.length !== 11) return cpf; // devolve cru se nao bate
  return `${cleaned.slice(0, 3)}.${cleaned.slice(3, 6)}.${cleaned.slice(6, 9)}-${cleaned.slice(9)}`;
}

/**
 * Formata RG. Padrao brasileiro varia por estado, mas o mais comum eh
 * XX.XXX.XXX-X (9 digitos, ultimo pode ser X). Onda 17.7.
 */
export function formatRG(rg: string | null | undefined) {
  if (!rg) return '-';
  const cleaned = String(rg).replace(/[^\dXx]/g, '');
  if (cleaned.length < 8 || cleaned.length > 10) return rg;
  // Pega o ultimo char como digito verificador, formata o resto
  const dv = cleaned.slice(-1).toUpperCase();
  const body = cleaned.slice(0, -1);
  if (body.length === 8) {
    return `${body.slice(0, 2)}.${body.slice(2, 5)}.${body.slice(5)}-${dv}`;
  }
  if (body.length === 7) {
    return `${body.slice(0, 1)}.${body.slice(1, 4)}.${body.slice(4)}-${dv}`;
  }
  return rg;
}

/**
 * Formata CEP (00000-000). Onda 17.7.
 */
export function formatCEP(cep: string | null | undefined) {
  if (!cep) return '-';
  const cleaned = String(cep).replace(/\D/g, '');
  if (cleaned.length !== 8) return cep;
  return `${cleaned.slice(0, 5)}-${cleaned.slice(5)}`;
}
