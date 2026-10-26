/**
 * Pesquisa pós-atendimento (NPS): onde fica a configuração de cada conta.
 *
 * A configuração (liga/desliga, atraso, estilo e textos) é POR CONTA, na
 * GlobalSetting `POST_CARE_CONFIG_<tenantId>` (JSON). A chave sem conta
 * (`POST_CARE_CONFIG`) é a global antiga: só as contas legadas a herdam enquanto
 * não editam a delas (ver conta-legada.ts). A API grava e lê; o worker lê.
 */
import { chaveConfigDaConta } from './conta-legada';

/** Chave global antiga (sem conta) — só leitura de reserva para contas legadas. */
export const POST_CARE_CONFIG_KEY = 'POST_CARE_CONFIG';

/** Prefixo das chaves por conta (`POST_CARE_CONFIG_<tenantId>`). */
export const POST_CARE_CONFIG_PREFIX = `${POST_CARE_CONFIG_KEY}_`;

/** Chave da conta na GlobalSetting. */
export function postCareConfigKey(tenantId: string): string {
  return chaveConfigDaConta(POST_CARE_CONFIG_KEY, tenantId);
}

/**
 * Conta dona de uma chave por conta, ou null se a chave não é `POST_CARE_CONFIG_<id>`
 * com id de verdade (sufixo vazio, 'undefined' ou 'null' não contam).
 */
export function contaDaChavePostCare(key: string): string | null {
  if (!key.startsWith(POST_CARE_CONFIG_PREFIX)) return null;
  const id = key.slice(POST_CARE_CONFIG_PREFIX.length).trim();
  if (!id || id === 'undefined' || id === 'null') return null;
  return id;
}

/** Os 8 campos da configuração (o que a tela "Configurar" grava). */
export const POST_CARE_CONFIG_CAMPOS = [
  'enabled',
  'delay_hours',
  'initial_choice',
  'initial_custom',
  'thanks_text',
  'apology_text',
  'send_thanks_on_positive',
  'send_apology_on_negative',
] as const;
