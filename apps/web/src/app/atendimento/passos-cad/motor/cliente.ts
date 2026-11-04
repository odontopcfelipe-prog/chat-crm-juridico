/** Passos CAD — chamada ao worker como promessa. Um pedido por vez segue a ordem de chegada. */
import type { Pedido } from './worker';

type Pendente = { ok: (d: unknown) => void; falha: (e: Error) => void; relogio: ReturnType<typeof setTimeout> };

/** O navegador pode matar o worker sem avisar (falta de memória): sem isto, a tela ficaria travada. */
const TEMPO_MAXIMO = 5 * 60 * 1000;

export class ClienteDoMotor {
  private readonly worker: Worker;
  private seq = 0;
  private readonly pendentes = new Map<number, Pendente>();

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url));
    this.worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; dados?: unknown; erro?: string }>) => {
      const p = this.pendentes.get(ev.data.id);
      if (!p) return;
      this.pendentes.delete(ev.data.id);
      clearTimeout(p.relogio);
      if (ev.data.ok) p.ok(ev.data.dados);
      else p.falha(new Error(ev.data.erro || 'Erro no cálculo.'));
    };
    this.worker.onerror = () => this.falharTudo();
    this.worker.onmessageerror = () => this.falharTudo();
  }

  private falharTudo(): void {
    for (const p of this.pendentes.values()) {
      clearTimeout(p.relogio);
      p.falha(new Error('O cálculo parou. Recarregue a tela e tente de novo.'));
    }
    this.pendentes.clear();
  }

  pedir<T>(pedido: Pedido, envio: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((ok, falha) => {
      this.pendentes.set(id, { ok: (d) => ok(d as T), falha, relogio: setTimeout(() => this.falharTudo(), TEMPO_MAXIMO) });
      this.worker.postMessage({ id, pedido }, envio);
    });
  }

  encerrar(): void {
    this.worker.terminate();
    for (const p of this.pendentes.values()) clearTimeout(p.relogio);
    this.pendentes.clear();
  }
}
