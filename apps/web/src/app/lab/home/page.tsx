/**
 * Onda 17.32.118 — Lab da home por setor.
 *
 * Renderiza HomeBySector com os 5 setores lado a lado pra validacao
 * visual ANTES de plugar na home real do /atendimento/dashboard.
 * Reaproveita o SkyBackdrop ja em producao como slot do ceu.
 */
import HomeBySector from '@/components/home/HomeBySector';
import { SkyBackdrop } from '@/components/sky/SkyGreeting';
import { SECTORS, type Sector } from '@crm/shared';

export const metadata = {
  title: 'Lab — Home por setor',
  robots: { index: false, follow: false },
};

export default function LabHomePage() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 p-6">
      <header className="max-w-6xl mx-auto mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Lab — Home por setor
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Validacao isolada antes de plugar na home real.
          Sky reaproveitado do producao.
        </p>
      </header>

      <div className="max-w-6xl mx-auto space-y-12">
        {SECTORS.map((s) => (
          <section key={s.id}>
            <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3">
              {s.icon} {s.name} <span className="text-gray-400">({s.id})</span>
            </h2>
            <HomeBySector
              sector={s.id as Sector}
              userName="Fellipe"
              skySlot={<SkyBackdrop />}
            />
          </section>
        ))}
      </div>
    </div>
  );
}
