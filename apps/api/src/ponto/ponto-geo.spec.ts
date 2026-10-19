import { clientIp, distanceMeters, evalGeo, MAX_PRECISAO_M } from './ponto-geo';

// Maceió — 0,001° de latitude ≈ 111 m.
const CLINICA = { lat: -9.6658, lng: -35.7353, raio_m: 150 };
const pos = (dLat: number, accuracy: number | null = 10) => ({ latitude: CLINICA.lat + dLat, longitude: CLINICA.lng, accuracy });

describe('distanceMeters', () => {
  it('0,001° de latitude ≈ 111 m', () => {
    expect(Math.round(distanceMeters(CLINICA.lat, CLINICA.lng, CLINICA.lat + 0.001, CLINICA.lng))).toBe(111);
  });
});

describe('evalGeo — só aceita com localização, dentro da área', () => {
  it('dentro do raio = NO_LOCAL', () => {
    expect(evalGeo(pos(0.001), CLINICA)).toEqual({ status: 'NO_LOCAL', distance_m: 111 });
  });

  it('fora do raio = FORA, sem folga pela precisão', () => {
    expect(evalGeo(pos(0.0014, 5), CLINICA)).toEqual({ status: 'FORA', distance_m: 156 });
  });

  it('computador sem GPS (±50 km) é IMPRECISO, não "fora a 3 km"', () => {
    expect(evalGeo(pos(0.029, 50000), CLINICA)).toEqual({ status: 'IMPRECISO', distance_m: 3225 });
  });

  it('leitura imprecisa é recusada mesmo dentro', () => {
    expect(evalGeo(pos(0, MAX_PRECISAO_M + 1), CLINICA).status).toBe('IMPRECISO');
    expect(evalGeo(pos(0, null), CLINICA).status).toBe('IMPRECISO');
    expect(evalGeo(pos(0, MAX_PRECISAO_M), CLINICA).status).toBe('NO_LOCAL');
  });

  it('sem GPS = SEM_GPS; clínica sem local = SEM_REF', () => {
    expect(evalGeo(null, CLINICA)).toEqual({ status: 'SEM_GPS', distance_m: null });
    expect(evalGeo(pos(0), null)).toEqual({ status: 'SEM_REF', distance_m: null });
  });
});

describe('IP (auditoria)', () => {
  it('cf-connecting-ip manda; X-Forwarded-For só sem Cloudflare', () => {
    expect(clientIp({ headers: { 'cf-connecting-ip': '200.1.2.3', 'x-forwarded-for': '6.6.6.6, 200.1.2.3' } })).toBe('200.1.2.3');
    expect(clientIp({ headers: { 'x-forwarded-for': '177.10.0.1, 10.0.0.2' } })).toBe('177.10.0.1');
    expect(clientIp({ headers: {}, ip: '::ffff:172.18.0.5' })).toBe('172.18.0.5');
  });
});
