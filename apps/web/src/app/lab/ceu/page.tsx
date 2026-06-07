/**
 * Onda 17.32.108 — Rota de teste isolada do ceu dinamico.
 *
 * Valida sol/lua/estrelas/nuvens em horarios diferentes ANTES de
 * plugar no banner real do dashboard. Acesse em /lab/ceu.
 *
 * Como testar manhas/tardes/noites sem esperar:
 *  1. Mude a hora do sistema (Windows: Configuracoes > Hora e idioma)
 *  2. Ou desative essa pagina e instale uma var de teste no SkyGreeting
 *     pra forcar minute.
 *
 * Nao removendo essa rota: ela serve de regression test visual
 * pra quem mexer no motor sky.ts. Acessivel publicamente — nao
 * expoe dado nenhum.
 */
import { SkyGreeting, SkyBackdrop } from '@/components/sky/SkyGreeting';

export const metadata = {
  title: 'Lab — Céu dinâmico',
  robots: { index: false, follow: false },
};

export default function LabCeuPage() {
  return (
    <div className="min-h-screen bg-gray-100 p-8 space-y-8">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Lab — Céu dinâmico</h1>
        <p className="text-sm text-gray-600 mt-1">
          Validacao isolada antes de plugar no dashboard.
        </p>
      </header>

      {/* Modo 2 — banner completo */}
      <section>
        <h2 className="text-sm font-bold uppercase tracking-wider text-gray-500 mb-3">
          Modo 2: banner completo (`SkyGreeting`)
        </h2>
        <SkyGreeting name="Fellipe">
          <p style={{ marginTop: 12, fontSize: 14, opacity: 0.9 }}>
            Saudação completa renderizada pelo componente. Acompanha
            a hora real do navegador (atualiza a cada 30s).
          </p>
        </SkyGreeting>
      </section>

      {/* Modo 1 — so o backdrop */}
      <section>
        <h2 className="text-sm font-bold uppercase tracking-wider text-gray-500 mb-3">
          Modo 1: só o backdrop (`SkyBackdrop`) — recomendado
        </h2>
        <div
          style={{
            position: 'relative',
            minHeight: 200,
            borderRadius: 24,
            overflow: 'hidden',
            padding: '32px 28px',
          }}
        >
          <SkyBackdrop />
          <div style={{ position: 'relative', zIndex: 1, color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.3)' }}>
            <h3 style={{ fontSize: 32, fontWeight: 700, margin: 0 }}>Boa tarde, Fellipe 👋</h3>
            <p style={{ marginTop: 8, fontSize: 14, opacity: 0.95 }}>
              Sua saudação atual fica intacta — o céu só preenche o fundo.
            </p>
          </div>
        </div>
      </section>

      <footer className="text-xs text-gray-500 pt-8 border-t border-gray-200">
        Esta rota é só pra validação. Não indexada (robots: noindex).
      </footer>
    </div>
  );
}
