'use client';

/**
 * Busca inteligente de endereço — SÓ pro adm cadastrar o local base do ponto
 * (o colaborador nunca escolhe local: bate com o GPS do aparelho em tempo real).
 *
 * Sugestões enquanto digita pelo Photon (komoot): mapa aberto (OpenStreetMap),
 * feito pra "busca enquanto digita" — o Nominatim proíbe autocompletar, então ele
 * só entra como reserva num Enter sem sugestão. As sugestões puxam pra perto da
 * clínica (`bias`) e só do Brasil.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Building2, Loader2, MapPin, Route, Search } from 'lucide-react';

export type EnderecoHit = {
  lat: number;
  lng: number;
  /** street = a rua inteira (o ponto é o MEIO dela); place = endereço/estabelecimento. */
  kind: 'street' | 'place';
  title: string;
  subtitle: string;
};

type PhotonFeature = {
  geometry: { coordinates: [number, number] };
  properties: {
    name?: string;
    street?: string;
    housenumber?: string;
    district?: string;
    locality?: string;
    city?: string;
    state?: string;
    postcode?: string;
    countrycode?: string;
    type?: string;
    osm_key?: string;
  };
};

const PHOTON = 'https://photon.komoot.io/api/';

function toHit(f: PhotonFeature): EnderecoHit {
  const p = f.properties;
  const [lng, lat] = f.geometry.coordinates;
  const isStreet = p.type === 'street' || (p.osm_key === 'highway' && !p.housenumber);
  const rua = [p.street, p.housenumber].filter(Boolean).join(', ');
  const title = isStreet ? p.name || rua || 'Rua' : p.name && p.name !== p.street ? p.name : rua || p.name || 'Local';
  const cidade = [p.city || p.locality, p.state].filter(Boolean).join(' - ');
  const subtitle = [!isStreet && p.name && rua ? rua : null, p.district, cidade, p.postcode].filter(Boolean).join(' · ');
  return { lat, lng, kind: isStreet ? 'street' : 'place', title, subtitle };
}

/** Sugestões do Photon perto de `bias` (só Brasil). Lança em erro de rede. */
export async function suggestEnderecos(
  q: string,
  bias: { lat: number; lng: number } | null,
  signal?: AbortSignal,
): Promise<EnderecoHit[]> {
  const params = new URLSearchParams({ q, limit: '10' });
  if (bias) {
    params.set('lat', String(bias.lat));
    params.set('lon', String(bias.lng));
  }
  const res = await fetch(`${PHOTON}?${params}`, { signal });
  if (!res.ok) throw new Error(`photon ${res.status}`);
  const j = (await res.json()) as { features?: PhotonFeature[] };
  const seen = new Set<string>();
  const out: EnderecoHit[] = [];
  for (const f of j.features ?? []) {
    if (f.properties.countrycode && f.properties.countrycode !== 'BR') continue;
    const h = toHit(f);
    const key = `${h.title}|${h.subtitle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= 6) break;
  }
  return out;
}

/** Reserva: UMA busca no Nominatim (Enter sem sugestão). */
async function nominatimOnce(q: string): Promise<EnderecoHit[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=br&accept-language=pt-BR&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return [];
  const list = (await res.json()) as { lat: string; lon: string; display_name: string; class?: string }[];
  return list.map((r) => {
    const [first, ...rest] = r.display_name.split(', ');
    return {
      lat: Number(r.lat),
      lng: Number(r.lon),
      kind: r.class === 'highway' ? 'street' : 'place',
      title: first,
      subtitle: rest.slice(0, 4).join(' · '),
    } as EnderecoHit;
  });
}

export function EnderecoBusca({
  bias,
  onPick,
  inputCls,
}: {
  bias: { lat: number; lng: number } | null;
  onPick: (h: EnderecoHit) => void;
  inputCls: string;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<EnderecoHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [empty, setEmpty] = useState(false);
  const listId = useId();
  const ctrl = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const biasRef = useRef(bias);
  biasRef.current = bias;

  useEffect(() => () => {
    ctrl.current?.abort();
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const runSearch = (text: string) => {
    ctrl.current?.abort();
    const t = text.trim();
    if (t.length < 3) {
      setHits([]);
      setLoading(false);
      setEmpty(false);
      return;
    }
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    suggestEnderecos(t, biasRef.current, c.signal)
      .then((list) => {
        if (c.signal.aborted) return;
        setHits(list);
        setActive(0);
        setEmpty(list.length === 0);
        setOpen(true);
      })
      .catch(() => {
        if (!c.signal.aborted) {
          setHits([]);
          setEmpty(true);
        }
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
  };

  const onChange = (text: string) => {
    setQ(text);
    setOpen(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => runSearch(text), 350);
  };

  const pick = (h: EnderecoHit) => {
    setQ(h.subtitle ? `${h.title}, ${h.subtitle}` : h.title);
    setOpen(false);
    setHits([]);
    onPick(h);
  };

  const onEnter = async () => {
    if (hits[active]) return pick(hits[active]);
    if (hits[0]) return pick(hits[0]);
    const t = q.trim();
    if (t.length < 3) return;
    setLoading(true);
    try {
      const list = await nominatimOnce(t);
      if (list[0]) pick(list[0]);
      else setEmpty(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex-1 min-w-[240px]">
      <div className="relative">
        <Search className="w-4 h-4 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          value={q}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => hits.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, hits.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); void onEnter(); }
            else if (e.key === 'Escape') setOpen(false);
          }}
          placeholder="Digite o endereço da clínica (ex.: Rua Domingos Barbosa da Silva, 147)"
          role="combobox"
          aria-controls={listId}
          aria-expanded={open && hits.length > 0}
          aria-autocomplete="list"
          className={`w-full pl-8 pr-8 ${inputCls}`}
        />
        {loading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground absolute right-2.5 top-1/2 -translate-y-1/2" />}
      </div>
      {open && (hits.length > 0 || (empty && q.trim().length >= 3 && !loading)) && (
        <ul id={listId} role="listbox" className="absolute z-20 left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-lg overflow-hidden">
          {hits.map((h, i) => {
            const Icon = h.kind === 'street' ? Route : h.subtitle && h.title !== h.subtitle ? Building2 : MapPin;
            return (
              <li key={`${h.lat},${h.lng},${i}`} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(h)}
                  onMouseEnter={() => setActive(i)}
                  className={`w-full text-left px-3 py-2 flex items-start gap-2 ${i === active ? 'bg-primary/10' : 'hover:bg-foreground/[0.04]'}`}
                >
                  <Icon className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-foreground truncate">{h.title}</span>
                    {h.subtitle && <span className="block text-xs text-muted-foreground truncate">{h.subtitle}</span>}
                  </span>
                </button>
              </li>
            );
          })}
          {hits.length === 0 && (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              Nada encontrado. Tente só o nome da rua e a cidade — ou cole o link do Google Maps abaixo.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
