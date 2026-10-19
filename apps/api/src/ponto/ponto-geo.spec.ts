import { clientIp, distanceMeters, evalGeo, isPublicIp } from './ponto-geo';

// Maceió, perto da orla — 0,001° de latitude ≈ 111 m.
const CLINICA = { lat: -9.6658, lng: -35.7353, raio_m: 150 };

describe('distanceMeters', () => {
  it('0,001° de latitude ≈ 111 m', () => {
    const d = distanceMeters(CLINICA.lat, CLINICA.lng, CLINICA.lat + 0.001, CLINICA.lng);
    expect(Math.round(d)).toBe(111);
  });
});

describe('evalGeo', () => {
  it('dentro do raio = NO_LOCAL', () => {
    const r = evalGeo({ latitude: CLINICA.lat + 0.001, longitude: CLINICA.lng, accuracy: 10 }, CLINICA, false);
    expect(r).toEqual({ status: 'NO_LOCAL', distance_m: 111 });
  });

  it('fora do raio = FORA (a folga da precisão vai no máximo a 100 m)', () => {
    const longe = { latitude: CLINICA.lat + 0.003, longitude: CLINICA.lng }; // ~334 m
    expect(evalGeo({ ...longe, accuracy: 5000 }, CLINICA, false).status).toBe('FORA');
    // 200 m com precisão de 60 m → 150 + 60 = 210 cobre
    const perto = { latitude: CLINICA.lat + 0.0018, longitude: CLINICA.lng, accuracy: 60 };
    expect(evalGeo(perto, CLINICA, false).status).toBe('NO_LOCAL');
  });

  it('sem GPS = SEM_GPS; sem local configurado = SEM_REF', () => {
    expect(evalGeo(null, CLINICA, false)).toEqual({ status: 'SEM_GPS', distance_m: null });
    expect(evalGeo({ latitude: 1, longitude: 1 }, null, false).status).toBe('SEM_REF');
  });

  it('rede da clínica vale como no local, mas não esconde quem já está no local', () => {
    expect(evalGeo(null, CLINICA, true).status).toBe('REDE_CLINICA');
    const dentro = { latitude: CLINICA.lat, longitude: CLINICA.lng, accuracy: 5 };
    expect(evalGeo(dentro, CLINICA, true).status).toBe('NO_LOCAL');
  });
});

describe('IP', () => {
  it('cf-connecting-ip manda; X-Forwarded-For só sem Cloudflare', () => {
    expect(clientIp({ headers: { 'cf-connecting-ip': '200.1.2.3', 'x-forwarded-for': '6.6.6.6, 200.1.2.3' } })).toBe('200.1.2.3');
    expect(clientIp({ headers: { 'x-forwarded-for': '177.10.0.1, 10.0.0.2' } })).toBe('177.10.0.1');
    expect(clientIp({ headers: {}, ip: '::ffff:172.18.0.5' })).toBe('172.18.0.5');
  });

  it('IP interno nunca é "rede da clínica"', () => {
    for (const ip of ['10.0.0.5', '172.18.0.5', '192.168.3.38', '127.0.0.1', '::1', 'fd00::1', '100.64.1.1']) {
      expect(isPublicIp(ip)).toBe(false);
    }
    expect(isPublicIp('177.38.10.20')).toBe(true);
    expect(isPublicIp('2804:14c:1::1')).toBe(true);
  });
});
