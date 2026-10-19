/**
 * Relógio de ponto — localização no navegador.
 *
 * O GPS do celular não acerta de primeira: a 1ª leitura costuma vir da rede (Wi-Fi/
 * antena, ±100 m a ±5 km) e só depois de alguns segundos o GPS firma (±5 a ±30 m).
 * `getCurrentPosition` devolve justamente essa 1ª leitura ruim — por isso aqui a
 * leitura ESPERA a precisão melhorar (watchPosition) e fica com a melhor.
 * Computador de mesa não tem GPS: a localização vem do IP (±10 a ±50 km) e nunca
 * serve pro ponto.
 */

export type GeoReading = { latitude: number; longitude: number; accuracy: number; ts: number };
export type GeoFail = { error: 'denied' | 'timeout' | 'unsupported' };

/** Acima disso a leitura é de IP/antena: o aparelho está sem GPS (ou com a localização precisa desligada). */
export const SEM_GPS_M = 1000;

export function isFail(r: GeoReading | GeoFail): r is GeoFail {
  return 'error' in r;
}

/**
 * Lê a localização esperando o GPS firmar: termina quando a precisão chega a
 * `targetM` ou em `maxWaitMs`, devolvendo a MELHOR leitura vista. `onProgress`
 * recebe a melhor leitura a cada atualização (pra mostrar "±80 m…").
 */
export function getBestPosition(opts: {
  targetM: number;
  maxWaitMs: number;
  onProgress?: (best: GeoReading) => void;
}): Promise<GeoReading | GeoFail> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve({ error: 'unsupported' });
  return new Promise((resolve) => {
    let best: GeoReading | null = null;
    let done = false;
    let watchId = -1;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (v: GeoReading | GeoFail) => {
      if (done) return;
      done = true;
      if (watchId !== -1) navigator.geolocation.clearWatch(watchId);
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        const r: GeoReading = { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy, ts: Date.now() };
        if (!best || r.accuracy <= best.accuracy) best = r;
        opts.onProgress?.(best);
        if (best.accuracy <= opts.targetM) finish(best);
      },
      (e) => {
        // Sem permissão não adianta esperar; os outros erros (sem sinal ainda) esperam o prazo.
        if (e.code === 1) finish({ error: 'denied' });
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: opts.maxWaitMs },
    );
    timer = setTimeout(() => finish(best ?? { error: 'timeout' }), opts.maxWaitMs);
    // Aparelho sem GPS (leitura de IP/antena) não melhora esperando: desiste cedo.
    setTimeout(() => {
      if (best && best.accuracy > SEM_GPS_M) finish(best);
    }, Math.min(8000, opts.maxWaitMs));
  });
}

/** Texto curto sobre a precisão da leitura. */
export function precisionHint(accuracy: number, maxM: number): { ok: boolean; text: string } {
  const m = fmtM(accuracy);
  if (accuracy <= maxM) return { ok: true, text: `GPS ok (± ${m})` };
  if (accuracy > SEM_GPS_M) {
    return {
      ok: false,
      text: `Este aparelho está sem GPS (localização aproximada, ± ${m}). Bata o ponto pelo celular, com a localização precisa ligada.`,
    };
  }
  return { ok: false, text: `Sinal de GPS fraco (± ${m}). Aguarde alguns segundos, de preferência perto de uma janela.` };
}

export const fmtM = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m)} m`);

/**
 * Coordenadas coladas: "-9.6658, -35.7353" ou um link do Google Maps
 * (".../place/...!3d-9.6658!4d-35.7353" = o pino; "@-9.6658,-35.7353,17z" = o centro
 * da tela; "?q=-9.6658,-35.7353"). Link curto (maps.app.goo.gl) não dá pra ler.
 */
export function parseCoords(text: string): { lat: number; lng: number } | null {
  const s = String(text || '').trim();
  if (!s) return null;
  const pin = s.match(/!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/);
  const pair = s.match(/(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/);
  const m = pin ?? pair;
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}
