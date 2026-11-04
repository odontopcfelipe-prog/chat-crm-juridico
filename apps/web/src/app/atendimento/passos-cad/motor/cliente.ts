/** Passos CAD — chamada ao worker como promessa. Um pedido por vez segue a ordem de chegada. */
import type { Pedido } from './worker';

type Pendente = { ok: (d: unknown) => void; falha: (e: Error) => void };

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
      if (ev.data.ok) p.ok(ev.data.dados);
      else p.falha(new Error(ev.data.erro || 'Erro no cálculo.'));
    };
    this.worker.onerror = () => {
      for (const p of this.pendentes.values()) p.falha(new Error('O cálculo parou. Recarregue a tela e tente de novo.'));
      this.pendentes.clear();
    };
  }

  pedir<T>(pedido: Pedido, envio: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((ok, falha) => {
      this.pendentes.set(id, { ok: (d) => ok(d as T), falha });
      this.worker.postMessage({ id, pedido }, envio);
    });
  }

  encerrar(): void {
    this.worker.terminate();
    this.pendentes.clear();
  }
}
