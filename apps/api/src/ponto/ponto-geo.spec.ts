import { clientIp, coordsFromText, distanceMeters, evalGeo, isGoogleMapsUrl, MAX_PRECISAO_M } from './ponto-geo';

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

describe('link do Google Maps', () => {
  // Link real da clínica (Instituto Odonto Passos, Arapiraca) copiado do navegador.
  const PLACE =
    'https://www.google.com/maps/place/Instituto+Odonto+Passos/@-9.7483009,-36.6522659,17z/data=!4m10!1m2!2m1!1sInstituto+Odonto+Passos+Arapiraca!3m6!1s0x705d50037d4d6eb:0x823a10ffa81faf57!8m2!3d-9.7485335!4d-36.6519627!16s%2Fg%2F11vyx649nn';

  it('pega o PINO do lugar (!3d/!4d), não o centro da tela (@)', () => {
    expect(coordsFromText(PLACE)).toEqual({ lat: -9.7485335, lng: -36.6519627 });
  });

  it('centro da tela, ?q= e par solto também servem', () => {
    expect(coordsFromText('https://www.google.com/maps/@-9.7483,-36.6522,17z')).toEqual({ lat: -9.7483, lng: -36.6522 });
    expect(coordsFromText('https://maps.google.com/?q=-9.748534,-36.651963')).toEqual({ lat: -9.748534, lng: -36.651963 });
    expect(coordsFromText('-9.748534, -36.651963')).toEqual({ lat: -9.748534, lng: -36.651963 });
  });

  it('strict (redirecionamento) só aceita pino ou ponto explícito — nunca o centro da tela', () => {
    expect(coordsFromText(PLACE, { strict: true })).toEqual({ lat: -9.7485335, lng: -36.6519627 });
    expect(coordsFromText('https://www.google.com/maps?q=-9.748534,-36.651963', { strict: true })).toEqual({ lat: -9.748534, lng: -36.651963 });
    // a página do Google dessa mesma clínica trouxe o centro a 470 m do pino:
    expect(coordsFromText('https://www.google.com/maps/@-9.74848,-36.6477312,15z', { strict: true })).toBeNull();
    expect(coordsFromText('staticmap?center=-9.74848%2C-36.6477312', { strict: true })).toBeNull();
    expect(coordsFromText('preço 12.3456, 45.6789', { strict: true })).toBeNull();
  });

  it('só segue link do Google Maps', () => {
    expect(isGoogleMapsUrl('https://maps.app.goo.gl/AbCd1234')).toBe(true);
    expect(isGoogleMapsUrl('https://goo.gl/maps/AbCd')).toBe(true);
    expect(isGoogleMapsUrl(PLACE)).toBe(true);
    expect(isGoogleMapsUrl('https://www.google.com.br/maps/place/x')).toBe(true);
    expect(isGoogleMapsUrl('https://www.google.com/search?q=x')).toBe(false);
    expect(isGoogleMapsUrl('https://evil.com/maps')).toBe(false);
    expect(isGoogleMapsUrl('http://169.254.169.254/latest')).toBe(false);
    expect(isGoogleMapsUrl('file:///etc/passwd')).toBe(false);
  });
});

describe('IP (auditoria)', () => {
  it('cf-connecting-ip manda; X-Forwarded-For só sem Cloudflare', () => {
    expect(clientIp({ headers: { 'cf-connecting-ip': '200.1.2.3', 'x-forwarded-for': '6.6.6.6, 200.1.2.3' } })).toBe('200.1.2.3');
    expect(clientIp({ headers: { 'x-forwarded-for': '177.10.0.1, 10.0.0.2' } })).toBe('177.10.0.1');
    expect(clientIp({ headers: {}, ip: '::ffff:172.18.0.5' })).toBe('172.18.0.5');
  });
});
