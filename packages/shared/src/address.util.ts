// Onda 17.57 — monta o endereco da clinica do tenant numa string pra mensagem.
//
// O endereco fica em campos separados no modelo Tenant (address, address_number,
// address_complement, neighborhood, city, state). Os disparos usam a variavel
// {local} / {local_line}; antes vinha so de event.location (digitado por evento).
// Agora cai pra ESTE endereco cadastrado quando o evento nao tem local proprio.
//
// Tolerante: campo vazio e ignorado; tudo vazio -> '' (a linha {local_line} some).
export interface TenantAddressParts {
  address?: string | null;
  address_number?: string | null;
  address_complement?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
  zip_code?: string | null;
}

export function formatTenantAddress(t: TenantAddressParts | null | undefined): string {
  if (!t) return '';
  const clean = (v: unknown) => (v == null ? '' : String(v).trim());
  const rua = clean(t.address);
  const numero = clean(t.address_number);
  const compl = clean(t.address_complement);
  const bairro = clean(t.neighborhood);
  const cidade = clean(t.city);
  const uf = clean(t.state);

  let street = rua;
  if (rua && numero) street = `${rua}, ${numero}`;
  else if (numero) street = numero;
  if (compl) street = street ? `${street} — ${compl}` : compl;

  const cidadeUf = cidade && uf ? `${cidade}/${uf}` : cidade || uf;
  const tail = [bairro, cidadeUf].filter(Boolean).join(', ');

  return [street, tail].filter(Boolean).join(', ').trim();
}
