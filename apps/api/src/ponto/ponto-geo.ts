/**
 * Relógio de ponto — localização da batida (puro; testado em ponto-geo.spec.ts).
 * Regra da clínica: o ponto SÓ vale com localização, dentro da área cadastrada.
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

/** NO_LOCAL = aceita. Os demais recusam a batida (MANUAL = lançada pelo adm). */
export type GeoStatus = 'NO_LOCAL' | 'FORA' | 'SEM_GPS' | 'IMPRECISO' | 'SEM_REF' | 'MANUAL';

/** Precisão mínima exigida do GPS (margem de erro informada pelo aparelho). */
export const MAX_PRECISAO_M = 150;

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
 * Situação da batida. Primeiro a PRECISÃO: leitura imprecisa (margem > 150 m ou sem
 * margem) é recusada — dentro ou fora, a distância dela não diz nada (computador
 * sem GPS chega com ±50 km e "a 3 km da clínica"). Com leitura boa, dentro =
 * distância até o ponto da clínica <= raio (sem folga).
 */
export function evalGeo(
  pos: PontoPos | null,
  local: PontoLocal | null,
): { status: GeoStatus; distance_m: number | null } {
  if (!local) return { status: 'SEM_REF', distance_m: null };
  if (!pos || !Number.isFinite(pos.latitude) || !Number.isFinite(pos.longitude)) {
    return { status: 'SEM_GPS', distance_m: null };
  }
  const distance = Math.round(distanceMeters(pos.latitude, pos.longitude, local.lat, local.lng));
  // Number(null) = 0 — sem margem informada NÃO pode passar como "precisão perfeita".
  const acc = pos.accuracy == null ? NaN : Number(pos.accuracy);
  if (!Number.isFinite(acc) || acc < 0 || acc > MAX_PRECISAO_M) return { status: 'IMPRECISO', distance_m: distance };
  if (distance > local.raio_m) return { status: 'FORA', distance_m: distance };
  return { status: 'NO_LOCAL', distance_m: distance };
}

/** "::ffff:1.2.3.4" → "1.2.3.4"; tira espaços. */
export function normalizeIp(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

/**
 * IP do aparelho (só registro/auditoria). Atrás do Cloudflare, só o
 * `cf-connecting-ip` é confiável (o 1º item do X-Forwarded-For pode ser forjado).
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

// ─── Link do Google Maps (local base da clínica) ─────────────────

/**
 * Coordenadas dentro de um texto/URL do Google Maps, na ordem de confiança:
 * "!3d<lat>!4d<lng>" (o PINO do lugar) > "q=/query=/ll=/destination=lat,lng" (ponto
 * explícito) > "@lat,lng" (só o CENTRO DA TELA) > par solto "lat, lng".
 * `strict` = só pino ou ponto explícito: é o que vale nos redirecionamentos de um
 * link curto. O centro da tela pode estar a centenas de metros do lugar — a página
 * do Google de uma clínica de Arapiraca trouxe o centro a 470 m do pino.
 */
export function coordsFromText(
  raw: string | null | undefined,
  opts: { strict?: boolean } = {},
): { lat: number; lng: number } | null {
  let s = String(raw ?? '');
  try {
    s = decodeURIComponent(s);
  } catch {
    /* texto com % solto: usa como veio */
  }
  s = s.replace(/%2C/gi, ',');
  const pats = [
    /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/,
    /[?&](?:q|query|ll|destination)=(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/,
  ];
  if (!opts.strict) {
    pats.push(/@(-?\d{1,2}\.\d{3,}),(-?\d{1,3}\.\d{3,})/);
    pats.push(/(-?\d{1,2}\.\d{4,})\s*,\s*(-?\d{1,3}\.\d{4,})/);
  }
  for (const re of pats) {
    const m = s.match(re);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }
  return null;
}

/**
 * Só segue link do Google Maps (o servidor faz a requisição — nada de buscar URL
 * qualquer que alguém cole). Aceita maps.app.goo.gl, goo.gl/maps e google.*\/maps.
 */
export function isGoogleMapsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const h = u.hostname.toLowerCase();
  if (h === 'maps.app.goo.gl') return true;
  if (h === 'goo.gl' && u.pathname.startsWith('/maps')) return true;
  if (h === 'maps.google.com' || /^maps\.google\.[a-z.]+$/.test(h)) return true;
  if ((h === 'google.com' || h === 'www.google.com' || /^(www\.)?google\.com?\.[a-z]{2}$/.test(h)) && u.pathname.startsWith('/maps')) {
    return true;
  }
  if (h === 'consent.google.com') return true; // tela de consentimento: a URL de destino vem no "continue"
  return false;
}
