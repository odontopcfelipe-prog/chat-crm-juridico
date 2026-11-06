/**
 * Limite de uso por conta, em memória: janela fixa que começa no primeiro uso. Quem
 * passa do máximo recebe 429 com a mensagem do limite. O processo reiniciado zera a
 * contagem. Sem provider Nest (ver CLAUDE.md: ciclo de DI); cada limite é uma instância.
 */
import { HttpException, HttpStatus } from '@nestjs/common';

export class LimitePorConta {
  private readonly janelas = new Map<string, { inicio: number; usos: number }>();

  constructor(
    private readonly maximo: number,
    private readonly janelaMs: number,
    private readonly mensagem: string,
  ) {}

  /** Registra um uso da conta. Acima do máximo, responde 429 e não conta. */
  consumir(conta: string, agora = Date.now()): void {
    const janela = this.janelas.get(conta);
    if (!janela || agora - janela.inicio >= this.janelaMs) {
      this.janelas.set(conta, { inicio: agora, usos: 1 });
      return;
    }
    if (janela.usos >= this.maximo) throw new HttpException(this.mensagem, HttpStatus.TOO_MANY_REQUESTS);
    janela.usos += 1;
  }

  /** Zera a contagem (usado nos testes). */
  limpar(): void {
    this.janelas.clear();
  }
}
