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
