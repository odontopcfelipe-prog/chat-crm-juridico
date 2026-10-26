/**
 * Google Analytics (GA4) POR CLÍNICA, na GlobalSetting:
 *   GA4_PROPERTY_ID_<conta>          — o Property ID ("properties/<número>")
 *   GA4_SERVICE_ACCOUNT_B64_<conta>  — o JSON da service account em base64,
 *                                      guardado criptografado (tem a private_key)
 *
 * Leitura (lerGa4DaConta): a ORIGEM do par é decidida uma vez só, pelo Property
 * ID — o Property de uma origem nunca é usado com a credencial de outra:
 *  - a conta tem GA4_PROPERTY_ID_<conta> → o par da conta;
 *  - senão, clínica legada (criada antes do corte) → o par global antigo, como
 *    antes (e, no resumo, as variáveis de ambiente na falta dele);
 *  - senão (conta nova ou laboratório) → não configurado.
 * Sem conta no token: o par global, como antes.
 *
 * Escrita (gravarGa4): só ADMIN/SUPER_ADMIN; com conta no token, SEMPRE nas
 * chaves da conta (inclusive o SUPER_ADMIN logado numa clínica); SUPER_ADMIN sem
 * conta grava o par global; os demais recebem 403 PERMISSION_DENIED.
 *
 * Funções puras com o Prisma por parâmetro (sem provider Nest — ver CLAUDE.md:
 * ciclo de DI).
 */
import { BadRequestException } from '@nestjs/common';
import { chaveConfigDaConta, contaLegada, isLabTenant } from '@crm/shared';
import { negarPermissao } from '../auth/require-any-permission';
import { isAdminRole } from '../auth/patient-scope';
import { decryptValue, encryptValue } from '../common/utils/crypto.util';
import { chaveDeGravacaoDaClinica } from '../settings/config-da-clinica';

export const GA4_PROPERTY_KEY = 'GA4_PROPERTY_ID';
export const GA4_CREDENCIAL_KEY = 'GA4_SERVICE_ACCOUNT_B64';

/** 403 de quem não é administrador e tenta salvar o GA4. */
export const GA4_SO_ADMIN_MSG = 'Configurar o Google Analytics — somente o administrador da clínica.';

type PrismaGa4Leitura = Parameters<typeof contaLegada>[0] &
  Parameters<typeof isLabTenant>[0] & {
    globalSetting: {
      findUnique(args: { where: { key: string } }): Promise<{ value?: string | null } | null>;
    };
  };

type PrismaGa4Escrita = {
  globalSetting: {
    upsert(args: {
      where: { key: string };
      create: { key: string; value: string };
      update: { value: string };
    }): Promise<unknown>;
  };
};

type UsuarioDoToken = { roles?: unknown; tenant_id?: unknown } | null | undefined;

/**
 * - conta: o par gravado pela própria conta;
 * - herdada: o par global antigo (conta legada de clínica, ou sem conta);
 * - nenhuma: conta nova ou laboratório sem o par próprio.
 */
export type OrigemGa4 = 'conta' | 'herdada' | 'nenhuma';

export type Ga4Guardado = {
  origem: OrigemGa4;
  /** "properties/<número>" como está no banco, ou null. */
  propertyId: string | null;
  /** Como está no banco (criptografado ou, o global antigo, base64 puro), ou null. */
  credencialGuardada: string | null;
};

const NAO_CONFIGURADO: Ga4Guardado = { origem: 'nenhuma', propertyId: null, credencialGuardada: null };

/**
 * Par efetivo da conta, sem abrir a credencial. Erro do banco propaga (como a
 * leitura direta de antes); contaLegada e isLabTenant nunca rejeitam.
 */
export async function lerGa4DaConta(
  prisma: PrismaGa4Leitura,
  tenantId: string | null | undefined,
  avisar?: (msg: string) => void,
): Promise<Ga4Guardado> {
  const ler = async (key: string): Promise<string | null> => {
    const linha = await prisma.globalSetting.findUnique({ where: { key } });
    return typeof linha?.value === 'string' && linha.value !== '' ? linha.value : null;
  };
  const conta = typeof tenantId === 'string' && tenantId !== '' ? tenantId : null;
  if (conta) {
    const propertyDaConta = await ler(chaveConfigDaConta(GA4_PROPERTY_KEY, conta));
    if (propertyDaConta !== null) {
      return {
        origem: 'conta',
        propertyId: propertyDaConta,
        credencialGuardada: await ler(chaveConfigDaConta(GA4_CREDENCIAL_KEY, conta)),
      };
    }
    // Laboratório nunca herda o site de uma clínica; conta nova também não.
    if (await isLabTenant(prisma, conta, avisar)) return NAO_CONFIGURADO;
    if (!(await contaLegada(prisma, conta, avisar))) return NAO_CONFIGURADO;
  }
  return {
    origem: 'herdada',
    propertyId: await ler(GA4_PROPERTY_KEY),
    credencialGuardada: await ler(GA4_CREDENCIAL_KEY),
  };
}

/**
 * Credencial (base64 do JSON) pronta para uso. Aceita a criptografada e a antiga
 * em base64 puro; se não abrir, avisa e devolve null (o resumo fica vazio, como
 * quando não há configuração).
 */
export function abrirCredencialGa4(
  guardada: string | null,
  avisar: (msg: string) => void,
): string | null {
  if (!guardada) return null;
  try {
    return decryptValue(guardada);
  } catch (e) {
    try {
      avisar(`[ga4] credencial guardada não pôde ser aberta: ${(e as Error)?.message ?? e}`);
    } catch {
      // o aviso nunca derruba quem chamou
    }
    return null;
  }
}

/** Property ID e credencial validados como a tela manda (número ou "properties/<número>"; JSON). */
export function validarGa4(
  propertyId: unknown,
  serviceAccountJson: unknown,
): { propertyId: string; credencialB64: string } {
  const p = typeof propertyId === 'string' || typeof propertyId === 'number' ? String(propertyId).trim() : '';
  if (!p) throw new BadRequestException('Informe o Property ID.');
  if (typeof serviceAccountJson !== 'string' || !serviceAccountJson.trim()) {
    throw new BadRequestException('Cole o JSON da Service Account.');
  }
  try {
    JSON.parse(serviceAccountJson);
  } catch {
    throw new BadRequestException('JSON da Service Account inválido.');
  }
  return {
    propertyId: p.startsWith('properties/') ? p : `properties/${p}`,
    credencialB64: Buffer.from(serviceAccountJson).toString('base64'),
  };
}

/**
 * Salva o GA4 de quem está logado (ver o topo). A permissão é conferida ANTES de
 * validar e de gravar. A credencial é gravada antes do Property ID: é o Property
 * que decide a origem do par na leitura, então uma gravação interrompida não
 * mistura o Property de uma origem com a credencial de outra.
 */
export async function gravarGa4(
  prisma: PrismaGa4Escrita,
  user: UsuarioDoToken,
  propertyId: unknown,
  serviceAccountJson: unknown,
): Promise<void> {
  if (!isAdminRole(user?.roles)) throw negarPermissao(GA4_SO_ADMIN_MSG);
  const chaveCredencial = chaveDeGravacaoDaClinica(GA4_CREDENCIAL_KEY, user);
  const chaveProperty = chaveDeGravacaoDaClinica(GA4_PROPERTY_KEY, user);
  const v = validarGa4(propertyId, serviceAccountJson);
  const upsert = (key: string, value: string) =>
    prisma.globalSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  await upsert(chaveCredencial, encryptValue(v.credencialB64));
  await upsert(chaveProperty, v.propertyId);
}
