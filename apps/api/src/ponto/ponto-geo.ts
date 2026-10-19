/**
 * Relógio de ponto — localização da batida (puro; testado em ponto-geo.spec.ts).
 */

export interface PontoLocal {
  lat: number;
  lng: number;
  raio_m: number;
}

export interface PontoPos {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}

export type GeoStatus = 'NO_LOCAL' | 'FORA' | 'SEM_GPS' | 'SEM_REF' | 'REDE_CLINICA' | 'MANUAL';

/** Folga máxima dada pela imprecisão do GPS (o aparelho informa a margem em metros). */
const MAX_FOLGA_PRECISAO_M = 100;

/** Distância em metros entre dois pontos (haversine). */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Situação da batida: dentro do raio da clínica (com folga da precisão do GPS, até
 * 100 m), fora, sem GPS ou sem local configurado. Batida feita da rede da clínica
 * (IP cadastrado) conta como no local mesmo sem GPS — o computador da recepção
 * costuma não ter GPS e a localização por Wi-Fi/IP erra por quilômetros.
 */
export function evalGeo(
  pos: PontoPos | null,
  local: PontoLocal | null,
  ipConfiavel: boolean,
): { status: GeoStatus; distance_m: number | null } {
  let status: GeoStatus;
  let distance: number | null = null;
  if (pos) {
    if (local) {
      distance = Math.round(distanceMeters(pos.latitude, pos.longitude, local.lat, local.lng));
      const folga = Math.min(Math.max(Number(pos.accuracy) || 0, 0), MAX_FOLGA_PRECISAO_M);
      status = distance <= local.raio_m + folga ? 'NO_LOCAL' : 'FORA';
    } else {
      status = 'SEM_REF';
    }
  } else {
    status = 'SEM_GPS';
  }
  if (ipConfiavel && status !== 'NO_LOCAL') status = 'REDE_CLINICA';
  return { status, distance_m: distance };
}

/** "::ffff:1.2.3.4" → "1.2.3.4"; tira espaços. */
export function normalizeIp(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

/**
 * IP do aparelho. Atrás do Cloudflare, só o `cf-connecting-ip` é confiável (o
 * Cloudflare ANEXA ao X-Forwarded-For que o cliente mandar, então o 1º item dele
 * pode ser forjado). Sem Cloudflare, cai no X-Forwarded-For e depois no socket.
 */
export function clientIp(req: any): string | null {
  const h = req?.headers ?? {};
  const first = (v: unknown) => (Array.isArray(v) ? v[0] : v) as string | undefined;
  const cf = first(h['cf-connecting-ip']);
  if (cf) return normalizeIp(cf);
  const xff = first(h['x-forwarded-for']);
  if (xff) return normalizeIp(xff.split(',')[0]);
  return normalizeIp(req?.ip);
}

/**
 * IP público (dá pra confiar como "rede da clínica"). IP interno (docker, rede local,
 * loopback) NUNCA: se o proxy não repassar o IP real, todo mundo chegaria com o
 * mesmo IP interno e qualquer batida contaria como "na clínica".
 */
export function isPublicIp(ip: string | null | undefined): boolean {
  const s = normalizeIp(ip);
  if (!s) return false;
  const v4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([a, b, Number(v4[3]), Number(v4[4])].some((x) => x > 255)) return false;
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    return true;
  }
  if (!s.includes(':')) return false;
  const low = s.toLowerCase();
  if (low === '::1' || low === '::') return false;
  if (/^f[cd]/.test(low) || /^fe[89ab]/.test(low)) return false; // ULA / link-local
  return true;
}
