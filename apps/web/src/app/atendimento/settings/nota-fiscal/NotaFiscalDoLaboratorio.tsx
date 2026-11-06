'use client';

/**
 * Configurações › Nota Fiscal (NFS-e), na conta de LABORATÓRIO.
 *
 * Mesma tela da clínica, mas lendo e gravando só a configuração DA CONTA do laboratório
 * (GET e PUT /nota-fiscal/config): sem CNAE, alíquota ou descrição de reserva. O
 * laboratório preenche o código do serviço (CNAE), a alíquota do ISS, o CNPJ e a
 * inscrição municipal; a descrição padrão é "Serviços de prótese dentária" e a emissão
 * automática começa desligada.
 */
import { useEffect, useState } from 'react';
import { FileText, Save, Loader2, Check, AlertTriangle, ExternalLink, ToggleLeft, ToggleRight } from 'lucide-react';
import api from '@/lib/api';
import { LAB_NFSE_TELA } from '../../pacientes/lab-contrato-textos';

const PROVEDORES = [
  { id: 'enotas', rotulo: 'eNotas', url: 'https://enotas.com.br' },
  { id: 'nfeio', rotulo: 'NFe.io', url: 'https://nfe.io' },
  { id: 'focusnfe', rotulo: 'FocusNFe', url: 'https://focusnfe.com.br' },
];

interface ConfigNfse {
  configured: boolean;
  provider: string | null;
  has_api_key: boolean;
  cnpj: string | null;
  inscricao_municipal: string | null;
  cnae_code: string | null;
  default_iss_rate: string | null;
  auto_emit: boolean;
  servico_descricao: string;
}

const campo = 'w-full px-4 py-2.5 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/40';

export default function NotaFiscalDoLaboratorio() {
  const T = LAB_NFSE_TELA;
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [salvo, setSalvo] = useState(false);
  const [status, setStatus] = useState<ConfigNfse | null>(null);

  const [provedor, setProvedor] = useState('enotas');
  const [chave, setChave] = useState('');
  const [cnpj, setCnpj] = useState('');
  const [inscricao, setInscricao] = useState('');
  const [cnae, setCnae] = useState('');
  const [aliquota, setAliquota] = useState('');
  const [descricao, setDescricao] = useState('');
  const [automatica, setAutomatica] = useState(false);

  const aplicar = (c: ConfigNfse) => {
    setStatus(c);
    if (c.provider) setProvedor(c.provider);
    setCnpj(c.cnpj || '');
    setInscricao(c.inscricao_municipal || '');
    setCnae(c.cnae_code || '');
    setAliquota(c.default_iss_rate || '');
    setDescricao(c.servico_descricao || '');
    setAutomatica(!!c.auto_emit);
  };

  useEffect(() => {
    api.get<ConfigNfse>('/nota-fiscal/config')
      .then((r) => aplicar(r.data))
      .catch(() => {})
      .finally(() => setCarregando(false));
  }, []);

  const salvar = async () => {
    setSalvando(true);
    try {
      const { data } = await api.put<ConfigNfse>('/nota-fiscal/config', {
        provider: provedor,
        api_key: chave.trim(),
        cnpj,
        inscricao_municipal: inscricao,
        cnae_code: cnae,
        default_iss_rate: aliquota,
        servico_descricao: descricao,
        auto_emit: automatica,
      });
      aplicar(data);
      setChave('');
      setSalvo(true);
      setTimeout(() => setSalvo(false), 3000);
    } catch (e: unknown) {
      const m = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
      alert((Array.isArray(m) ? m.join(', ') : m) || T.erroSalvar);
    } finally {
      setSalvando(false);
    }
  };

  if (carregando) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  const nomeDoProvedor = PROVEDORES.find((p) => p.id === provedor)?.rotulo || '';

  return (
    <div className="h-full overflow-y-auto flex-1 p-8 max-w-2xl mx-auto space-y-8">
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 rounded-2xl bg-violet-500/15 flex items-center justify-center">
          <FileText className="w-6 h-6 text-violet-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground">{T.titulo}</h1>
          <p className="text-sm text-muted-foreground">{T.subtitulo}</p>
        </div>
      </div>

      <div className="p-4 rounded-xl border border-amber-500/40 bg-amber-500/10 flex items-start gap-2">
        <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
        <p className="text-[13px] text-amber-800 dark:text-amber-300 leading-relaxed">{T.avisoSimulada}</p>
      </div>

      <div className={`p-4 rounded-xl border ${status?.configured ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
        <div className="flex items-center gap-2">
          {status?.configured ? <Check className="h-5 w-5 text-emerald-400" /> : <AlertTriangle className="h-5 w-5 text-amber-400" />}
          <span className="font-semibold text-sm">{status?.configured ? T.configurado : T.naoConfigurado}</span>
          {status?.auto_emit && <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-medium">{T.emissaoAutomaticaAtiva}</span>}
        </div>
      </div>

      <div className="space-y-5">
        <div>
          <label className="text-sm font-medium text-foreground block mb-1.5">{T.provedor}</label>
          <div className="grid grid-cols-3 gap-2">
            {PROVEDORES.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setProvedor(p.id)}
                className={`p-3 rounded-xl border text-center transition-all ${provedor === p.id ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent/30 text-muted-foreground'}`}
              >
                <p className="text-sm font-semibold">{p.rotulo}</p>
                <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary hover:underline inline-flex items-center gap-0.5 mt-0.5" onClick={(e) => e.stopPropagation()}>
                  {T.site} <ExternalLink className="h-2.5 w-2.5" />
                </a>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-sm font-medium text-foreground block mb-1.5">{T.chaveDo(nomeDoProvedor)}</label>
          <input
            type="password"
            data-rr-is-password
            value={chave}
            onChange={(e) => setChave(e.target.value)}
            placeholder={status?.has_api_key ? T.chaveJaConfigurada : T.chavePlaceholder}
            className={campo}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-medium text-foreground block mb-1.5">{T.cnpj}</label>
            <input type="text" value={cnpj} onChange={(e) => setCnpj(e.target.value)} placeholder={T.cnpjPlaceholder} className={campo} />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground block mb-1.5">{T.inscricaoMunicipal}</label>
            <input type="text" value={inscricao} onChange={(e) => setInscricao(e.target.value)} placeholder={T.inscricaoPlaceholder} className={campo} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-medium text-foreground block mb-1.5">{T.codigoServico}</label>
            <input type="text" value={cnae} onChange={(e) => setCnae(e.target.value)} placeholder={T.codigoServicoPlaceholder} className={campo} />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground block mb-1.5">{T.aliquota}</label>
            <input type="number" step="0.01" value={aliquota} onChange={(e) => setAliquota(e.target.value)} placeholder={T.aliquotaPlaceholder} className={campo} />
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground -mt-3">{T.codigoServicoDica}</p>

        <div>
          <label className="text-sm font-medium text-foreground block mb-1.5">{T.descricao}</label>
          <input type="text" value={descricao} onChange={(e) => setDescricao(e.target.value)} placeholder={T.descricaoPlaceholder} className={campo} />
        </div>

        <button
          type="button"
          onClick={() => setAutomatica(!automatica)}
          className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-border hover:bg-accent/30 transition-colors w-full"
        >
          {automatica ? <ToggleRight className="h-5 w-5 text-emerald-400" /> : <ToggleLeft className="h-5 w-5 text-muted-foreground" />}
          <div className="text-left">
            <p className="text-sm font-medium">{T.emissaoAutomatica}</p>
            <p className="text-xs text-muted-foreground">{automatica ? T.emissaoAutomaticaLigada : T.emissaoAutomaticaDesligada}</p>
          </div>
        </button>

        <button
          type="button"
          onClick={() => void salvar()}
          disabled={salvando}
          className="w-full py-3 text-sm font-semibold bg-primary text-primary-foreground rounded-xl hover:opacity-90 disabled:opacity-40 flex items-center justify-center gap-2 transition-all"
        >
          {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : salvo ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          {salvo ? T.salvo : T.salvar}
        </button>
      </div>
    </div>
  );
}
